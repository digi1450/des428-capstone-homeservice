# วิธีทำงานร่วมกัน

## เริ่มครั้งแรก

1. Clone repository จาก URL จริงของทีม แล้วเข้าโฟลเดอร์ repository
2. รัน monolith และ tests ตาม README ให้ได้ก่อน
3. อ่าน [สถานะ A–E ปัจจุบัน](docs/current-area-status.md), OWNERS.md, docs/team-plan.md และ [migration handoff](docs/migration-handoff.md) แล้วรับงานกับเจ้าของ area
4. ตกลง API/event/auth contracts กับผู้ใช้ interface นั้นก่อนเริ่มแก้

Public repository: https://github.com/digi1450/des428-capstone-homeservice อ่านได้สาธารณะ ส่วนการ push/merge ต้องมีสิทธิ์ ใช้บัญชี GitHub ของตัวเอง ห้ามแชร์บัญชีหรือ token

## Branch ต่อชิ้นงาน

เผยแพร่ branches งานแรก A–E ตาม docs/team-plan.md บน GitHub แล้ว สมาชิกที่ clone repo ให้ดึง main ล่าสุดและอัปเดต branch ก่อนเริ่มงาน เช่น:

```sh
git fetch origin
git switch feat/b-secure
git merge origin/main
```

เปลี่ยนชื่อ branch ตาม area ของตัวเองและรับงานกับทีมก่อน ตัวอย่างถัดไปใช้สำหรับสร้าง branch งานใหม่ ไม่ใช่สร้างชื่อซ้ำกับ branch ที่มีแล้ว

ไม่ push ตรงเข้า main ใช้ branch สั้นตามงาน เช่น feat/a-notifications-extraction หรือ feat/b-secure งานใหม่หลัง PR เดิมจบให้สร้าง branch ใหม่จาก main ล่าสุด ไม่ใช้ branch ประจำคนยาวจนจบโปรเจกต์

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

เปิด PR เข้า main ก่อนเสมอ แต่ไม่บังคับให้มี approval (required approvals = 0) สมาชิกที่มี write access merge PR ของตัวเองหรือของเพื่อนได้เมื่อเงื่อนไขอื่นผ่าน GitHub ไม่ให้ผู้เปิด PR กด Approve ตัวเอง จึงใช้การ merge โดยไม่ต้องรอ approval แทน เมื่อ push เพิ่มเข้า branch เดิม PR จะอัปเดตตาม อย่าใส่ secrets, tokens, .env, SQLite runtime, node_modules หรือ .next ใน commit

## เกณฑ์ merge

CI สำหรับ PR ที่แก้เฉพาะ Markdown บางตำแหน่งใช้ [docs-only fast path](docs/ci-docs-fast-path.md); ไม่มี check เพราะถูกข้ามไม่เท่ากับ test ผ่าน หากมีโค้ด/config/workflow ปนอยู่ยังต้องรันตาม filters เดิม

- PR ทำงานหนึ่งชิ้นที่ตรวจได้ และไม่ทำให้ main เปิดระบบไม่ได้
- แจ้งว่าเปลี่ยนอะไร กระทบใคร และทดสอบอะไรจริง รวมผลและสิ่งที่ยังไม่ทดสอบ
- รัน inherited tests เมื่อแก้ business logic หรือส่วนเชื่อมต่อที่กระทบ monolith และรัน tests ของส่วนที่แก้
- ถ้าเปลี่ยน API/events/auth ต้องแก้ contracts และทดสอบร่วมกับ consumer/provider ที่เกี่ยวข้อง การทดสอบ service เดี่ยวผ่านไม่ได้รับรองว่าระบบรวมผ่าน
- ประสานเจ้าของ area ที่ได้รับผลกระทบและตรวจ diff/ผลทดสอบก่อน merge; ขอ review จากเพื่อนได้ แต่ไม่บังคับให้มี approval
- ปิด Require Code Owner Review แล้ว CODEOWNERS ระบุ @digi1450 เป็นผู้ติดต่อ review โดยปริยาย ไม่ใช่ผู้ที่ต้องอนุมัติ เงื่อนไข dismiss stale reviews ยังเก็บไว้ แต่ไม่ได้ทำให้ต้องมี approval เมื่อ required approvals เป็น 0
- เจ้าของ repo @digi1450 มี admin bypass ตามที่ทีมผู้ดูแลเลือก จึง merge PR ของตัวเองได้โดยไม่ต้อง approve ตัวเอง สิทธิ์นี้ยังอนุญาตให้ Owner ข้ามข้อบังคับ PR/review ของ main ได้; สมาชิกทั่วไปไม่มีข้อยกเว้นนี้ ใช้ branch/PR เป็น workflow ปกติแม้เป็น Owner
- สมาชิกที่มี write access merge PR ของตัวเองหรือของสมาชิกคนอื่นได้โดยไม่ต้องรอ approval; ยังคงต้องแก้ conflicts และ resolve conversations รวมถึงผ่าน required checks หากทีมเพิ่มภายหลัง
- ต้อง resolve conversations ก่อน merge สำหรับสมาชิกทั่วไป และไม่อนุญาต force push/delete main ตาม protection rule; Owner มี admin bypass จึงไม่ถือว่ากฎเหล่านี้บังคับกับ Owner
- มี automated CI แล้วใน `.github/workflows/` รวม service, auth, contracts, migration และ consistency checks ตรวจผลบน exact head ปัจจุบันก่อน merge; การมี workflow ไม่ได้แปลว่าทุก job เป็น required branch-protection check

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
| Notifications business implementation/extraction | A | B/C/D/E ตามผลกระทบ |
| Payments & Wallet business implementation/extraction | A | B/C/D ตามผลกระทบ |
| Outbox, events, dedupe, Booking saga/recovery | C ประสาน API/transaction hooks กับ A | A/D/E |
| Keycloak และ token/user mapping | B | A/C |
| Retry, idempotency, fault/concurrency tests | D | A/C |
| Root Compose, observability, CI | E | ทุก area ที่เกี่ยวข้อง |

B/D/E จำเป็นต้องแก้ใน services ได้ ให้ประสาน A/C แทนการถือว่าแต่ละ branch แตะได้เฉพาะโฟลเดอร์เดียว อย่าเปลี่ยน shared schema, root lockfile หรือ reformat ทั้งไฟล์พร้อมกันโดยไม่แจ้งทีม

รวม PR เล็กทุกวัน และรายงาน 3 อย่าง: เสร็จอะไร รออะไรจากใคร และผลทดสอบจริง บันทึก contribution ใน OWNERS.md และเขียน dossier ส่วนของตนระหว่างทำ
