# TawanFarm App — บันทึกการตรวจสอบบัค

ประวัติการแก้บัค/ฟีเจอร์ทั้งหมด (entry #1–233) ย้ายไปเก็บที่ [CLAUDE_HISTORY.md](CLAUDE_HISTORY.md) — เปิดอ่านเมื่อต้องอ้างอิงเหตุผล/บริบทของการแก้ไขในอดีต ไม่โหลดเข้า context อัตโนมัติทุกครั้ง

## หมายเหตุโครงสร้างโค้ด

- `index.html` และ `TawanFarm_App.html` เป็นไฟล์เดียวกัน (ต้อง sync ทั้งคู่ทุกครั้งก่อน commit)
- แต่ละหน้าคือ `<div id="sec-xxx" class="sec">` เปลี่ยนหน้าโดย toggle class
- Deploy ด้วย `git commit` + `push` ขึ้น GitHub Pages โดยตรง — สคริปต์ `push_*.bat` และ `deploy.ps1` เก่าถูกลบทิ้งแล้ว (entry #222)
- ขนาดตัวอักษรทั้งแอปเขียนเป็น `calc(<N>px * var(--ui-scale))` — เวลาเพิ่มโค้ดใหม่ห้ามใส่ `font-size:NNpx` โดดๆ ไม่งั้นปุ่ม ก/ก+/ก++ จะไม่ขยายจุดนั้น (entry #225)
