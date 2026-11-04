# วิธีทำงานร่วมกัน

## เริ่มครั้งแรก

1. Clone private repository จาก URL จริงของทีม แล้วเข้าโฟลเดอร์ repository
2. รัน monolith และ tests ตาม README ให้ได้ก่อน
3. อ่าน OWNERS.md และ docs/team-plan.md แล้วรับงานกับเจ้าของ area
4. ตกลง API/event/auth contracts กับผู้ใช้ interface นั้นก่อนเริ่มแก้

ตอนนี้ยังไม่มี GitHub remote: คำสั่งที่ใช้ origin/PR จะใช้ได้หลังเชื่อม GitHub แล้ว

## Branch ต่อชิ้นงาน

เตรียม local branches สำหรับงานแรก A–E ตาม docs/team-plan.md ไว้จาก baseline เดียวกัน โดยยังไม่ได้ publish ไป GitHub หลังเชื่อม remote และ publish แล้ว สมาชิกที่ clone repo สามารถเลือก branch งานแรก เช่น:

```sh
git fetch origin
git switch feat/b-keycloak
```

เปลี่ยนชื่อ branch ตาม area ของตัวเองและรับงานกับทีมก่อน ตัวอย่างถัดไปใช้สำหรับสร้าง branch งานใหม่ ไม่ใช่สร้างชื่อซ้ำกับ branch ที่มีแล้ว

ไม่ push ตรงเข้า main ใช้ branch สั้นตามงาน เช่น feat/a-notifications-extraction หรือ feat/b-keycloak งานใหม่หลัง PR เดิมจบให้สร้าง branch ใหม่จาก main ล่าสุด ไม่ใช้ branch ประจำคนยาวจนจบโปรเจกต์

ก่อนเริ่ม ตรวจว่าไม่มีงานค้างที่ยังไม่ commit:

```sh
git status
git switch main
git pull --ff-only
git switch -c feat/a-notifications-extraction
```

ทำงาน ทดสอบ แล้วตรวจ diff และ stage เฉพาะไฟล์ที่ตั้งใจเปลี่ยน ตัวอย่างต้องแทน path ด้วยไฟล์จริงของงาน:

```sh
git status
git diff
git add -- <path-to-reviewed-file>
git diff --cached
git commit -m "Extract notifications behind its service boundary"
git push -u origin feat/a-notifications-extraction
```

เปิด PR เข้า main และให้สมาชิกอื่นอย่างน้อยหนึ่งคน review เมื่อ push เพิ่มเข้า branch เดิม PR จะอัปเดตตาม อย่าใส่ secrets, tokens, .env, SQLite runtime, node_modules หรือ .next ใน commit

## เกณฑ์ merge

- PR ทำงานหนึ่งชิ้นที่ตรวจได้ และไม่ทำให้ main เปิดระบบไม่ได้
- แจ้งว่าเปลี่ยนอะไร กระทบใคร และทดสอบอะไรจริง รวมผลและสิ่งที่ยังไม่ทดสอบ
- รัน inherited tests เมื่อแก้ business logic หรือส่วนเชื่อมต่อที่กระทบ monolith และรัน tests ของส่วนที่แก้
- ถ้าเปลี่ยน API/events/auth ต้องแก้ contracts และทดสอบร่วมกับ consumer/provider ที่เกี่ยวข้อง การทดสอบ service เดี่ยวผ่านไม่ได้รับรองว่าระบบรวมผ่าน
- ขอ review จากเจ้าของไฟล์/area ที่ได้รับผลกระทบ ไม่อนุมัติ PR ของตัวเองแทน peer review
- ยังไม่มี automated CI หรือ branch protection ใน baseline นี้ E จะเพิ่ม checks; ผู้ดูแลต้องตั้ง GitHub ให้ require PR, peer review และ required checks ที่มีอยู่จริงก่อนเริ่มทำงานร่วมกัน

## อัปเดต branch ที่กำลังทำ

Commit งานที่ต้องเก็บให้เรียบร้อย แล้วอยู่บน feature branch ของตัวเอง:

```sh
git fetch origin
git merge origin/main
```

ถ้า conflict ให้คุยกับผู้แก้ไฟล์นั้น รวมเจตนาของทั้งสองฝ่าย ลบ conflict markers, stage ไฟล์ที่แก้ และ commit merge เมื่อทดสอบแล้ว ห้าม force push หรือทับไฟล์เพื่อนเพื่อให้ conflict หาย

หลัง PR merge แล้ว กลับ main และ pull เวอร์ชันล่าสุดก่อนเริ่ม branch งานใหม่

## ไฟล์ร่วมและจุดส่งต่อ

| ส่วน | ผู้ประสานหลัก | ผู้ร่วม review |
|---|---|---|
| Gateway, monolith callers, ขอบเขตการย้ายทั้งสอง services | A | C และผู้ใช้ interface |
| Notifications extraction | A โดย D ช่วย | B/C/E ตามผลกระทบ |
| Payments & Wallet implementation, events, saga | C ร่วม A | A/D |
| Keycloak และ token/user mapping | B | A/C |
| Retry, idempotency, fault/concurrency tests | D | A/C |
| Root Compose, observability, CI | E | ทุก area ที่เกี่ยวข้อง |

B/D/E จำเป็นต้องแก้ใน services ได้ ให้ประสาน A/C แทนการถือว่าแต่ละ branch แตะได้เฉพาะโฟลเดอร์เดียว อย่าเปลี่ยน shared schema, root lockfile หรือ reformat ทั้งไฟล์พร้อมกันโดยไม่แจ้งทีม

รวม PR เล็กทุกวัน และรายงาน 3 อย่าง: เสร็จอะไร รออะไรจากใคร และผลทดสอบจริง บันทึก contribution ใน OWNERS.md และเขียน dossier ส่วนของตนระหว่างทำ
