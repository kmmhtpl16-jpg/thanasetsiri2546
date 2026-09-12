// ============================================================
// /api/rc-link — ช่องทางให้โปรแกรมค่าเที่ยว "รุ่งชัย น้ำโสม" ตรวจเทียบน้ำมันถังท่าทราย (11 ก.ย. 2569)
//
//   GET  ?from=YYYY-MM-DD&to=YYYY-MM-DD  → รายการ "เบิกน้ำมันจากถัง" (fuel_out) ในช่วงวันนั้น (ไม่เกิน 45 วัน)
//   POST {"text":"..."}                  → ส่งข้อความเข้ากลุ่ม "แจ้งเตือน : ท่าทราย"
//
// ทุกคำขอต้องแนบหัว  x-rc-key: <รหัส>
// ไฟล์นี้อยู่ใน repo สาธารณะ จึงเก็บแค่ sha256 ของรหัส — ตัวรหัสจริงอยู่ใน Supabase Vault ของรุ่งชัยที่เดียว
// (ชื่อ secret: thasai_link_key) ถ้าจะเปลี่ยนรหัส: สร้างใหม่ใน Vault แล้วเอา sha256 มาแทนบรรทัดข้างล่าง
//
// อ่านอย่างเดียว — ไม่เขียน Firestore เลย
// ============================================================

const KEY_SHA256 = '720726353aaa879b4fead42e27e8229c887c0f2c7a622640e8f0dccf9d8538fd';
const GROUP_CHAT_ID = '-5450363615';
const FB_API_KEY = 'AIzaSyAaxKbw-MKrsVnCEw6IY_cYkiWsp1Ql8SA'; // public apiKey
const FB_PROJECT = 'thanasetsiri2546-20cb6';
const FS = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;
const MAX_DAYS = 45;

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!(await authOk(request))) return json({ ok: false, error: 'unauthorized' }, 401);
  try {
    const url = new URL(request.url);
    const from = url.searchParams.get('from') || '';
    const to = url.searchParams.get('to') || from;
    if (!isYmd(from) || !isYmd(to) || from > to) return json({ ok: false, error: 'bad date range' }, 400);
    const days = (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000;
    if (days > MAX_DAYS) return json({ ok: false, error: 'range too long (max ' + MAX_DAYS + ' days)' }, 400);

    const idToken = await login(env);
    const docs = await runQuery(idToken, {
      from: [{ collectionId: 'fuel_out' }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: [
            { fieldFilter: { field: { fieldPath: 'date' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: from } } },
            { fieldFilter: { field: { fieldPath: 'date' }, op: 'LESS_THAN_OR_EQUAL', value: { stringValue: to } } }
          ]
        }
      }
    });
    const rows = docs.map(function (d) {
      return {
        id: docId(d),
        date: fval(d, 'date') || null,
        type: fval(d, 'type') || null,
        machine_id: fval(d, 'machine_id') || '',
        liters: Number(fval(d, 'liters') || 0),
        note: fval(d, 'note') || '',
        created_at: fval(d, 'created_at') || d.createTime || null
      };
    });
    return json({ ok: true, from: from, to: to, count: rows.length, rows: rows });
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e) }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await authOk(request))) return json({ ok: false, error: 'unauthorized' }, 401);
  try {
    const body = await request.json().catch(function () { return {}; });
    const text = ((body && body.text) || '').toString().trim();
    if (!text) return json({ ok: false, error: 'no text' }, 400);
    const token = env.TELEGRAM_BOT_TOKEN;
    if (!token) return json({ ok: false, error: 'no token' }, 500);
    const r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: GROUP_CHAT_ID, text: text.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true })
    });
    const data = await r.json().catch(function () { return {}; });
    return json({ ok: !!data.ok, description: data.description || null }, data.ok ? 200 : 502);
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e) }, 500);
  }
}

// ---------- helpers ----------
async function authOk(request) {
  const k = request.headers.get('x-rc-key') || '';
  if (k.length < 32) return false;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(k));
  const hex = Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  let diff = hex.length ^ KEY_SHA256.length;
  for (let i = 0; i < hex.length && i < KEY_SHA256.length; i++) diff |= hex.charCodeAt(i) ^ KEY_SHA256.charCodeAt(i);
  return diff === 0;
}
function isYmd(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s); }
async function login(env) {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FB_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.FB_EMAIL, password: env.FB_PASSWORD, returnSecureToken: true })
  });
  const j = await r.json();
  if (!j.idToken) throw new Error('login fail: ' + JSON.stringify((j && j.error && j.error.message) || j));
  return j.idToken;
}
async function runQuery(idToken, structuredQuery) {
  const r = await fetch(`${FS}:runQuery`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
    body: JSON.stringify({ structuredQuery })
  });
  const arr = await r.json();
  if (!Array.isArray(arr)) {
    const msg = (arr && arr.error && ((arr.error.status || '') + ' ' + (arr.error.message || ''))) || ('HTTP ' + r.status);
    throw new Error(msg.trim());
  }
  return arr.filter(function (x) { return x.document; }).map(function (x) { return x.document; });
}
function fval(doc, f) {
  const v = doc.fields && doc.fields[f]; if (!v) return undefined;
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('integerValue' in v) return Number(v.integerValue);
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('booleanValue' in v) return v.booleanValue;
  return undefined;
}
function docId(doc) { const p = doc.name.split('/'); return p[p.length - 1]; }
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}
