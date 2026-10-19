/**
 * Cloud Functions: ตะวันฟาร์ม LINE Bot
 * - lineWebhook  : คำสั่ง "สวัสดีตะวัน ตั้งกลุ่มแจ้งเตือน" เท่านั้น — ถามตอบถอดแล้ว 19 ต.ค. 69 (#437 · ใช้ตะวัน AI ในแอปแทน)
 * - billNotify   : แจ้งเตือนบิลรับของเข้ากลุ่มไลน์ (staff ส่งบิล / ตีกลับ / อนุมัติเข้าสต็อก)
 * - nightlyBackup: สำรองข้อมูลแอปทุกคืน 03:00 → /tawan_backups (#423)
 * - aiChat       : ผู้ช่วย AI ในแอป (admin) — ดู ai.js (#430)
 *
 * Secrets (LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN, LINE_GROUP_ID) อ่านจาก
 * functions/.env เท่านั้น — ผู้ใช้ต้องกรอกค่าจริงเอง ห้ามฮาร์ดโค้ดในไฟล์นี้
 */

const {onRequest} = require("firebase-functions/v2/https");
const {onValueCreated} = require("firebase-functions/v2/database");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {billEventText, stockEmptyText} = require("./billNotify");
const {backupRecord, pruneKeys} = require("./backup");
const {handleAiChat} = require("./ai");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const crypto = require("crypto");
const zlib = require("zlib");

admin.initializeApp();

const RTDB_PATH = "tawan_app";

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_GROUP_ID = process.env.LINE_GROUP_ID;

// ---------------------------------------------------------------------------
// Helpers ที่พอร์ตมาจาก index.html (อย่าแก้ threshold เองถ้าไม่แน่ใจ ให้ถามเจ้าของแอปก่อน)
// ---------------------------------------------------------------------------

function today() {
  return new Date(Date.now() + 7 * 3600000).toISOString().split("T")[0];
}

// ---------------------------------------------------------------------------
// RTDB access — ข้อมูลทั้งหมดเก็บเป็น JSON string ตัวเดียว
// ตั้งแต่ #422 แอปเก็บเฉพาะ tawan_app/z = {u, d: gzip base64} (json เต็มเลิกเขียน — เพดาน 10 MB ต่อสตริง)
// อ่าน z ก่อน (ต้อง z.u === updated) · ไม่มี/แตกไม่ได้ ค่อยใช้ json (ข้อมูลรูปแบบเก่า)
// ---------------------------------------------------------------------------

async function readAppJson() {
  const snap = await admin.database().ref(RTDB_PATH).get();
  const v = snap.val() || {};
  if (v.z && v.z.d && (!v.updated || v.z.u === v.updated)) {
    try {
      return zlib.gunzipSync(Buffer.from(v.z.d, "base64")).toString("utf8");
    } catch (e) {
      logger.error("z decode failed", e);
    }
  }
  return v.json || null;
}

// ---------------------------------------------------------------------------
// LINE Messaging API helpers
// ---------------------------------------------------------------------------

async function lineApi(path, body) {
  const r = await fetch(`https://api.line.me/v2/bot/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    logger.error("LINE API error", r.status, t);
  }
  return r.ok;
}

function verifySignature(rawBody, signature) {
  if (!LINE_CHANNEL_SECRET || !signature) return false;
  const hash = crypto.createHmac("sha256", LINE_CHANNEL_SECRET).update(rawBody).digest("base64");
  return hash === signature;
}

// ---------------------------------------------------------------------------
// คำเรียกบอท — ในกลุ่มต้องขึ้นต้นด้วย "สวัสดีตะวัน" ก่อนถึงจะตอบ
// (กันบอทตอบทุกข้อความที่คนในกลุ่มคุยกัน) แชทเดี่ยว (1:1) ตอบได้ตามปกติ
// ---------------------------------------------------------------------------

const TAWAN_TRIGGER = "สวัสดีตะวัน";

function parseTrigger(text) {
  const t = (text || "").trim();
  if (t.startsWith(TAWAN_TRIGGER)) {
    return {triggered: true, query: t.slice(TAWAN_TRIGGER.length).trim()};
  }
  return {triggered: false, query: t};
}

// ---------------------------------------------------------------------------
// กลุ่มที่รับแจ้งเตือน (entry #285)
// เก็บใน RTDB /tawan_line_config แทน LINE_GROUP_ID ใน .env — เปลี่ยนกลุ่มได้โดยไม่ต้อง deploy ใหม่
// ⚠️ ตั้งได้ด้วยคำสั่ง "สวัสดีตะวัน ตั้งกลุ่มแจ้งเตือน" ที่พิมพ์ในกลุ่มเท่านั้น
//    ห้ามตั้งอัตโนมัติตอนบอทถูกเชิญ — ใครเชิญบอทเข้ากลุ่มอื่นจะดึงแจ้งเตือนบิลของฟาร์มไปได้ทันที
// ⚠️ node นี้ไม่มีสิทธิ์ให้แอปฝั่งหน้าเว็บอ่าน/เขียน (ไม่ได้อยู่ใน firebase_rules.json) — เข้าถึงผ่าน admin เท่านั้น
// ---------------------------------------------------------------------------
const LINE_CFG_PATH = "tawan_line_config";

async function getNotifyGroupId() {
  try {
    const snap = await admin.database().ref(`${LINE_CFG_PATH}/groupId`).get();
    if (snap.val()) return snap.val();
  } catch (e) {
    logger.error("read notify group failed", e);
  }
  return LINE_GROUP_ID;   // ค่าเดิมจาก .env ใช้สำรองเมื่อยังไม่เคยตั้งกลุ่ม
}

async function lineGroupName(groupId) {
  try {
    const r = await fetch(`https://api.line.me/v2/bot/group/${groupId}/summary`, {
      headers: {"Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`},
    });
    if (r.ok) return (await r.json()).groupName || "";
  } catch (e) {
    logger.error("group summary failed", e);
  }
  return "";
}

async function setNotifyGroup(groupId, byUserId) {
  const groupName = await lineGroupName(groupId);
  await admin.database().ref(LINE_CFG_PATH).set({
    groupId, groupName, setAt: Date.now(), setByLineUser: byUserId || "",
  });
  logger.info("notify group set", groupName);
  return groupName;
}

function isSetGroupCommand(query) {
  return /ตั้งกลุ่ม/.test(String(query || ""));
}

// ---------------------------------------------------------------------------
// HTTPS webhook — LINE ส่ง event เข้ามาที่นี่
// ---------------------------------------------------------------------------

exports.lineWebhook = onRequest({region: "asia-southeast1"}, async (req, res) => {
  const signature = req.headers["x-line-signature"];
  const rawBody = req.rawBody;

  if (!verifySignature(rawBody, signature)) {
    logger.warn("Invalid LINE signature");
    res.status(403).send("invalid signature");
    return;
  }

  const events = (req.body && req.body.events) || [];
  for (const event of events) {
    try {
      // ถูกเชิญเข้ากลุ่ม: บอกวิธีตั้งกลุ่มแจ้งเตือน (ไม่ตั้งให้เอง — ดูเหตุผลที่ setNotifyGroup)
      if (event.type === "join" && event.replyToken) {
        await lineApi("message/reply", {
          replyToken: event.replyToken,
          messages: [{type: "text", text:
            "สวัสดีครับ 🦐 ถ้าต้องการให้กลุ่มนี้รับแจ้งเตือนบิลรับของ พิมพ์\n" +
            "สวัสดีตะวัน ตั้งกลุ่มแจ้งเตือน"}],
        });
        continue;
      }
      if (event.type === "message" && event.message && event.message.type === "text") {
        const srcType = (event.source && event.source.type) || "user";
        const parsed = parseTrigger(event.message.text);

        if (parsed.triggered && isSetGroupCommand(parsed.query)) {
          let msg;
          if (srcType === "group" && event.source.groupId) {
            const name = await setNotifyGroup(event.source.groupId, event.source.userId);
            msg = `✅ ตั้งกลุ่ม "${name || "นี้"}" เป็นกลุ่มรับแจ้งเตือนบิลรับของแล้ว\n` +
              "บิลที่ staff ส่ง / ตีกลับ / อนุมัติ จะเด้งเข้ากลุ่มนี้";
          } else {
            msg = "คำสั่งนี้ต้องพิมพ์ในกลุ่มที่ต้องการรับแจ้งเตือนครับ";
          }
          await lineApi("message/reply", {
            replyToken: event.replyToken,
            messages: [{type: "text", text: msg}],
          });
          continue;
        }

        // บอทถามตอบถูกถอดแล้ว (พี่สั่ง 19 ต.ค. 69 · บอทใช้แจ้งบิลอย่างเดียว) — ถามข้อมูลฟาร์มใช้ตะวัน AI ในแอป
        //   ในกลุ่ม: ตอบเฉพาะข้อความที่ขึ้นต้นด้วย "สวัสดีตะวัน" · แชตส่วนตัว: ตอบทุกข้อความ (reply ไม่กินโควตา)
        if ((srcType === "group" || srcType === "room") && !parsed.triggered) continue;
        await lineApi("message/reply", {
          replyToken: event.replyToken,
          messages: [{type: "text", text: "บอทนี้ใช้แจ้งเตือนบิลรับของอย่างเดียวครับ 🦐\nถามข้อมูลฟาร์ม ใช้ 🌞 ตะวัน AI ในแอป"}],
        });
      }
    } catch (e) {
      logger.error("event handling error", e);
    }
  }

  res.status(200).send("OK");
});

// ---------------------------------------------------------------------------
// Cloud Scheduler — สรุปทุกเช้า 10:00 เวลาไทย ส่งเข้ากลุ่มพนักงาน (ตกลงเลื่อนเป็น 10:00 เมื่อ 20 มิ.ย. 2026)
// ---------------------------------------------------------------------------

// ── สรุปทุกเช้า 10:00 ถูกยกเลิกแล้ว (พี่สั่ง entry #284) ──
// เดิม exports.dailySummary ส่งสรุปงาน/อากาศ/สถานะบ่อ เข้ากลุ่มไลน์ทุกวัน
// เปลี่ยนเป็นส่งเฉพาะแจ้งเตือนบิลรับของแทน (ดูข้างล่าง) เพื่อลดข้อความและประหยัดโควตา LINE
// ฟังก์ชันช่วยคำนวณของสรุปเช้า/ถามตอบ ถอดออกแล้ว 19 ต.ค. 69 (บอทแจ้งบิลอย่างเดียว) — ดูโค้ดเดิมใน git ก่อน #437
// ถ้าจะเอาสรุปเช้ากลับมา: กู้โค้ดจาก git (commit ก่อน entry #284) แล้ว deploy ใหม่
// ---------------------------------------------------------------------------
// แจ้งเตือนบิลรับของเข้ากลุ่มไลน์ (entry #284)
// แอปเขียน /tawan_events/<id> = {type, billId, actorUid, at} — ไม่มีข้อความมาด้วย
// ฟังก์ชันนี้อ่านบิลจริงจาก tawan_app แล้วประกอบข้อความเอง (ดูเหตุผลใน billNotify.js)
// ---------------------------------------------------------------------------
async function loadAppData() {
  const json = await readAppJson();
  return json ? JSON.parse(json) : null;
}
async function loadBill(billId) {
  const data = await loadAppData();
  if (!data) return null;
  const bills = Array.isArray(data.stockBills) ? data.stockBills : [];
  return bills.find((b) => b && b.id === billId) || null;
}

exports.billNotify = onValueCreated(
    {ref: "/tawan_events/{eventId}", region: "asia-southeast1"},
    async (event) => {
      const ev = event.data.val() || {};
      if (ev.sentAt || ev.skippedAt) return;           // กันส่งซ้ำตอน retry
      const groupId = await getNotifyGroupId();
      if (!groupId) {
        logger.error("ยังไม่ได้ตั้งกลุ่มแจ้งเตือน — พิมพ์ \"สวัสดีตะวัน ตั้งกลุ่มแจ้งเตือน\" ในกลุ่ม");
        return;
      }
      // ฟาร์มหมด (entry #336) — เหตุการณ์ชนิดนี้มี itemId แทน billId
      if (ev.type === "stock_empty" && ev.itemId) {
        // รอให้ save() ของแอปถึงเซิร์ฟเวอร์ — ยอดยังไม่เป็น 0 ก็ลองใหม่
        let text = null;
        for (let i = 0; i < 3 && !text; i++) {
          if (i) await new Promise((r) => setTimeout(r, 4000));
          const data = await loadAppData();
          text = data ? stockEmptyText(data, ev.itemId) : null;
        }
        if (!text) {
          await event.data.ref.update({skippedAt: Date.now(), why: "not empty / not found"});
          return;
        }
        const ok = await lineApi("message/push", {to: groupId, messages: [{type: "text", text}]});
        await event.data.ref.update(ok ? {sentAt: Date.now()} : {failedAt: Date.now()});
        logger.info("stock_empty", ev.itemId, ok ? "sent" : "failed");
        return;
      }
      if (!ev.type || !ev.billId) {
        await event.data.ref.update({skippedAt: Date.now(), why: "bad event"});
        return;
      }
      // แอปเรียก save() แล้วค่อยเขียนเหตุการณ์ แต่ข้อมูลอาจยังมาไม่ถึงเซิร์ฟเวอร์ — รอแล้วลองใหม่
      let bill = null;
      for (let i = 0; i < 3 && !bill; i++) {
        if (i) await new Promise((r) => setTimeout(r, 4000));
        bill = await loadBill(ev.billId);
      }
      const text = billEventText(ev.type, bill);
      if (!text) {
        // สถานะเปลี่ยนไปแล้ว (เช่นอนุมัติก่อนที่แจ้งเตือนจะออก) — ไม่ต้องส่ง
        await event.data.ref.update({skippedAt: Date.now(), why: bill ? "state changed" : "bill not found"});
        logger.info("bill event skipped", ev.type, ev.billId);
        return;
      }
      const ok = await lineApi("message/push", {
        to: groupId,
        messages: [{type: "text", text}],
      });
      await event.data.ref.update(ok ? {sentAt: Date.now()} : {failedAt: Date.now()});
      logger.info("bill event", ev.type, ev.billId, ok ? "sent" : "failed");
    },
);

// ---------------------------------------------------------------------------
// สำรองข้อมูลทุกคืน 03:00 (#423) — ดู backup.js · รายวัน 90 วัน + วันที่ 1 ของทุกเดือนเก็บตลอด
// สำเนารายเดือนนอก Firebase = Google Apps Script ในบัญชีพี่ (โค้ดอยู่ ../backup_drive/)
// ---------------------------------------------------------------------------

exports.nightlyBackup = onSchedule(
    {schedule: "0 3 * * *", timeZone: "Asia/Bangkok", region: "asia-southeast1"},
    async () => {
      const json = await readAppJson();
      if (!json) {
        logger.error("backup: อ่าน tawan_app ไม่ได้ — ไม่ได้สำรองคืนนี้");
        return;
      }
      const updated = (await admin.database().ref(`${RTDB_PATH}/updated`).get()).val();
      const day = today();
      const rec = backupRecord(json, updated);
      await admin.database().ref(`tawan_backups/${day}`).set(rec);
      const del = {};
      pruneKeys(day).forEach((k) => {
        del[k] = null;
      });
      await admin.database().ref("tawan_backups").update(del);
      logger.info("backup ok", day, "ponds", rec.ponds, "z", rec.z.length);
    },
);

// ---------------------------------------------------------------------------
// ผู้ช่วย AI ในแอป (#430) — admin เท่านั้น · เครื่องมือรันในหน้าเว็บ · งบ ฿500/เดือน (ai.js)
// ---------------------------------------------------------------------------

exports.aiChat = onRequest(
    {region: "asia-southeast1", timeoutSeconds: 300, memory: "512MiB",
      cors: ["https://gamekroekphon.github.io", /^http:\/\/localhost(:\d+)?$/]},
    (req, res) => handleAiChat(req, res, {admin, logger}).catch((e) => {
      logger.error("aiChat", e);
      if (!res.headersSent) res.status(500).json({error: "ระบบผิดพลาด"});
      else res.end();
    }),
);
