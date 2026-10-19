/**
 * ผู้ช่วย AI ในแอป (#430) — admin เท่านั้น
 *
 * โครง: เบราว์เซอร์ admin ส่งบทสนทนามา → function นี้ (เช็คสิทธิ์ + งบ + ถือคีย์) เรียก Claude 1 รอบ แล้ว stream กลับ
 *   ถ้า Claude ขอเครื่องมือ → ส่ง tool_use กลับให้เบราว์เซอร์รันเครื่องมือเอง (ใช้สูตรเดียวกับแอป — ห้ามคิดคู่ขนานฝั่งเซิร์ฟเวอร์)
 *   → เบราว์เซอร์ส่ง tool_result กลับมาเรียก function อีกรอบ (วนจนตอบเสร็จ)
 * งบ: นับจาก usage จริงทุกรอบ → /tawan_ai_usage/<YYYY-MM> (ไม่อยู่ใน firebase_rules.json = หน้าเว็บอ่าน/เขียนไม่ได้)
 *   ถึง AI_CAP_THB แล้วหยุดตอบจนต้นเดือน · ชั้นที่ 2 = Monthly spend limit $15 ใน Claude Console
 */
const AnthropicMod = require("@anthropic-ai/sdk");
const Anthropic = AnthropicMod.default || AnthropicMod;

const AI_CAP_THB = 500;     // เพดานต่อเดือน (พี่สั่ง 17 ต.ค. 69)
const THB_PER_USD = 36;     // ปัดขึ้นจากเรทจริง กันงบหลุด
const MAX_BODY = 400000;    // ขนาดบทสนทนาที่รับต่อรอบ (ตัวอักษร)
const MODELS = {
  // ราคา $/ล้าน token (cached 2026-10-06) · Haiku 5.5 ราคานี้ใช้กับ prompt ≤100K
  quick: {id: "claude-haiku-5-5", maxTokens: 8000, pin: 0.10, pout: 0.50, pcw: 0.125, pcr: 0.01, label: "Haiku"},
  deep: {id: "claude-sonnet-5-5", maxTokens: 16000, pin: 2, pout: 10, pcw: 2.5, pcr: 0.20, label: "Sonnet"},
};

const SYSTEM = `คุณคือ "ตะวัน AI" ผู้ช่วยของ "ตะวันฟาร์ม" ฟาร์มกุ้งขาวที่ชุมพร (บ่อ A.1–A.27 แบ่งโซน A/B) และสวนปาล์ม "ตะวันปาล์ม" ผู้ถามคือเจ้าของ/ผู้จัดการฟาร์ม (admin)
ถามได้ทั้งเรื่องฟาร์ม และเรื่องทั่วไป (ความรู้กุ้ง/ปาล์ม/เกษตร แปล เขียนข้อความ ฯลฯ)

กติกา:
- ตัวเลขของฟาร์มทุกตัวต้องมาจากเครื่องมือของแอป (tools) ซึ่งใช้สูตรเดียวกับในแอป — ห้ามเดาหรือคำนวณ FCR / ต้นทุน / อัตรารอด / biomass เอง ถ้าต้องการตัวเลขไหนให้เรียกเครื่องมือ
- ถ้าเครื่องมือไม่มีข้อมูลที่ต้องการ ให้บอกตรงๆ ว่าไม่มีข้อมูล อย่าเดา
- "สมุดความรู้ตะวันฟาร์ม" ด้านล่าง = วิธีคิด/วิธีทำของฟาร์มที่เจ้าของตัดสินไว้ ใช้อธิบายและให้คำแนะนำให้ตรงกับฟาร์ม · ถ้าขัดกับตัวเลขสดจากเครื่องมือ ให้เชื่อตัวเลขสด · สูตรยา/จุลินทรีย์ที่ใช้อยู่จริงดูจาก farm_protocols
- เรื่องทั่วไปตอบจากความรู้ได้ · ถ้าเป็นเรื่องที่ต้องใช้ข้อมูลล่าสุด (ราคา ข่าว ประกาศ) และมีเครื่องมือ web_search ให้ค้นแล้วบอกแหล่งที่มา · ถ้าไม่มีเครื่องมือค้นเว็บ ให้บอกว่า "เปิด 🔍 ละเอียด เพื่อค้นเว็บ" และบอกว่าความรู้ของคุณอาจไม่เป็นปัจจุบัน
- ตอบภาษาไทย สั้น ตรงประเด็น ใช้ตารางเมื่อเทียบหลายบ่อ/หลายรอบ · เจ้าของไม่ชอบอ่านยาว
- ข้อสรุป/คำแนะนำหลักให้เขียนบรรทัดเดียวขึ้นต้นด้วย 👉 (แอปจะทำเป็นกล่องสรุป)
- ไซส์ = ตัว/กก. (ตัวเลขน้อย = กุ้งใหญ่) · PDG = กรัม/วัน · FCR ระหว่างเลี้ยง = ณ วันสุ่มล่าสุด เทียบกับเกณฑ์ของฟาร์ม · กก./แสน = อาหารต่อวันต่อกุ้งแสนตัว · ไซส์/น้ำหนัก/กก.ต่อไร่ เป็นค่า ณ วันสุ่ม ให้บอกวันสุ่มเสมอ
- ไซส์ 30 ลงมา = กุ้งใหญ่ใกล้จับ · PDG ต่ำช่วงท้ายรอบ (อายุ 90 วันขึ้นไป ไซส์ใหญ่) เป็นเรื่องปกติ อย่าตัดสินว่า "โตช้า" จาก PDG อย่างเดียว ให้ดูคู่กับอายุและไซส์
- ปี = พ.ศ. · เงิน = บาท
- อ่านอย่างเดียว คุณแก้ข้อมูลในแอปไม่ได้ ถ้าผู้ถามสั่งแก้ ให้บอกว่าต้องแก้ในหน้าไหน
- ถ้าวิเคราะห์ "ทำไม" ให้บอกเหตุผลจากตัวเลขที่เห็น และบอกด้วยว่าอะไรยังสรุปไม่ได้`;

// สมุดความรู้ (functions/farm_knowledge.md) — แก้ไฟล์แล้วต้อง deploy · อยู่ใน system ชุดเดียวกันทุกคำถาม (ถูกแคช)
const KNOWLEDGE = (() => {
  try {
    return require("fs").readFileSync(require("path").join(__dirname, "farm_knowledge.md"), "utf8");
  } catch (e) {
    return "";
  }
})();
const SYSTEM_BLOCKS = [{type: "text", text: SYSTEM}].concat(KNOWLEDGE ? [{type: "text", text: "<สมุดความรู้ตะวันฟาร์ม>\n" + KNOWLEDGE + "\n</สมุดความรู้ตะวันฟาร์ม>"}] : []);

// เครื่องมือ = ชื่อ + schema เท่านั้น · ตัวรันอยู่ในหน้าเว็บ (index.html AI_TOOLS) — แก้ชื่อ/ช่องต้องแก้ทั้งสองฝั่ง
const obj = (props, req) => ({type: "object", properties: props, required: req || [], additionalProperties: false});
const TOOLS = [
  {name: "farm_overview", description: "ภาพรวมบ่อที่กำลังเลี้ยงทุกบ่อ: โซน อายุ โรงเพาะฟัก ยอดปล่อย ผลสุ่มล่าสุด (วัน ไซส์ PDG อัตรารอด) biomass กก./ไร่ FCR+เกณฑ์ อาหารเมื่อวาน สถานะ/เหตุผลที่ต้องดู ต้นทุนสะสม + วันนี้ของระบบ · เรียกตัวนี้ก่อนถ้าคำถามเกี่ยวกับหลายบ่อ",
    input_schema: obj({})},
  {name: "pond_detail", description: "รายละเอียดบ่อเดียว (รอบที่กำลังเลี้ยง): ผลสุ่มทุกครั้ง อาหารรายวัน ค่าน้ำรายวัน (pH DO ALK NH4 NO2 Temp Sal สีน้ำ) กุ้งตาย ผลแล็บล่าสุด พาเชียล ต้นทุนแยกหมวด ของที่เบิกลงบ่อรวมตามรายการ",
    input_schema: obj({pond: {type: "string", description: "ชื่อบ่อ เช่น A.18"}, days: {type: "integer", description: "ย้อนหลังกี่วัน สำหรับอาหาร/ค่าน้ำ/กุ้งตาย (ค่าเริ่ม 14 สูงสุด 60)"}}, ["pond"])},
  {name: "closed_crops", description: "รอบที่ปิดแล้ว (จากสรุปปิดบ่อ): ป้ายรอบ บ่อ วันลง/วันปิด อายุ โรงเพาะฟัก ยอดสั่ง กก. ไซส์ อัตรารอด FCR รายได้ ต้นทุนรวม กำไร ต้นทุน/กก. สาเหตุปิด · กรองตามปีที่ปิด (พ.ศ.) และ/หรือบ่อ",
    input_schema: obj({year: {type: "integer", description: "ปี พ.ศ. ที่ปิดรอบ เช่น 2569 (ไม่ใส่ = ทุกปี)"}, pond: {type: "string", description: "ชื่อบ่อ (ไม่ใส่ = ทุกบ่อ)"}})},
  {name: "stock_items", description: "สินค้าในสต็อก: คงเหลือฟาร์ม/บุญชู หน่วย ราคาทุน หมวด บริษัท สถานะหมด/ใกล้หมด",
    input_schema: obj({query: {type: "string", description: "ค้นชื่อสินค้า (บางส่วนได้)"}, low_only: {type: "boolean", description: "เฉพาะที่หมด/ใกล้หมด"}})},
  {name: "stock_usage", description: "สรุปการเบิกของ (ลงบ่อ + ใช้ร่วม) ในช่วงวันที่: จำนวนและมูลค่า จัดกลุ่มตามรายการ/บ่อ/วัน · ไม่รวมอาหารกุ้ง (อาหารดูใน pond_detail)",
    input_schema: obj({from: {type: "string", description: "YYYY-MM-DD"}, to: {type: "string", description: "YYYY-MM-DD"},
      item: {type: "string", description: "กรองชื่อสินค้าหรือหมวด (บางส่วนได้) หมวด: ยากิน ยาลงน้ำ จุลินทรีย์กิน จุลินทรีย์ลงน้ำ ปูน อุปกรณ์ น้ำมัน"}, pond: {type: "string", description: "กรองบ่อ"},
      group_by: {type: "string", enum: ["item", "pond", "item_pond", "day"], description: "จัดกลุ่ม (ค่าเริ่ม item)"}}, ["from", "to"])},
  {name: "harvests", description: "รายการจับกุ้งทุกครั้ง (พาเชียล + ปิดบ่อ): วันที่ บ่อ ชนิด กก. ไซส์ ราคา ยอดเงิน แพ",
    input_schema: obj({from: {type: "string", description: "YYYY-MM-DD"}, to: {type: "string", description: "YYYY-MM-DD"}, pond: {type: "string"}})},
  {name: "lab_vs_usage", description: "ผลแล็บ × ของที่ใช้ลงบ่อ: เมื่อเชื้อเกินเกณฑ์ฟาร์ม (ตับเหลือง ≥10⁴ · ตับเขียว ≥10² · EHP ตัวอ่อน ≥40) ช่วงนั้นใช้ยากิน/จุลินทรีย์กินอะไร และผลแล็บครั้งถัดไปต่ำกว่าเกณฑ์กี่ครั้ง เทียบกับช่วงที่ไม่ได้ใช้ยากิน · collecting=true = ข้อมูลยังไม่พอ ห้ามสรุป · ใส่ pond เพื่อดูทีละช่วงของบ่อนั้น (ค่าแล็บก่อน/หลัง + ของที่ใช้)",
    input_schema: obj({threshold: {type: "string", enum: ["hy", "hg", "el", "all"], description: "hy=ตับเหลือง hg=ตับเขียว el=EHP ตัวอ่อน all=ทั้งหมด (ค่าเริ่ม all)"},
      item: {type: "string", description: "กรองชื่อยา/จุลินทรีย์ (บางส่วนได้)"}, pond: {type: "string", description: "ชื่อบ่อ เพื่อดูทีละช่วง"}})},
  {name: "farm_protocols", description: "Protocol เวชภัณฑ์ที่ฟาร์มใช้อยู่ตอนนี้ (หน้า 💊 ในแอป): โปรแกรมผสมอาหาร/ลงน้ำ/ตัดเชื้อ/พบเชื้อ/ฝนตก/ก่อนจับ/เจอกุ้งตัวแดง ฯลฯ ชื่อยา+ปริมาณ",
    input_schema: obj({query: {type: "string", description: "ค้นในหัวข้อ/เนื้อหา (ไม่ใส่ = ทั้งหมด)"}})},
  {name: "palm_summary", description: "สวนปาล์มรายปี: ผลผลิต กก. ราคาเฉลี่ย รายรับ รายจ่ายแยกหมวด (ค่าดูแล/ลงทุน) กำไร ข้อมูลรายแปลง",
    input_schema: obj({year: {type: "integer", description: "ปี ค.ศ. เช่น 2026 (ไม่ใส่ = ปีนี้)"}})},
].map((t) => ({...t, strict: true}));
// ค้นเว็บ = โหมดละเอียดเท่านั้น (พี่สั่ง กันกดเล่นเสียเงิน) · $10/1,000 ครั้ง · จำกัด 3 ครั้งต่อรอบ
const WEB_SEARCH = {type: "web_search_20260209", name: "web_search", max_uses: 3};
const WEB_SEARCH_USD = 0.01;   // ช่องเล็ก (ชื่อบ่อ/วันที่) ไม่ต้อง eager streaming

// ข้อความ error ให้คนอ่านรู้เรื่อง · เครดิตหมด/ชนเพดาน Console = 400 พร้อมข้อความ (ไม่มีรหัสเฉพาะ)
function aiErrMsg(e) {
  const st = e && e.status, t = String((e && e.message) || "");
  if (/credit balance/i.test(t)) return "เครดิต Claude หมด — เติมเงินที่ Console (console.anthropic.com)";
  if (/usage limit|spend limit/i.test(t)) return "ชนเพดานรายเดือนใน Claude Console — เพิ่มเพดานที่ Console หรือรอเดือนหน้า";
  if (st === 401 || st === 403) return "คีย์ Claude ใช้ไม่ได้ — เช็คคีย์ใน Console";
  if (st === 429 || st === 529 || st === 503) return "AI ไม่ว่าง ลองใหม่อีกครั้ง";
  if (st === 400) return "คำขอไม่ถูกต้อง · กด เรื่องใหม่";
  return "เรียก AI ไม่สำเร็จ";
}
function monthKey() {
  return new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 7);
}
function costUsd(m, u) {
  if (!u) return 0;
  return ((u.input_tokens || 0) * m.pin + (u.cache_creation_input_tokens || 0) * m.pcw +
    (u.cache_read_input_tokens || 0) * m.pcr + (u.output_tokens || 0) * m.pout) / 1e6 +
    ((u.server_tool_use && u.server_tool_use.web_search_requests) || 0) * WEB_SEARCH_USD;
}

// ตรวจบทสนทนาที่เบราว์เซอร์ส่งมา — รับแค่ user/assistant และขนาดจำกัด
function cleanMessages(raw) {
  if (!Array.isArray(raw) || !raw.length) throw new Error("ไม่มีข้อความ");
  if (JSON.stringify(raw).length > MAX_BODY) throw new Error("บทสนทนายาวเกิน · กด เรื่องใหม่");
  const out = raw.filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content != null)
    .map((m) => ({role: m.role, content: m.content}));
  if (!out.length || out[0].role !== "user") throw new Error("ข้อความแรกต้องเป็นคำถาม");
  return out;
}

/**
 * deps = {admin, logger} · req.body = {messages, deep}
 * ส่งกลับเป็น SSE: {t:"text",d} · {t:"done",content,stop,cost,month} · {t:"error",msg}
 */
async function handleAiChat(req, res, deps) {
  const {admin, logger} = deps;
  const send = (o) => res.write("data: " + JSON.stringify(o) + "\n\n");
  // ── สิทธิ์: Firebase ID token + users/<uid>/role === admin (ไม่เชื่อสิ่งที่หน้าเว็บบอก) ──
  const tok = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  let uid;
  try {
    uid = (await admin.auth().verifyIdToken(tok)).uid;
  } catch (e) {
    res.status(401).json({error: "ต้องล็อกอิน"});
    return;
  }
  const role = (await admin.database().ref("users/" + uid + "/role").get()).val();
  if (role !== "admin") {
    res.status(403).json({error: "เฉพาะ admin"});
    return;
  }
  const mk = monthKey(), uref = admin.database().ref("tawan_ai_usage/" + mk);
  const used = (await uref.get()).val() || {};
  const usedThb = (used.usd || 0) * THB_PER_USD;
  if (req.method === "GET") {
    res.json({month: mk, thb: Math.round(usedThb * 100) / 100, cap: AI_CAP_THB, n: used.n || 0});
    return;
  }
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  if (usedThb >= AI_CAP_THB) {
    send({t: "error", msg: "งบเดือนนี้ครบ ฿" + AI_CAP_THB + " แล้ว · ใช้ได้อีกครั้งต้นเดือนหน้า"});
    res.end();
    return;
  }
  let messages;
  try {
    messages = cleanMessages(req.body && req.body.messages);
  } catch (e) {
    send({t: "error", msg: e.message});
    res.end();
    return;
  }
  const m = req.body.deep ? MODELS.deep : MODELS.quick;
  // ⚠️ ห้ามเติม/แก้ข้อความใน messages ฝั่งนี้ — ในรอบเครื่องมือ บทสนทนาต้องต่อท้ายอย่างเดียว (thinking ผูกกับประวัติ)
  //    วันที่ของระบบ = หน้าเว็บใส่ท้ายคำถามเองตั้งแต่ต้น (ไม่ใส่ใน system กันแคชพัง)
  const client = new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY});
  const params = {
    model: m.id, max_tokens: m.maxTokens, system: SYSTEM_BLOCKS, tools: req.body.deep ? TOOLS.concat([WEB_SEARCH]) : TOOLS, messages,
    cache_control: {type: "ephemeral"},
  };
  let msg;
  try {
    // Sonnet 5.5: ขอ fallback ฝั่งเซิร์ฟเวอร์ไว้ (ถ้าถูกปฏิเสธ) · Haiku 5.5 ไม่มี fallback
    const stream = req.body.deep ?
      client.beta.messages.stream({...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default"}) :
      client.messages.stream(params);
    stream.on("text", (d) => send({t: "text", d}));
    msg = await stream.finalMessage();
  } catch (e) {
    logger.error("aiChat claude", e && e.status, e && e.message);
    send({t: "error", msg: aiErrMsg(e)});
    res.end();
    return;
  }
  const usd = costUsd(m, msg.usage);
  try {
    await uref.transaction((v) => {
      v = v || {};
      v.usd = (v.usd || 0) + usd;
      v.n = (v.n || 0) + 1;
      v[m.label] = (v[m.label] || 0) + usd;
      return v;
    });
  } catch (e) {
    logger.error("aiChat usage", e);
  }
  // เบราว์เซอร์ต้องได้ content ของ assistant ครบ (thinking/tool_use/fallback) ไว้ต่อท้ายส่งกลับรอบหน้าแบบไม่แก้
  send({t: "done", content: msg.content, stop: msg.stop_reason, model: m.label,
    cost: Math.round(usd * THB_PER_USD * 100) / 100, month: Math.round((usedThb + usd * THB_PER_USD) * 100) / 100, cap: AI_CAP_THB});
  res.end();
}

module.exports = {handleAiChat, TOOLS, SYSTEM, SYSTEM_BLOCKS, KNOWLEDGE, MODELS, costUsd, cleanMessages, aiErrMsg, AI_CAP_THB, THB_PER_USD};
