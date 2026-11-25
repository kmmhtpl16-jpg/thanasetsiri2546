// POST /api/login  {pin:"123456", check?:true}  → { ok, token, role }
// ตรวจ PIN บนเซิร์ฟเวอร์ แล้วออก custom token ให้เข้าบัญชีเดิม (uid เดิม) พร้อม claim tha_role + pv (เลขรุ่น PIN)
// ตัวล็อกการกดผิด (แบบ r27 ข้อ 2.1 · คุณหลิงเคาะ 24 พ.ย. 69): นับใน transaction เดียวกับการตรวจ PIN — ดู _lib/tha-guard.js
//   เครื่องแปลก: ผิด 5 ครั้ง/IP หรือรวม 5 ครั้งทุกเครื่องแปลก → ล็อก 15 นาที (ล็อกซ้ำนานขึ้น) · เครื่องที่เคยเข้า: เพดาน 10 ต่อเครื่อง / 30 รวม
// custom token หมดอายุ = เวลา commit + 5 นาที · ออกได้เฉพาะเมื่อเลขรุ่น PIN ยังเดิม และไม่เกิน 60 วินาทีหลัง commit
import { json, originOk, readBody, clientIp, customToken, roleUids, getDocSA, fv } from '../_lib/tha-auth.js';
import { pinAttempt, deviceCookie, deviceSetCookie, revokeAgainRun, issueDevice, CUSTOM_TOKEN_MS } from '../_lib/tha-guard.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    if (!originOk(request, env)) return json({ ok: false, error: 'origin' }, 403);
    const body = await readBody(request, 200);
    const pin = body && typeof body.pin === 'string' ? body.pin : '';
    if (!/^\d{6}$/.test(pin)) return json({ ok: false, error: 'bad pin' }, 400);
    const check = body.check === true;

    const devRaw = deviceCookie(request);
    const r = await pinAttempt(env, pin, { ip: clientIp(request), devRaw: devRaw, touchDevice: !check });
    if (r.status === 'locked') return json({ ok: false, error: 'locked', until: r.until, wait: Math.ceil((r.until - Date.now()) / 1000) }, 429);
    if (r.status === 'wrong') return json({ ok: false, error: 'wrong pin', locked: r.locks.length > 0 }, 401);
    if (r.status !== 'ok') return json({ ok: false, error: 'retry' }, 503);

    // body.check = true → แค่ยืนยัน PIN (ใช้ปลดล็อกหน้ารายจ่าย) ไม่ออกบัตร
    if (check) return json({ ok: true, role: r.role });

    // revoke ซ้ำที่ค้าง (ทั้งสองบทบาท) · รอไม่เกิน 5 วินาที แล้วทำงานต่อเบื้องหลัง — ไม่บล็อกการเข้า
    // (revoke ซ้ำตัดเฉพาะ session ที่เข้าก่อนเวลาจองงาน จึงทำหลังออกบัตรนี้ก็ไม่ตัดบัตรนี้)
    {
      const p = revokeAgainRun(env).catch(function () {});
      if (context && typeof context.waitUntil === 'function') context.waitUntil(p);
      await Promise.race([p, new Promise(function (s) { setTimeout(s, 5000); })]);
    }

    // ออกบัตรได้เฉพาะเมื่อเลขรุ่นยังเดิม และยังไม่เกิน 60 วินาทีหลัง commit
    const d = await getDocSA(env, 'tha_auth/' + r.role);
    if (Number(fv(d, 'ver') || 0) !== r.ver || Date.now() - r.commitMs > 60000) return json({ ok: false, error: 'retry' }, 503);
    const exp = Math.floor((r.commitMs + CUSTOM_TOKEN_MS) / 1000);
    const token = await customToken(env, roleUids(env)[r.role], { tha_role: r.role, pv: r.ver }, exp);
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
    if (r.known && devRaw && r.devRole === r.role) headers['set-cookie'] = deviceSetCookie(devRaw);   // ต่ออายุ cookie ให้ตรงกับ expiresAt ที่ฐานต่อให้
    else {
      // เครื่องแปลก หรือเครื่องที่จำไว้เป็นอีกบทบาท (เช่น staff → admin บนเบราว์เซอร์เดียวกัน):
      // ออกบัตรเครื่องของบทบาทนี้หลังออกบัตรผ่านสำเร็จแล้วเท่านั้น · ล้ม/เกินโควตา = เข้าได้โดยไม่จำเครื่อง (บัตรเดิมยังอยู่)
      // รอไม่เกิน 4 วินาที · เกินเวลา = เข้าได้โดยไม่จำเครื่อง (ถ้าออกสำเร็จทีหลัง ใบนั้นค้างในรายการโดยไม่มีเครื่องถือ
      //   = ใช้โควตา 1 ใบ · ทางกู้: ปุ่มล้างเครื่องทั้งหมดล้างโควตา)
      let nd = null;
      try {
        const ip = issueDevice(env, r.role, r.ver, r.known ? r.dh : null).catch(function () { return null; });
        if (context && typeof context.waitUntil === 'function') context.waitUntil(ip);
        nd = await Promise.race([ip, new Promise(function (s) { setTimeout(function () { s(null); }, 4000); })]);
      } catch (e) {}
      if (nd) headers['set-cookie'] = deviceSetCookie(nd);
    }
    // device: 'known' = เครื่องที่จำไว้ · 'new' = เพิ่งจำ · 'none' = ไม่ได้จำ (โควตาเต็ม/ออกไม่สำเร็จ) → หน้าเว็บบอกทางกู้
    const device = headers['set-cookie'] ? (r.known && r.devRole === r.role ? 'known' : 'new') : 'none';
    return new Response(JSON.stringify({ ok: true, token: token, role: r.role, device: device }), { status: 200, headers: headers });
  } catch (e) {
    return json({ ok: false, error: 'retry' }, 503);   // ไม่บอกว่า PIN ถูกหรือผิด
  }
}
export async function onRequestGet() { return json({ ok: false, error: 'use POST' }, 405); }
