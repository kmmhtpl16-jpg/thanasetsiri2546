// POST /api/pin-change  {currentPin:"<PIN admin ปัจจุบัน>", role:"admin"|"staff"}
//   หัว Authorization: Bearer <Firebase ID token ของ admin>
// → เซิร์ฟเวอร์สุ่ม PIN ใหม่ 6 หลักให้บทบาทนั้น · คืน PIN ครั้งเดียว · ตัดทุกเครื่องของบทบาทนั้นให้กด PIN ใหม่
// ทางกู้ (ถ้าบันทึก PIN ใหม่แล้วแต่หน้าจอไม่ได้รับ เช่นเน็ตหลุด): admin กดเปลี่ยนซ้ำได้ถ้ายังรู้ PIN admin ·
//   ถ้า PIN admin เองหาย: คุณหลิงลบเอกสาร tha_auth/admin และ tha_auth/staff ใน Firebase Console แล้วใช้ /api/pin-setup (ต้องมี PIN_SETUP_KEY) ตั้งใหม่
// เปลี่ยนพร้อมกัน 2 หน้าจอ: ธุรกรรมเช็กเลขรุ่นที่เห็นตอนเริ่ม + ห้ามเปลี่ยนซ้ำภายใน 60 วินาที → หน้าจอหลังได้ 409 ไม่ทับ
// บัตรเก่าของบทบาทนั้นหมดสิทธิ์ทันทีจากเลขรุ่น (pv) · revoke เป็นแค่ชั้นเสริม ล้มได้โดยไม่เสีย PIN ใหม่
// ต้องเป็นเครื่องที่รู้จักของ admin (บัตรเครื่อง) · นับครั้งผิดด้วยตัวนับ dev/known ของเครื่อง + ต่อ uid (แบบ r27 ข้อ 2.1/2.5)
import {
  json, originOk, readBody, clientIp, verifyIdToken, thaRoleOf, roleUids, pinHash, randomHex, randomVer, randomPin, weakPin,
  withTx, txBegin, txGet, rollback, commit, wUpdate, fv, revokeUid, tgSend
} from '../_lib/tha-auth.js';
import { pinAttempt, deviceCookie, devHash, knownDeviceRole, pinChangeCounterPaths, anyLocked, stampVerSeen } from '../_lib/tha-guard.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    if (!originOk(request, env)) return json({ ok: false, error: 'origin' }, 403);
    const tok = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const p = await verifyIdToken(env, tok, { checkRevoked: true });
    if ((await thaRoleOf(env, p)) !== 'admin') return json({ ok: false, error: 'forbidden' }, 403);

    const body = await readBody(request, 200);
    const cur = body && typeof body.currentPin === 'string' ? body.currentPin : '';
    const target = body && body.role;
    if (!/^\d{6}$/.test(cur) || (target !== 'admin' && target !== 'staff')) return json({ ok: false, error: 'bad input' }, 400);

    const devRaw = deviceCookie(request);
    if (!devRaw) return json({ ok: false, error: 'device' }, 403);
    const g = await pinAttempt(env, cur, { ip: clientIp(request), devRaw: devRaw, uidKey: p.sub, requireKnownRole: 'admin', acceptRole: 'admin', touchDevice: false });
    const dh = await devHash(devRaw);
    const cps = await pinChangeCounterPaths(env, devRaw, p.sub);
    if (g.status === 'device') return json({ ok: false, error: 'device' }, 403);
    if (g.status === 'locked') return json({ ok: false, error: 'locked', until: g.until, wait: Math.ceil((g.until - Date.now()) / 1000) }, 429);
    if (g.status === 'wrong') return json({ ok: false, error: 'wrong pin' }, 401);
    if (g.status !== 'ok' || g.role !== 'admin') return json({ ok: false, error: 'wrong pin' }, 401);

    const other = target === 'admin' ? 'staff' : 'admin';
    const pre = await readVers(env);
    const seen = pre[target];                             // เลขรุ่นที่ admin เห็นตอนกด
    if (Date.now() - pre[target + 'Changed'] < 60000) return json({ ok: false, error: 'changed' }, 409);  // เช็กก่อน revoke
    // ตัด refresh token ก่อนเขียน PIN ใหม่ (ถ้าทำหลัง อาจไปตัดคนที่เพิ่งล็อกอินด้วย PIN ใหม่) · ล้มได้ — เลขรุ่นใหม่ตัดบัตรเก่าอยู่แล้ว
    // ข้อจำกัดที่ยอมรับ: 2 หน้าจอกดพร้อมกันในเสี้ยววินาที ตัวที่แพ้ (409) อาจ revoke หลังตัวชนะ → คนที่เพิ่งกด PIN ใหม่ต้องกดอีกครั้ง (ไม่เสียข้อมูล/สิทธิ์)
    let revoked = true;
    try { await revokeUid(env, roleUids(env)[target]); } catch (e) { revoked = false; }
    let newVer = 0;
    const newPin = await withTx(env, async function (tx) {
      // ตรวจซ้ำทุกอย่างใน transaction เดียวกับการเขียน PIN ใหม่ (กันแข่งกับเปลี่ยน PIN admin / ล้างเครื่อง ระหว่างทาง)
      const got = await txGet(env, tx, ['tha_auth/admin', 'tha_auth/staff', 'tha_devices_meta/main', 'tha_devices/' + dh].concat(cps));
      if (anyLocked(cps.map(function (q) { return got[q]; }), Date.now())) throw new Error('LOCKED');                 // ตัวนับถูกล็อกระหว่างทาง
      const td = got['tha_auth/' + target], od = got['tha_auth/' + other], ad = got['tha_auth/admin'];
      if (!td) throw new Error('no auth doc');
      const auth = { admin: ad, staff: got['tha_auth/staff'] };
      if (knownDeviceRole(got['tha_devices/' + dh], got['tha_devices_meta/main'], auth, dh, Date.now()) !== 'admin') throw new Error('CHANGED');   // บัตรเครื่องถูกล้าง/ver เปลี่ยน
      if (Number(fv(ad, 'ver') || 0) !== p.pv) throw new Error('CHANGED');                                                                        // บัตรผ่าน (pv) ยังเป็นรุ่นปัจจุบัน
      // ตรวจ PIN admin ซ้ำในธุรกรรม (กันเปลี่ยน PIN admin ตัดหน้าระหว่างทาง)
      if (!(await pinHash(env, fv(ad, 'salt') || 'x', cur) === fv(ad, 'hash'))) throw new Error('CHANGED');
      if (Number(fv(td, 'ver') || 0) !== seen) throw new Error('CHANGED');
      // เพิ่งเปลี่ยนไปไม่ถึง 60 วินาที = ปฏิเสธ (กัน 2 หน้าจอกดพร้อมกันแล้ว PIN ที่หน้าจอแรกได้ถูกทับ)
      const last = (fv(td, 'changedAt') ? (Date.parse(fv(td, 'changedAt')) || 0) : 0);
      if (Date.now() - last < 60000) throw new Error('CHANGED');
      let pin = null;
      for (let i = 0; i < 50 && !pin; i++) {
        const c = randomPin();
        if (weakPin(c)) continue;
        const oSalt = fv(od, 'salt'), oHash = fv(od, 'hash');
        if (oSalt && oHash && (await pinHash(env, oSalt, c)) === oHash) continue; // ห้ามซ้ำอีกบทบาท
        if ((await pinHash(env, fv(td, 'salt') || 'x', c)) === fv(td, 'hash')) continue; // ห้ามได้ PIN เดิมของตัวเอง
        pin = c;
      }
      if (!pin) throw new Error('no pin');
      const salt = randomHex(16);
      let ver = randomVer(); while (ver === Number(fv(td, 'ver'))) ver = randomVer();   // เลขรุ่นสุ่มใหม่ ไม่ซ้ำของเดิม
      await commit(env, tx, [wUpdate(env, 'tha_auth/' + target, { salt: salt, hash: await pinHash(env, salt, pin), ver: ver, updatedAt: new Date(), changedAt: new Date() }, { updateTime: td.updateTime })]);
      newVer = ver;
      return pin;
    });
    // งานประกอบหลังบันทึก PIN ใหม่: ไม่ให้ขวางการตอบ PIN (ทำเบื้องหลัง · ถ้าไม่มี waitUntil รอไม่เกิน 3 วิ)
    const side = (async function () {
      try { await stampVerSeen(env, target, newVer); } catch (e) {}   // เริ่มนับ 6 นาทีของ revoke ซ้ำ (ล้มได้ ตัวกระตุ้นแรกประทับแทน)
      await tgSend(env, '🔐 เปลี่ยน PIN เข้าแอปท่าทรายของบทบาท ' + (target === 'admin' ? 'เจ้าของ (admin)' : 'พนักงาน (staff)') + ' แล้ว — เครื่องเดิมของบทบาทนี้ต้องกด PIN ใหม่ · ระบบจะตัดบัตรเก่าซ้ำอัตโนมัติหลัง 6 นาที (ดูสถานะในแท็บตั้งค่า)');
    })().catch(function () {});
    if (context && typeof context.waitUntil === 'function') context.waitUntil(side);
    else await Promise.race([side, new Promise(function (s) { setTimeout(s, 3000); })]);
    return json({ ok: true, role: target, pin: newPin, revoked: revoked });
  } catch (e) {
    if (String(e && e.message) === 'CHANGED') return json({ ok: false, error: 'changed' }, 409);
    if (String(e && e.message) === 'LOCKED') return json({ ok: false, error: 'locked' }, 429);
    return json({ ok: false, error: 'server' }, 500);
  }
}
export async function onRequestGet() { return json({ ok: false, error: 'use POST' }, 405); }

async function readVers(env) {
  const tx = await txBegin(env);
  try {
    const got = await txGet(env, tx, ['tha_auth/admin', 'tha_auth/staff']);
    const ch = function (d) { return (fv(d, 'changedAt') ? (Date.parse(fv(d, 'changedAt')) || 0) : 0); };
    return { admin: Number(fv(got['tha_auth/admin'], 'ver') || 0), staff: Number(fv(got['tha_auth/staff'], 'ver') || 0),
             adminChanged: ch(got['tha_auth/admin']), staffChanged: ch(got['tha_auth/staff']) };
  } finally { await rollback(env, tx); }
}
