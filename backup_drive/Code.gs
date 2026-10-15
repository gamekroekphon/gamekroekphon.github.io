/**
 * ตะวันฟาร์ม — สำรองข้อมูลแอปลง Google Drive ทุกวันที่ 1 ของเดือน (#423)
 * รันในบัญชี Google ของเจ้าของโปรเจกต์ Firebase (ไม่มีรหัส/คีย์ในไฟล์นี้ — ใช้สิทธิ์ของบัญชีที่ล็อกอิน)
 * ไฟล์ที่ได้ = โฟลเดอร์ "TawanFarm สำรองข้อมูล" / tawan_YYYY-MM-DD.json  (รูปแบบเดียวกับ /tawan_app: {updated, z, json?})
 * ติดตั้ง: วางโค้ดนี้ + appsscript.json → เลือกฟังก์ชัน setup → Run 1 ครั้ง (อนุญาตสิทธิ์) → จบ
 */
const DB_URL = 'https://tawanfarm-efd8b-default-rtdb.asia-southeast1.firebasedatabase.app';
const FOLDER = 'TawanFarm สำรองข้อมูล';

// รัน 1 ครั้งตอนติดตั้ง: ตั้งเวลาทุกวันที่ 1 ตี 4 + สำรองครั้งแรกทันที
function setup() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('backup').timeBased().onMonthDay(1).atHour(4).create();
  backup();
}

function backup() {
  const res = UrlFetchApp.fetch(DB_URL + '/tawan_app.json', {
    headers: {Authorization: 'Bearer ' + ScriptApp.getOAuthToken()},
    muteHttpExceptions: true,
  });
  const body = res.getContentText();
  if (res.getResponseCode() !== 200 || body.length < 1000) {
    throw new Error('อ่านข้อมูลจาก Firebase ไม่ได้: ' + res.getResponseCode() + ' ' + body.slice(0, 200));
  }
  const v = JSON.parse(body);
  if (!v || !v.updated || !(v.z || v.json)) throw new Error('ข้อมูลไม่ครบ: ไม่มี updated/z/json');
  const it = DriveApp.getFoldersByName(FOLDER);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(FOLDER);
  const day = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd');
  const name = 'tawan_' + day + '.json';
  const old = folder.getFilesByName(name);
  while (old.hasNext()) old.next().setTrashed(true);   // รันซ้ำวันเดียวกัน = แทนไฟล์เดิม (ย้ายเข้าถังขยะ ไม่ลบถาวร)
  folder.createFile(name, body, 'application/json');
  console.log('สำรองแล้ว ' + name + ' · ' + Math.round(body.length / 1024) + ' KB · ข้อมูลเมื่อ ' + v.updated);
}
