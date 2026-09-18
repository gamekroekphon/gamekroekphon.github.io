/**
 * แจ้งเตือนบิลรับของเข้ากลุ่มไลน์ (entry #284)
 *
 * แอปฝั่งหน้าเว็บเขียน "เหตุการณ์" เปล่าๆ ลง /tawan_events/<id> = {type, billId, actorUid, at}
 * ฟังก์ชันนี้อ่านบิลจริงจาก tawan_app แล้วประกอบข้อความเอง
 *
 * ⚠️ ห้ามเอาข้อความจากฝั่งหน้าเว็บมาส่งเข้าไลน์ตรงๆ — ใครที่ล็อกอินแอปได้ก็เขียน node นี้ได้
 *    ถ้าเชื่อข้อความจากฝั่งนั้น จะกลายเป็นช่องส่งข้อความอะไรก็ได้เข้ากลุ่มไลน์ของฟาร์ม
 * ⚠️ ห้ามใส่ราคา/ยอดเงินลงข้อความ — กลุ่มไลน์มี staff อยู่ด้วย (ข้อมูลการเงินเป็นของเจ้าของเท่านั้น)
 */

const APP_URL = "https://gamekroekphon.github.io/";
const MAX_ITEM_LINES = 8;

/** ตัดข้อความให้สั้นและไม่มีขึ้นบรรทัดใหม่ กันข้อความยาวผิดปกติดันรูปแบบเสีย */
function clean(s, max) {
  return String(s == null ? "" : s)
      .replace(/[\r\n\t]+/g, " ")
      .trim()
      .slice(0, max || 80);
}

function itemLines(bill) {
  const items = Array.isArray(bill.items) ? bill.items : [];
  const shown = items.slice(0, MAX_ITEM_LINES)
      .map((x) => `• ${clean(x.name, 40)} ${Number(x.qty) || 0} ${clean(x.unit, 12)}`.trim());
  if (items.length > MAX_ITEM_LINES) {
    shown.push(`• …และอีก ${items.length - MAX_ITEM_LINES} รายการ`);
  }
  return shown;
}

/**
 * ประกอบข้อความจากบิลจริง — คืน null ถ้าสถานะไม่ตรงกับเหตุการณ์ (เช่นถูกอนุมัติไปก่อนแล้ว)
 * @param {string} type ชนิดเหตุการณ์
 * @param {object} bill บิลจาก D.stockBills
 * @return {string|null} ข้อความที่จะส่งเข้าไลน์
 */
function billEventText(type, bill) {
  if (!bill) return null;
  const by = clean(bill.by, 40) || "พนักงาน";
  const n = Array.isArray(bill.items) ? bill.items.length : 0;
  const shop = clean(bill.shop, 40);
  const lines = itemLines(bill);

  if (type === "bill_wait") {
    if (bill.status !== "wait") return null;
    return [
      "📥 บิลรับของรอตรวจ",
      `${by} ส่งบิลมา ${n} รายการ${shop ? ` · ${shop}` : ""}`,
      ...lines,
      "",
      `เปิดแอป › สต็อก เพื่อใส่ราคาและกดอนุมัติ`,
      APP_URL,
    ].join("\n");
  }
  if (type === "bill_back") {
    if (bill.status !== "back") return null;
    return [
      "↩️ บิลรับของถูกตีกลับ",
      `บิลของ ${by}: ${clean(bill.reason, 120) || "ให้ตรวจสอบอีกครั้ง"}`,
      ...lines,
      "",
      "แก้แล้วส่งใหม่ได้ที่แอป › 📷 ถ่ายบิลรับของ",
    ].join("\n");
  }
  if (type === "bill_ok") {
    if (bill.status !== "ok") return null;
    return [
      "✅ อนุมัติบิลรับของแล้ว",
      `บิลของ ${by} · รับเข้าสต็อก ${n} รายการ`,
      ...lines,
    ].join("\n");
  }
  return null;
}

module.exports = {billEventText, clean, itemLines, APP_URL, MAX_ITEM_LINES};
