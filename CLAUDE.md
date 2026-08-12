# TawanFarm App — บันทึกการตรวจสอบบัค

ประวัติการแก้บัค/ฟีเจอร์ทั้งหมด (entry #1–163) ย้ายไปเก็บที่ [CLAUDE_HISTORY.md](CLAUDE_HISTORY.md) — เปิดอ่านเมื่อต้องอ้างอิงเหตุผล/บริบทของการแก้ไขในอดีต ไม่โหลดเข้า context อัตโนมัติทุกครั้ง

## หมายเหตุโครงสร้างโค้ด

- `index.html` และ `TawanFarm_App.html` เป็นไฟล์เดียวกัน (ต้อง sync การแก้ทั้งคู่เวลา deploy — ดู push_*.bat)
- แต่ละหน้าคือ `<div id="sec-xxx" class="sec">` เปลี่ยนหน้าโดย toggle class
- Deploy ผ่านสคริปต์ `push_*.bat` แต่ละไฟล์ต่อ 1 ฟีเจอร์/ฟิกซ์
