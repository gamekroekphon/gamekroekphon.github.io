/**
 * ตะวันฟาร์ม — สำรองลง Google Drive (#423 → #429)
 *   ① ข้อมูลแอป ทุกวันที่ 1 ตี 4 → โฟลเดอร์ "TawanFarm สำรองข้อมูล" / tawan_YYYY-MM-DD.json ({updated, z, json?} เหมือน /tawan_app)
 *   ② รูปบิล ทุกวัน ตี 5 (เฉพาะบิลที่ยังไม่มีใน Drive) → โฟลเดอร์ "TawanFarm รูปบิล" / YYYY-MM-DD_<billId>_<หน้า>.jpg
 *      บิลที่ลบใน Firebase แล้ว รูปใน Drive ยังอยู่ (เก็บเป็นหลักฐาน) · ไม่ลบอะไรใน Firebase
 * รันในบัญชี Google ของเจ้าของโปรเจกต์ Firebase (ไม่มีรหัส/คีย์ในไฟล์นี้ — ใช้สิทธิ์ของบัญชีที่ล็อกอิน)
 * ติดตั้ง/อัปเดต: วางโค้ดนี้แทนของเดิม → เลือกฟังก์ชัน setup → Run 1 ครั้ง
 */
const DB_URL = 'https://tawanfarm-efd8b-default-rtdb.asia-southeast1.firebasedatabase.app';
const FOLDER = 'TawanFarm สำรองข้อมูล';
const PHOTO_FOLDER = 'TawanFarm รูปบิล';
const PHOTO_MAX_PER_RUN = 300;   // กันเกินเวลารัน 6 นาทีของ Apps Script — ที่เหลือรอบถัดไปทำต่อ

// รัน 1 ครั้งตอนติดตั้ง/อัปเดต: ตั้งเวลาใหม่ทั้งหมด + สำรองครั้งแรกทันที
function setup() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('backup').timeBased().onMonthDay(1).atHour(4).create();
  ScriptApp.newTrigger('backupPhotos').timeBased().everyDays(1).atHour(5).create();
  backup();
  backupPhotos();
}

function fbGet(path, query) {
  const res = UrlFetchApp.fetch(DB_URL + path + '.json' + (query || ''), {
    headers: {Authorization: 'Bearer ' + ScriptApp.getOAuthToken()},
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('อ่าน Firebase ไม่ได้ (' + path + '): ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
  }
  return res.getContentText();
}

function folderOf(name) {
  const it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

function backup() {
  const body = fbGet('/tawan_app');
  if (body.length < 1000) throw new Error('ข้อมูลสั้นผิดปกติ: ' + body.slice(0, 200));
  const v = JSON.parse(body);
  if (!v || !v.updated || !(v.z || v.json)) throw new Error('ข้อมูลไม่ครบ: ไม่มี updated/z/json');
  const folder = folderOf(FOLDER);
  const day = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd');
  const name = 'tawan_' + day + '.json';
  const old = folder.getFilesByName(name);
  while (old.hasNext()) old.next().setTrashed(true);   // รันซ้ำวันเดียวกัน = แทนไฟล์เดิม (ย้ายเข้าถังขยะ ไม่ลบถาวร)
  folder.createFile(name, body, 'application/json');
  console.log('สำรองแล้ว ' + name + ' · ' + Math.round(body.length / 1024) + ' KB · ข้อมูลเมื่อ ' + v.updated);
}

// รูปบิล: /tawan_bill_photos/<billId> = {p0, p1, …: dataURL JPEG, n, at}
function backupPhotos() {
  const ids = Object.keys(JSON.parse(fbGet('/tawan_bill_photos', '?shallow=true')) || {});
  const folder = folderOf(PHOTO_FOLDER);
  const have = {};
  const it = folder.getFiles();
  while (it.hasNext()) {
    const m = it.next().getName().match(/^\d{4}-\d\d-\d\d_(.+)_\d+\.jpg$/);
    if (m) have[m[1]] = true;
  }
  let saved = 0, bills = 0;
  for (const id of ids) {
    if (have[id]) continue;
    if (saved >= PHOTO_MAX_PER_RUN) break;
    const o = JSON.parse(fbGet('/tawan_bill_photos/' + encodeURIComponent(id))) || {};
    const ms = (id.match(/(\d{13})/) || [])[1];   // billId มีเวลาสร้างเป็นมิลลิวินาที
    const day = ms ? Utilities.formatDate(new Date(+ms), 'Asia/Bangkok', 'yyyy-MM-dd') : '0000-00-00';
    const pages = Object.keys(o).filter(k => /^p\d+$/.test(k)).sort((a, b) => +a.slice(1) - +b.slice(1));
    pages.forEach((k, i) => {
      const b64 = String(o[k]).split(',')[1];
      if (!b64) return;
      folder.createFile(Utilities.newBlob(Utilities.base64Decode(b64), 'image/jpeg', day + '_' + id + '_' + (i + 1) + '.jpg'));
      saved++;
    });
    bills++;
  }
  console.log('รูปบิล: เพิ่ม ' + bills + ' บิล · ' + saved + ' รูป · ใน Firebase ' + ids.length + ' บิล');
}
