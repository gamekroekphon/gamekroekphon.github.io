/**
 * สำรองข้อมูลแอปทุกคืน (#423) — /tawan_backups/<YYYY-MM-DD> = {updated, z, ponds, at}
 *   z = gzip base64 ของ JSON ทั้งก้อน (รูปแบบเดียวกับ tawan_app/z) · updated = เวอร์ชันของ tawan_app ที่สำรอง
 * เก็บรายวัน KEEP_DAYS วัน · วันที่ 1 ของทุกเดือนเก็บตลอดไป
 * path นี้ไม่อยู่ใน firebase_rules.json = แอปฝั่งหน้าเว็บอ่าน/เขียน/ลบไม่ได้ (บัคในแอปลบสำรองไม่ได้)
 * กู้ข้อมูล: อ่าน z → gunzip → เขียน tawan_app ด้วย {json, updated, z:null} (หลังพี่ปิดแอปทุกเครื่อง + สำรองของปัจจุบันก่อน)
 */
const zlib = require("zlib");

const KEEP_DAYS = 90;

function addDays(ymd, n) {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// วันที่ที่ต้องลบในคืนนี้ — ไล่ย้อน 7 วันหลังเลยกำหนด เผื่อคืนก่อนๆ ทำงานไม่สำเร็จ · วันที่ 1 ไม่ลบ
function pruneKeys(today) {
  const out = [];
  for (let i = KEEP_DAYS + 1; i <= KEEP_DAYS + 7; i++) {
    const k = addDays(today, -i);
    if (!k.endsWith("-01")) out.push(k);
  }
  return out;
}

// ข้อมูลที่จะเก็บ — json = สตริงจาก readAppJson()
function backupRecord(json, updated) {
  let ponds = null;
  try {
    ponds = (JSON.parse(json).ponds || []).length;
  } catch (e) {
    ponds = -1;   // อ่านไม่ออก ก็ยังเก็บไว้ (เป็นหลักฐานว่าวันนั้นข้อมูลเป็นแบบนี้)
  }
  return {
    updated: updated || null,
    z: zlib.gzipSync(Buffer.from(json, "utf8")).toString("base64"),
    ponds,
    at: new Date().toISOString(),
  };
}

module.exports = {KEEP_DAYS, addDays, pruneKeys, backupRecord};
