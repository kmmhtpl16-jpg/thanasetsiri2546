// POST /api/pin-setup  หัว x-setup-key: <PIN_SETUP_KEY>
// ใช้ครั้งเดียวตอนเริ่มระบบ: สร้าง PIN สุ่ม 6 หลักให้ admin และ staff (ไม่ซ้ำกัน) แล้วคืนให้เห็นครั้งเดียว
// ทำได้เฉพาะเมื่อยังไม่มี tha_auth/admin และ tha_auth/staff (มีแล้ว = ปฏิเสธ) · ตั้งเสร็จให้ลบ PIN_SETUP_KEY ออกจาก Cloudflare
import { stampVerSeen } from '../_lib/tha-guard.js';
import { json, safeEq, pinHash, randomHex, randomVer, randomPin, weakPin, commit, wUpdate, tgSend, sha256hex } from '../_lib/tha-auth.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const key = env.PIN_SETUP_KEY || '';
    const got = request.headers.get('x-setup-key') || '';
    if (key.length < 32 || !safeEq(await sha256hex(got), await sha256hex(key))) return json({ ok: false, error: 'forbidden' }, 403);
    let a = null, s = null;
    for (let i = 0; i < 50 && !a; i++) { const c = randomPin(); if (!weakPin(c)) a = c; }
    for (let i = 0; i < 50 && !s; i++) { const c = randomPin(); if (!weakPin(c) && c !== a) s = c; }
    if (!a || !s) throw new Error('no pin');
    const sa = randomHex(16), ss = randomHex(16), now = new Date();
    // เลขรุ่นสุ่ม → ตั้งใหม่หลังลบ (ทางกู้) ได้เลขที่ไม่ซ้ำของเดิม บัตรเก่าไม่ฟื้นกลับมา
    const verA = randomVer(); let verS = randomVer(); while (verS === verA) verS = randomVer();   // เลขรุ่นสุ่มแยกบทบาท (แบบ r27) · changedAt = จุดเริ่มนับ revoke ซ้ำ
    // mustNotExist ทั้งคู่ใน commit เดียว → มีอยู่แล้วตัวใดตัวหนึ่ง = ล้มทั้งชุด
    await commit(env, null, [
      wUpdate(env, 'tha_auth/admin', { salt: sa, hash: await pinHash(env, sa, a), ver: verA, updatedAt: now, changedAt: now }, { mustNotExist: true }),
      wUpdate(env, 'tha_auth/staff', { salt: ss, hash: await pinHash(env, ss, s), ver: verS, updatedAt: now, changedAt: now }, { mustNotExist: true })
    ]);
    for (const [rl, vv] of [['admin', verA], ['staff', verS]]) { try { await stampVerSeen(env, rl, vv); } catch (e) {} }   // เริ่มนับ revoke ซ้ำหลัง commit
    await tgSend(env, '🔐 ตั้ง PIN เข้าแอปท่าทรายครั้งแรกแล้ว (ถ้าไม่ใช่คุณหลิงทำ แจ้งห้อง Code ทันที)');
    return json({ ok: true, admin: a, staff: s });
  } catch (e) {
    return json({ ok: false, error: String(e && e.message).indexOf('commit 409') >= 0 || String(e && e.message).indexOf('ALREADY') >= 0 ? 'already set' : 'server' }, 500);
  }
}
export async function onRequestGet() { return json({ ok: false, error: 'use POST' }, 405); }
