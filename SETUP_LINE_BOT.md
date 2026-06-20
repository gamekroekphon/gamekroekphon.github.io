# วิธี deploy LINE Bot ตะวันฟาร์ม (ทำที่เครื่องคุณเอง)

ผมเตรียมโค้ด Cloud Functions ไว้ในโฟลเดอร์ `functions/` แล้ว สิ่งที่ต้องทำต่อคือ
ติดตั้งเครื่องมือ + กรอกค่าลับ + deploy ซึ่งต้องทำผ่านเครื่องคุณเอง เพราะต้อง
login ด้วยบัญชี Google ของคุณเอง (ผมจะไม่ขอ/ไม่เห็นรหัสผ่านหรือ token ของคุณ)

## 1. ติดตั้ง Firebase CLI (ทำครั้งเดียว)
เปิด Terminal/Command Prompt แล้วรัน:
```
npm install -g firebase-tools
firebase login
```
จะเปิดเบราว์เซอร์ให้ login ด้วย Google account ที่ผูกกับโปรเจกต์ `tawanfarm-efd8b`

## 2. กรอกค่าลับ LINE
ไปที่โฟลเดอร์ `functions/` คัดลอกไฟล์ `.env.example` เป็น `.env`
แล้วกรอก 2 ค่านี้ (หาได้จาก LINE Developers Console > Provider ตะวันฟาร์ม > ช่อง Bot):
- `LINE_CHANNEL_SECRET` — จากแท็บ Basic settings
- `LINE_CHANNEL_ACCESS_TOKEN` — จากแท็บ Messaging API (กด Issue ถ้ายังไม่มี)

ค่า `LINE_GROUP_ID` กรอกไว้ให้แล้ว (ของกลุ่มพนักงานที่ทดสอบไว้)

## 3. ติดตั้ง dependencies
```
cd functions
npm install
```

## 4. ทดสอบก่อน deploy (แนะนำ)
```
firebase emulators:start --only functions
```
ดูว่า function ขึ้นโดยไม่มี error สีแดง (กด Ctrl+C เพื่อหยุด)

## 5. Deploy จริง
```
firebase deploy --only functions
```
รอจนเสร็จ จะได้ URL ของ `lineWebhook` ออกมา เช่น
`https://asia-southeast1-tawanfarm-efd8b.cloudfunctions.net/lineWebhook`

## 6. ตั้ง Webhook URL ใน LINE
เอา URL จากขั้นตอนที่ 5 ไปวางใน LINE Developers Console > Messaging API >
Webhook URL แล้วกด Verify ให้ผ่าน (เปิด "Use webhook" ด้วย)

## 7. ทดสอบ
- ทักบอทถามคำถาม เช่น "สรุปบ่อทั้งหมด", "บ่อ A.14", "บ่อไหนเสี่ยง", "อากาศวันนี้", "งานวันนี้"
- ฟังก์ชัน `dailySummary` จะรันอัตโนมัติทุกวัน 09:00 (เวลาไทย) ถ้าอยากทดสอบก่อนถึงเวลา
  ให้สั่งรันด้วยมือผ่าน Firebase Console > Functions > dailySummary > Test function
  (หรือบอกผม จะช่วยแนะนำคำสั่งทดสอบให้)

---
มีปัญหาขั้นตอนไหน ส่ง error message หรือ screenshot มาได้เลยครับ
