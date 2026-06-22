/**
 * Cloud Functions: ตะวันฟาร์ม LINE Bot
 * - lineWebhook  : ตอบคำถามพนักงานผ่าน LINE (อ่านข้อมูลจริงจาก Firebase RTDB)
 * - dailySummary : ส่งสรุปงานวันนี้ + อากาศ + สถานะบ่อ เข้ากลุ่มไลน์ทุกวัน 10:00 (Asia/Bangkok)
 *
 * ตรรกะการคำนวณสถานะบ่อ/วันเตรียมบ่อ/ความเสี่ยงอากาศ ถูก "พอร์ต" มาจาก index.html
 * ของแอปจริง (classifyOv, worstOv, pondStatusOv, PREP_STEPS, renderWx) ไม่ใช่ค่าที่เดาขึ้นมาเอง
 *
 * Secrets (LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN, LINE_GROUP_ID) อ่านจาก
 * functions/.env เท่านั้น — ผู้ใช้ต้องกรอกค่าจริงเอง ห้ามฮาร์ดโค้ดในไฟล์นี้
 */

const {onRequest} = require("firebase-functions/v2/https");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();

const RTDB_PATH = "tawan_app";
const LAT = 9.97;
const LON = 99.08;

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_GROUP_ID = process.env.LINE_GROUP_ID;

// ---------------------------------------------------------------------------
// Helpers ที่พอร์ตมาจาก index.html (อย่าแก้ threshold เองถ้าไม่แน่ใจ ให้ถามเจ้าของแอปก่อน)
// ---------------------------------------------------------------------------

function today() {
  return new Date(Date.now() + 7 * 3600000).toISOString().split("T")[0];
}

function dDiff(a, b) {
  return Math.floor((new Date(b) - new Date(a)) / 86400000);
}

function addDays(dateStr, days) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function classifyOv(key, v) {
  if (v === null || v === undefined || v === "") return "na";
  switch (key) {
    case "nh4":
      return v > 0.5 ? "danger" : v >= 0.25 ? "warn" : "ok";
    case "no2":
      return v > 4 ? "danger" : v >= 1 ? "warn" : "ok";
    case "phM":
      if (v < 7.5 || v > 8.6) return "danger";
      if (v < 7.8 || v > 8.3) return "warn";
      return "ok";
    case "phSwing":
      return v > 0.5 ? "danger" : v >= 0.3 ? "warn" : "ok";
    case "doM":
    case "doA":
      return v < 3 ? "danger" : v < 4 ? "warn" : "ok";
    case "tM":
    case "tA":
      if (v > 33 || v < 26) return "danger";
      if (v > 32 || v < 28) return "warn";
      return "ok";
    case "alk":
      if (v < 80 || v > 250) return "danger";
      if (v < 100 || v > 200) return "warn";
      return "ok";
    case "sal":
      return v > 35 ? "danger" : v > 30 ? "warn" : "ok";
    case "tcbsGreen":
      return v > 1000 ? "danger" : v > 100 ? "warn" : "ok";
    case "tcbsYellow":
      return v > 1000 ? "warn" : "ok";
    case "tvc":
      return v > 1e7 ? "danger" : v >= 1e5 ? "warn" : "ok";
    case "ehp":
      return v > 5 ? "danger" : v > 0 ? "warn" : "ok";
    case "ehpLarva":
      return v > 25 ? "danger" : v > 0 ? "warn" : "ok";
    case "hepato":
      return v === "normal" ? "ok" : v === "swollen" ? "warn" : v ? "danger" : "ok";
    default:
      return "ok";
  }
}

function worstOv(a, b) {
  const o = {ok: 0, warn: 1, danger: 2, na: 0};
  return (o[b] || 0) > (o[a] || 0) ? b : a;
}

function pondStatusOv(p) {
  const records = p.records || [];
  const last = records[records.length - 1];
  const age = p.startDate ? dDiff(p.startDate, today()) : last ? last.age : 0;
  if (age <= 0) return "prep";

  let level = "ok";
  if (last) {
    [
      ["nh4", last.nh4], ["no2", last.no2], ["phM", last.phM],
      ["doM", last.doM], ["doA", last.doA], ["alk", last.alk],
      ["sal", last.sal], ["tM", last.tM], ["tA", last.tA],
    ].forEach(([k, v]) => {
      if (v === null || v === undefined || v === "") return;
      level = worstOv(level, classifyOv(k, v));
    });
    if (last.phM != null && last.phA != null && last.phM !== "" && last.phA !== "") {
      level = worstOv(level, classifyOv("phSwing", Math.abs(last.phM - last.phA)));
    }
  }

  const lab = (p.labResults || []).slice(-1)[0];
  if (lab) {
    [
      ["tcbsGreen", lab.tcbsGreen], ["tcbsYellow", lab.tcbsYellow],
      ["tvc", lab.tvc], ["ehp", lab.ehp], ["ehpLarva", lab.ehpLarva],
      ["hepato", lab.hepato],
    ].forEach(([k, v]) => {
      if (v === null || v === undefined || v === "") return;
      level = worstOv(level, classifyOv(k, v));
    });
  }

  if (age > 120) level = worstOv(level, "danger");
  else if (age >= 110) level = worstOv(level, "warn");

  return level;
}

const PREP_STEPS = [
  {key: "drain", label: "ตากบ่อ", daysBeforeStock: -60},
  {key: "fill", label: "เข้าน้ำ", daysBeforeStock: -30},
  {key: "soda", label: "โซดาไฟ", daysBeforeStock: -28},
  {key: "copper", label: "คอปเปอร์ซัลเฟต", daysBeforeStock: -25},
  {key: "dichlo", label: "ไดโครวอส", daysBeforeStock: -21},
  {key: "chain", label: "ลากโซ่", daysBeforeStock: -14},
  {key: "chlorine", label: "คลอรีน", daysBeforeStock: -4},
  {key: "bacillus", label: "บาซิลัส", daysBeforeStock: -3},
  {key: "blue", label: "สีน้ำเงิน", daysBeforeStock: -2},
  {key: "micro", label: "จุลินทรีย์", daysBeforeStock: 0},
];

// ---------------------------------------------------------------------------
// RTDB access — ข้อมูลทั้งหมดเก็บเป็น JSON string ตัวเดียวที่ tawan_app/json
// ---------------------------------------------------------------------------

async function loadPonds() {
  const snap = await admin.database().ref(`${RTDB_PATH}/json`).get();
  const json = snap.val();
  if (!json) return [];
  const data = JSON.parse(json);
  return data.ponds || [];
}

function todaysTasks(ponds) {
  const t = today();
  const tasks = [];
  ponds.forEach((p) => {
    const cl = p.prepChecklist;
    if (!cl) return;
    const stockDate = cl.stockDate || p.startDate || "";
    if (!stockDate) return;
    PREP_STEPS.forEach((s) => {
      const step = (cl.steps && cl.steps[s.key]) || {done: false};
      if (step.done) return;
      const targetDate = addDays(stockDate, s.daysBeforeStock);
      if (targetDate === t) tasks.push(`บ่อ ${p.name}: ${s.label}`);
    });
  });
  return tasks;
}

function statusCounts(ponds) {
  const counts = {ok: 0, warn: 0, danger: 0, prep: 0};
  ponds.forEach((p) => {
    const s = pondStatusOv(p);
    counts[s] = (counts[s] || 0) + 1;
  });
  return counts;
}

// ---------------------------------------------------------------------------
// อาหาร + ค่าน้ำรายบ่อ (พอร์ตสูตรจากแอป: feedPer100k = totalFeed / stock * 100000)
// ---------------------------------------------------------------------------

function feedPer100k(totalFeed, stock) {
  if (!totalFeed || !stock || stock <= 0) return null;
  return totalFeed / stock * 100000;
}

function latestFeed(p) {
  const fl = p.feedLog || [];
  return fl.length ? fl[fl.length - 1] : null;
}

// บ่อที่ "เลี้ยงอยู่" = สถานะไม่ใช่ prep (เตรียมบ่อ)
function activePonds(ponds) {
  return ponds.filter((p) => pondStatusOv(p) !== "prep");
}

// ค่าน้ำ 1 บรรทัด: pH/DO/ALK เสมอ + ค่าที่ผิดเกณฑ์ (NH4/NO2/เค็ม/อุณหภูมิ/สวิง pH)
function waterLine(last) {
  if (!last) return "ยังไม่มีค่าน้ำ";
  const parts = [
    `pH ${last.phM ?? "-"}`,
    `DO ${last.doM ?? "-"}`,
    `ALK ${last.alk ?? "-"}`,
  ];
  const flag = [];
  const chk = (key, label, v) => {
    if (v === null || v === undefined || v === "") return;
    const s = classifyOv(key, v);
    if (s === "warn") flag.push(`${label} ${v}⚠️`);
    else if (s === "danger") flag.push(`${label} ${v}🔴`);
  };
  chk("nh4", "NH4", last.nh4);
  chk("no2", "NO2", last.no2);
  chk("sal", "เค็ม", last.sal);
  chk("tM", "อุณหภูมิ", last.tM);
  if (last.phM != null && last.phA != null && last.phM !== "" && last.phA !== "") {
    const sw = Math.abs(last.phM - last.phA);
    const s = classifyOv("phSwing", sw);
    if (s !== "ok") flag.push(`สวิงpH ${sw.toFixed(1)}${s === "danger" ? "🔴" : "⚠️"}`);
  }
  return parts.concat(flag).join(" · ");
}

// 1 บรรทัดต่อบ่อ: สถานะ + อายุ + ค่าน้ำ + อาหารกก./แสน
function pondLine(p) {
  const status = pondStatusOv(p);
  const icon = {ok: "✅", warn: "⚠️", danger: "🔴", prep: "🧹"}[status];
  const last = (p.records || []).slice(-1)[0];
  const age = p.startDate ? dDiff(p.startDate, today()) : (last ? last.age : null);
  const lf = latestFeed(p);
  const per = lf && lf.totalFeed ? feedPer100k(lf.totalFeed, p.stock) : null;
  const feedStr = lf && lf.totalFeed ?
    `อาหาร ${lf.totalFeed} กก.${per != null ? ` (${per.toFixed(1)} กก./แสน)` : ""}` :
    "ยังไม่ลงอาหาร";
  return `${icon} ${p.name}${age != null ? ` (${age}ว.)` : ""} · ${waterLine(last)} · ${feedStr}`;
}

// ---------------------------------------------------------------------------
// น้ำขึ้นน้ำลง — อ่านจาก RTDB node แยก "tawan_tides" (แปลงจากตารางกรมอุทกศาสตร์ เกาะมัดโพน)
// เก็บแยกจาก tawan_app เพราะแอปจะ .set ทับทั้ง node tawan_app ทุกครั้งที่บันทึก
// โครงสร้าง: { "YYYY-MM-DD": {hiT:"08:00", hiV:2.9, loT:"21:00", loV:1.1}, ... }
// ---------------------------------------------------------------------------

async function loadTides() {
  const snap = await admin.database().ref("tawan_tides").get();
  const v = snap.val();
  if (!v) return {};
  return typeof v === "string" ? JSON.parse(v) : v;
}

function tideLine(tides, dateStr) {
  const t = tides && tides[dateStr];
  if (!t) return null;
  const hi = t.hiV != null ? `ขึ้นสูงสุด ${t.hiT || "-"} ${Number(t.hiV).toFixed(1)} ม.` : "";
  const lo = t.loV != null ? `ลงต่ำสุด ${t.loT || "-"} ${Number(t.loV).toFixed(1)} ม.` : "";
  const s = [hi, lo].filter(Boolean).join(" · ");
  return s || null;
}

// ---------------------------------------------------------------------------
// อากาศ — Open-Meteo (ฟรี ไม่ต้องใช้ API key) พิกัดฟาร์ม ต.นาพญา อ.หลังสวน
// ---------------------------------------------------------------------------

async function fetchWeather() {
  const dailyParams = [
    "temperature_2m_max", "temperature_2m_min",
    "precipitation_sum", "precipitation_probability_max",
    "wind_speed_10m_max", "wind_gusts_10m_max", "weathercode",
  ].join(",");
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
    `&daily=${dailyParams}&forecast_days=1&timezone=Asia%2FBangkok`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`weather http ${r.status}`);
  const data = await r.json();
  return data.daily;
}

function weatherSummary(d) {
  const tMax = d.temperature_2m_max[0];
  const tMin = d.temperature_2m_min[0];
  const rain = d.precipitation_sum[0];
  const rainProb = d.precipitation_probability_max[0];
  const wind = d.wind_speed_10m_max[0];

  const line = `🌡️ ${tMin.toFixed(1)}–${tMax.toFixed(1)}°C · 🌧️ ฝน ${rain.toFixed(1)}มม. ` +
    `(โอกาส ${rainProb}%) · 💨 ${wind.toFixed(0)} กม/ชม`;

  const risk = [];
  if (rain > 50) risk.push("⛈️ ฝนหนักมาก — เฝ้า pH/ALK อาจตกแรง");
  else if (rain > 20) risk.push("🌧️ ฝนหนัก — เฝ้าระวัง pH/ALK");
  if (tMax > 35) risk.push("🌡️ ร้อนจัด — DO วิกฤตช่วงเที่ยง-บ่าย");
  else if (tMax > 33) risk.push("🌡️ ร้อน — ลดอาหาร 20%");
  if (tMin < 24) risk.push("🌙 คืนเย็น — เฝ้า DO ช่วงเช้ามืด");
  if (rainProb > 70) risk.push(`🌂 โอกาสฝน ${rainProb}% — เตรียมรับมือ`);

  return {line, risk};
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
}

function verifySignature(rawBody, signature) {
  if (!LINE_CHANNEL_SECRET || !signature) return false;
  const hash = crypto.createHmac("sha256", LINE_CHANNEL_SECRET).update(rawBody).digest("base64");
  return hash === signature;
}

// ---------------------------------------------------------------------------
// Claude (Haiku) — "สมองเสริม" ตอบคำถามอิสระ โดยแนบข้อมูลฟาร์มสดเป็น context
// ต้องตั้งค่า ANTHROPIC_API_KEY ใน functions/.env ถ้าไม่ตั้งจะข้ามส่วนนี้
// ---------------------------------------------------------------------------

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = "claude-haiku-4-5-20251001";

function buildFarmContext(ponds, tideStr, weatherLine) {
  const c = statusCounts(ponds);
  const active = activePonds(ponds);
  const rows = active.map((p) => {
    const last = (p.records || []).slice(-1)[0];
    const age = p.startDate ? dDiff(p.startDate, today()) : (last ? last.age : null);
    const lf = latestFeed(p);
    const per = lf && lf.totalFeed ? feedPer100k(lf.totalFeed, p.stock) : null;
    return `- ${p.name}: สถานะ ${pondStatusOv(p)}, อายุ ${age ?? "-"} วัน, ` +
      `ปล่อย ${p.stock ?? "-"} ตัว, ${p.size ?? "-"} ไร่, ` +
      `pH ${last?.phM ?? "-"}, DO ${last?.doM ?? "-"}, ALK ${last?.alk ?? "-"}, ` +
      `NH4 ${last?.nh4 ?? "-"}, NO2 ${last?.no2 ?? "-"}, salinity ${last?.sal ?? "-"}, ` +
      `feed ${lf?.totalFeed ?? "-"} kg${per != null ? ` (${per.toFixed(1)} kg/100k)` : ""}`;
  });
  return `ข้อมูลฟาร์มวันนี้ (${today()}):\n` +
    `รวม ${ponds.length} บ่อ — ปกติ ${c.ok}, ต้องดู ${c.warn}, เฝ้าระวัง ${c.danger}, เตรียมบ่อ ${c.prep}\n` +
    `น้ำขึ้น/ลง (เกาะมัดโพน): ${tideStr || "ไม่มีข้อมูล"}\n` +
    `อากาศ: ${weatherLine || "ไม่มีข้อมูล"}\n\n` +
    `บ่อที่กำลังเลี้ยง (${active.length} บ่อ):\n${rows.join("\n") || "(ไม่มี)"}`;
}

async function askClaude(question, ponds, tideStr, weatherLine) {
  const context = buildFarmContext(ponds, tideStr, weatherLine);
  const system = "คุณคือ 'พี่ตะวัน' ผู้ช่วยของฟาร์มกุ้งตะวันฟาร์ม คุยกับพนักงานผ่านไลน์ " +
    "ตอบเป็นภาษาไทย สุภาพ กระชับ เหมาะกับการอ่านบนมือถือ " +
    "ตอบโดยอิงข้อมูลฟาร์มที่ให้มาเป็นหลัก ถ้าข้อมูลไม่พอให้บอกตรง ๆ ห้ามแต่งตัวเลขบ่อขึ้นเอง " +
    "คำถามทั่วไปที่ไม่เกี่ยวกับฟาร์มก็ช่วยตอบสั้น ๆ ได้";
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 600,
      system,
      messages: [{role: "user", content: `${context}\n\nคำถามจากพนักงาน: ${question}`}],
    }),
  });
  if (!r.ok) {
    const errText = await r.text();
    logger.error("Claude API error", r.status, errText);
    return "ขอโทษครับ ตอนนี้ผู้ช่วยตอบไม่ได้ชั่วคราว ลองใหม่อีกครั้งนะครับ";
  }
  const data = await r.json();
  const out = data && data.content && data.content[0] && data.content[0].text;
  return out || "ขอโทษครับ ตอบไม่ได้ในตอนนี้";
}

// ---------------------------------------------------------------------------
// ตรรกะตอบคำถาม — คำสั่งสั้นตอบทันที (ฟรี) · คำถามอื่นส่งให้ Claude (อิงข้อมูลจริง ไม่เดา)
// ---------------------------------------------------------------------------

async function answer(text) {
  const ponds = await loadPonds();
  const t = (text || "").trim();
  const isShort = t.length <= 16; // ข้อความสั้น = คำสั่งด่วน, ยาวกว่านี้ = ส่งให้ Claude

  // การ์ดบ่อด่วน: เฉพาะเมื่อพิมพ์ชื่อบ่อตรง ๆ (เช่น "A.14" หรือ "บ่อ A.14")
  const bare = t.replace(/^บ่อ\s*/, "").trim();
  const exactPond = ponds.find((p) => p.name && bare === p.name);
  if (exactPond) {
    const status = pondStatusOv(exactPond);
    const label = {
      ok: "✅ ปกติ", warn: "⚠️ ต้องดู", danger: "🔴 เฝ้าระวัง", prep: "🧹 กำลังเตรียม",
    }[status];
    const last = (exactPond.records || []).slice(-1)[0];
    const age = exactPond.startDate ?
      dDiff(exactPond.startDate, today()) : (last ? last.age : null);
    const lf = latestFeed(exactPond);
    const per = lf && lf.totalFeed ? feedPer100k(lf.totalFeed, exactPond.stock) : null;
    const feedStr = lf && lf.totalFeed ?
      `\nอาหารล่าสุด: ${lf.totalFeed} กก.${per != null ? ` (${per.toFixed(1)} กก./แสน)` : ""}` : "";
    const detail = last ? `\nค่าน้ำ: ${waterLine(last)}` : "";
    return `บ่อ ${exactPond.name}: ${label}` +
      `${age != null ? ` · อายุ ${age} วัน` : ""}${detail}${feedStr}`;
  }

  if (isShort && /น้ำขึ้น|น้ำลง|น้ำทะเล|ขึ้นลง/.test(t)) {
    const tides = await loadTides();
    const s = tideLine(tides, today());
    return s ?
      `น้ำขึ้น/ลงวันนี้ (เกาะมัดโพน): ${s}` :
      "ยังไม่มีข้อมูลน้ำขึ้นน้ำลงของวันนี้ครับ";
  }

  if (isShort && /เสี่ยง|ต้องดู|เฝ้าระวัง/.test(t)) {
    const flagged = ponds.filter((p) => ["warn", "danger"].includes(pondStatusOv(p)));
    if (!flagged.length) return "✅ ตอนนี้ไม่มีบ่อที่ต้องเฝ้าระวังเป็นพิเศษครับ";
    return "บ่อที่ต้องเฝ้าระวัง:\n" +
      flagged.map((p) => `- ${p.name} (${pondStatusOv(p) === "danger" ? "🔴" : "⚠️"})`).join("\n");
  }

  if (isShort && /สรุป|ภาพรวม|ทั้งหมด/.test(t)) {
    const c = statusCounts(ponds);
    return `สรุปบ่อทั้งหมด ${ponds.length} บ่อ\n` +
      `✅ ปกติ ${c.ok}\n⚠️ ต้องดู ${c.warn}\n🔴 เฝ้าระวัง ${c.danger}\n🧹 กำลังเตรียม ${c.prep}`;
  }

  if (isShort && /งาน|เตรียมบ่อ|วันนี้ทำ/.test(t)) {
    const tasks = todaysTasks(ponds);
    if (!tasks.length) return "วันนี้ไม่มีงานเตรียมบ่อที่ครบกำหนดครับ";
    return "งานที่ต้องทำวันนี้:\n" + tasks.map((x) => `- ${x}`).join("\n");
  }

  // อากาศ — ดึงครั้งเดียว ใช้ทั้งตอบตรงและเป็น context ให้ Claude
  const wantWeather = ANTHROPIC_API_KEY || /อากาศ|ฝน|ร้อน/.test(t);
  let wx = null;
  if (wantWeather) {
    try {
      wx = weatherSummary(await fetchWeather());
    } catch (e) {
      logger.error("weather failed", e);
    }
  }
  if (isShort && /อากาศ|ฝน|ร้อน/.test(t)) {
    if (!wx) return "ขอโทษครับ โหลดข้อมูลอากาศไม่ได้ตอนนี้";
    return `สภาพอากาศวันนี้: ${wx.line}` + (wx.risk.length ? "\n" + wx.risk.join("\n") : "");
  }

  // คำถามอื่น ๆ → ให้ Claude ตอบ (ถ้าตั้งค่า ANTHROPIC_API_KEY ไว้)
  if (ANTHROPIC_API_KEY) {
    let tideStr = null;
    try {
      tideStr = tideLine(await loadTides(), today());
    } catch (e) {
      logger.error("tide load failed", e);
    }
    return await askClaude(t, ponds, tideStr, wx ? wx.line : null);
  }

  return "พิมพ์ถามได้เลยครับ เช่น \"บ่อ A.14\", \"สรุปบ่อทั้งหมด\", " +
    "\"บ่อไหนเสี่ยง\", \"สภาพอากาศวันนี้\", \"งานวันนี้\", \"น้ำขึ้นน้ำลง\"";
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
      if (event.type === "message" && event.message && event.message.type === "text") {
        const srcType = (event.source && event.source.type) || "user";
        const parsed = parseTrigger(event.message.text);

        // ในกลุ่ม/ห้อง: ตอบเฉพาะข้อความที่ขึ้นต้นด้วย "สวัสดีตะวัน" เท่านั้น
        if ((srcType === "group" || srcType === "room") && !parsed.triggered) {
          continue;
        }

        let replyText;
        try {
          if (parsed.triggered && !parsed.query) {
            replyText = "สวัสดีครับ 🦐 พิมพ์ \"สวัสดีตะวัน\" ตามด้วยคำถามได้เลย เช่น " +
              "\"สวัสดีตะวัน สรุปบ่อทั้งหมด\", \"สวัสดีตะวัน บ่อ A.14\", " +
              "\"สวัสดีตะวัน น้ำขึ้นน้ำลง\", \"สวัสดีตะวัน อากาศวันนี้\"";
          } else {
            replyText = await answer(parsed.query);
          }
        } catch (e) {
          logger.error("answer() failed", e);
          replyText = "ระบบขัดข้องชั่วคราว ลองใหม่อีกครั้งครับ";
        }
        await lineApi("message/reply", {
          replyToken: event.replyToken,
          messages: [{type: "text", text: replyText}],
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

exports.dailySummary = onSchedule(
    {schedule: "0 10 * * *", timeZone: "Asia/Bangkok", region: "asia-southeast1"},
    async () => {
      if (!LINE_GROUP_ID) {
        logger.error("LINE_GROUP_ID not set in functions/.env — skip push");
        return;
      }

      const ponds = await loadPonds();
      const c = statusCounts(ponds);
      const tasks = todaysTasks(ponds);
      const active = activePonds(ponds);

      let tideStr = null;
      try {
        const tides = await loadTides();
        tideStr = tideLine(tides, today());
      } catch (e) {
        logger.error("tide load failed", e);
      }

      let weatherLine = "";
      let riskLines = [];
      try {
        const d = await fetchWeather();
        const w = weatherSummary(d);
        weatherLine = w.line;
        riskLines = w.risk;
      } catch (e) {
        logger.error("weather fetch failed", e);
        weatherLine = "โหลดข้อมูลสภาพอากาศไม่ได้";
      }

      const dateLabel = new Date().toLocaleDateString("th-TH", {
        day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Bangkok",
      });

      const lines = [];
      lines.push(`📋 สรุปประจำวัน — ${dateLabel}`);
      lines.push("");
      lines.push("🗓️ งานที่ต้องทำวันนี้:");
      lines.push(tasks.length ?
        tasks.map((t) => `- ${t}`).join("\n") : "- ไม่มีงานเตรียมบ่อครบกำหนดวันนี้");
      lines.push("");
      lines.push(`🌊 น้ำขึ้น/ลง (เกาะมัดโพน): ${tideStr || "— ยังไม่มีข้อมูลของวันนี้"}`);
      lines.push("");
      lines.push(`☁️ สภาพอากาศ: ${weatherLine}`);
      if (riskLines.length) lines.push(riskLines.join("\n"));
      lines.push("");
      lines.push(
          `🦐 สถานะบ่อ (${ponds.length} บ่อ): ✅ ปกติ ${c.ok} · ⚠️ ต้องดู ${c.warn} · ` +
        `🔴 เฝ้าระวัง ${c.danger} · 🧹 กำลังเตรียม ${c.prep}`,
      );
      lines.push("");
      lines.push(`🐟 บ่อที่เลี้ยงอยู่ (${active.length} บ่อ):`);
      if (active.length) {
        active
            .sort((a, b) => {
              const ord = {danger: 0, warn: 1, ok: 2};
              return (ord[pondStatusOv(a)] ?? 3) - (ord[pondStatusOv(b)] ?? 3);
            })
            .forEach((p) => lines.push(pondLine(p)));
      } else {
        lines.push("- ยังไม่มีบ่อที่เลี้ยงอยู่");
      }

      await lineApi("message/push", {
        to: LINE_GROUP_ID,
        messages: [{type: "text", text: lines.join("\n")}],
      });

      logger.info("daily summary pushed to group");
    },
);
