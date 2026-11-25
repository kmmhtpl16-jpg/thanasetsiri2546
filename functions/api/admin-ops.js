// POST /api/admin-ops  {action}  หัว Authorization: Bearer <Firebase ID token ของ admin>
// งานของแท็บตั้งค่า (admin เท่านั้น · แบบ r27):
//   status        → สถานะ revoke ซ้ำรายบทบาท (done / wait / pending) + เวลาครบกำหนด
//   revoke-again  → สั่งตัดบัตรเก่าที่ค้างของทั้งสองบทบาทเดี๋ยวนี้ (ถ้าครบ 6 นาทีหลังเปลี่ยน PIN แล้ว)
//   clear-devices → ล้างบัตรเครื่องทั้งหมด (ทุกเครื่องกลายเป็นเครื่องแปลก)
//   set-webhook   → ตั้ง Telegram webhook ตามค่า TG_WEBHOOK_SECRET ใน env (ไม่มีค่าลับใน URL/คำตอบ)
import { json, originOk, readBody, verifyIdToken, thaRoleOf, commit, wIncrement, tgSend } from '../_lib/tha-auth.js';
import { revokeAgainRun, clearAllDevices } from '../_lib/tha-guard.js';

const HOOK_URL = 'https://thanasetsiri2546.pages.dev/api/tg-webhook';   // ตายตัว ไม่อ่านจาก request

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    if (!originOk(request, env)) return json({ ok: false, error: 'origin' }, 403);
    const tok = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const role = await thaRoleOf(env, await verifyIdToken(env, tok, { checkRevoked: true }));
    if (role !== 'admin') return json({ ok: false, error: 'forbidden' }, 403);
    const body = await readBody(request, 200);
    const action = body && body.action;
    // จำกัด 20 ครั้ง/นาที
    const min = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 16).replace(/[-T:]/g, '');
    const rc = await commit(env, null, [wIncrement(env, 'tha_login_guard/_adminops_' + min, 'n', 1)]);
    const t = rc.writeResults && rc.writeResults[0] && rc.writeResults[0].transformResults && rc.writeResults[0].transformResults[0];
    if (t && Number(t.integerValue) > 20) return json({ ok: false, error: 'rate' }, 429);

    if (action === 'status') return json({ ok: true, revoke: await revokeAgainRun(env, { statusOnly: true }), unlockEnabled: env.TG_UNLOCK_ENABLED === '1' });   // ตรวจ Firebase จริง ไม่ซ่อม
    if (action === 'revoke-again') return json({ ok: true, revoke: await revokeAgainRun(env) });
    if (action === 'clear-devices') {
      await clearAllDevices(env);
      await tgSend(env, '🧹 แอปท่าทราย: admin ล้างเครื่องที่จำไว้ทั้งหมดแล้ว — ทุกเครื่องต้องกด PIN ใหม่ และนับเป็นเครื่องแปลกจนกว่าจะเข้าได้');
      return json({ ok: true });
    }
    if (action === 'set-webhook') {
      const sec = env.TG_WEBHOOK_SECRET || '';
      if (sec.length < 16 || !env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: 'secret not set' }, 400);
      const base = 'https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN;
      const t0 = Math.floor(Date.now() / 1000);
      const r1 = await fetch(base + '/setWebhook', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: HOOK_URL, secret_token: sec, allowed_updates: ['message', 'callback_query'] }) });
      const j1 = await r1.json().catch(function () { return {}; });
      const r2 = await fetch(base + '/getWebhookInfo');
      const j2 = await r2.json().catch(function () { return {}; });
      const info = j2.result || {};
      const setOk = !!j1.ok && !!j2.ok && info.url === HOOK_URL && Array.isArray(info.allowed_updates) && info.allowed_updates.indexOf('callback_query') >= 0;
      const errAfter = Number(info.last_error_date || 0) >= t0;      // error ที่เกิดหลังตั้งค่ารอบนี้
      const good = setOk && !errAfter;
      // ตั้งค่าแล้ว ≠ ใช้งานได้: ต้องทดสอบส่งคำสั่ง "เมนู" ในกลุ่มต่ออีกครั้ง (ใบขั้นตอน)
      return json({ ok: good, setOk: setOk, errorAfterSet: errAfter, info: { url: info.url || '', allowed_updates: info.allowed_updates || [], last_error_message: info.last_error_message || '', pending: info.pending_update_count || 0 } }, good ? 200 : 502);
    }
    return json({ ok: false, error: 'bad action' }, 400);
  } catch (e) {
    return json({ ok: false, error: 'server' }, 500);
  }
}
export async function onRequestGet() { return json({ ok: false, error: 'use POST' }, 405); }
