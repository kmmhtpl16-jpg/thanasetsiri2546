// POST /api/notify {text}  หัว Authorization: Bearer <Firebase ID token ที่ได้จาก /api/login>
// ส่งข้อความเข้ากลุ่ม Telegram ท่าทราย · รับเฉพาะบัตร admin/staff ของแอปท่าทราย · จำกัด 30 ข้อความ/นาที/บทบาท
// (เดิมไม่มีรหัส ใครก็ยิงได้ — ปิดในงานแก้รหัสฝังหน้าเว็บ 23 พ.ย. 69)
import { json, originOk, readBody, verifyIdToken, thaRoleOf, commit, wIncrement, tgSend } from '../_lib/tha-auth.js';
import { revokeAgainRun, bg } from '../_lib/tha-guard.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    if (!originOk(request, env)) return json({ ok: false, error: 'origin' }, 403);
    const tok = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const role = await thaRoleOf(env, await verifyIdToken(env, tok, { checkRevoked: true }));
    if (!role) return json({ ok: false, error: 'unauthorized' }, 401);
    const body = await readBody(request, 16000);
    const text = (body && typeof body.text === 'string' ? body.text : '').trim();
    if (!text) return json({ ok: false, error: 'no text' }, 400);
    const min = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 16).replace(/[-T:]/g, '');
    const r = await commit(env, null, [wIncrement(env, 'tha_login_guard/_notify_' + role + '_' + min, 'n', 1)]);
    const t = r.writeResults && r.writeResults[0] && r.writeResults[0].transformResults && r.writeResults[0].transformResults[0];
    if (t && Number(t.integerValue) > 30) return json({ ok: false, error: 'rate' }, 429);
    const ok = await tgSend(env, text.slice(0, 3500));
    await bg(context, revokeAgainRun(env));   // ตัวกระตุ้น revoke ซ้ำที่ค้าง (ทั้งสองบทบาท · แบบ r27 ข้อ 2.5)
    return json({ ok: ok }, ok ? 200 : 502);
  } catch (e) {
    return json({ ok: false, error: 'server' }, 500);
  }
}
export async function onRequestGet() {
  return json({ ok: true, info: 'use POST' }, 200);
}
