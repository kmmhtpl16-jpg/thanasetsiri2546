// ============================================================
// ตัวช่วยฝั่งเซิร์ฟเวอร์: ล็อกอินด้วย PIN ที่ตรวจบนเซิร์ฟเวอร์ (งานแก้รหัสฝังหน้าเว็บ · 23 พ.ย. 69)
// แบบ: _ย้ายรุ่งชัย\แบบ-0-แก้PINท่าทราย.md (Codex r6 ผ่าน)
//
// ค่าที่ต้องตั้งใน Cloudflare (ห้ามใส่ในไฟล์นี้):
//   FB_SA_KEY      = JSON ของ service account (secret)
//   PIN_PEPPER     = สตริงสุ่มยาว (secret) — ใช้คู่กับ salt ใน Firestore tha_auth/{role}
//   THA_UID_ADMIN  = uid ของ admin@sand.local   (ไม่ลับ แต่ตั้งที่ Cloudflare เพื่อไม่ผูกในโค้ด)
//   THA_UID_STAFF  = uid ของ staff@sand.local
//   PIN_SETUP_KEY  = (ชั่วคราว) ใช้ตอนตั้ง PIN ครั้งแรกเท่านั้น ตั้งเสร็จให้ลบทิ้ง
// ห้าม log PIN / token / กุญแจ
// ============================================================

export const FB_PROJECT = 'thanasetsiri2546-20cb6';
// โดเมนหลักตรงตัวเท่านั้น (ไม่รับ subdomain preview · ห้ามย้ายโดเมนในงานนี้ — แบบ r27 ข้อ 7)
const ORIGIN_RE = /^https:\/\/thanasetsiri2546\.pages\.dev$/;
const TOKEN_AUD_CUSTOM = 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';
const JWK_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

// ไม่มีโหมดทดสอบในโค้ดนี้ — ปลายทางเป็นของจริงเสมอ (ชุดทดสอบดักปลายทางจากภายนอกเอง)
function fsBase(env) { return 'https://firestore.googleapis.com/v1/projects/' + FB_PROJECT + '/databases/(default)/documents'; }
function idtBase(env) { return 'https://identitytoolkit.googleapis.com'; }

// ---------- คำตอบ ----------
export function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}
export function originOk(request, env) {
  const o = request.headers.get('Origin') || '';
  return ORIGIN_RE.test(o);
}
export async function readBody(request, maxBytes) {
  const cl = Number(request.headers.get('Content-Length') || 0);
  if (cl > maxBytes) return null;
  if (!request.body) return null;
  const rd = request.body.getReader();
  const parts = []; let n = 0;
  for (;;) {
    const x = await rd.read();
    if (x.done) break;
    n += x.value.byteLength;
    if (n > maxBytes) { try { await rd.cancel(); } catch (e) {} return null; }
    parts.push(x.value);
  }
  const all = new Uint8Array(n); let o = 0;
  parts.forEach(function (c) { all.set(c, o); o += c.byteLength; });
  try { return JSON.parse(new TextDecoder().decode(all)); } catch (e) { return null; }
}
export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || '0.0.0.0';
}

// ---------- base64url / hash ----------
const te = new TextEncoder();
function b64url(bytes) {
  let s = ''; const a = new Uint8Array(bytes);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlJson(o) { return b64url(te.encode(JSON.stringify(o))); }
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  const bin = atob(s); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function hex(buf) { return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join(''); }
export async function sha256hex(s) { return hex(await crypto.subtle.digest('SHA-256', te.encode(s))); }
export function safeEq(a, b) {
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  return d === 0;
}
export async function pinHash(env, salt, pin) {
  if (!env.PIN_PEPPER || env.PIN_PEPPER.length < 32) throw new Error('PIN_PEPPER not set');
  const k = await crypto.subtle.importKey('raw', te.encode(env.PIN_PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, te.encode(salt + ':' + pin)));
}
// เลขรุ่น PIN: สุ่ม 52 บิต (ไม่ขึ้นกับนาฬิกา · โอกาสซ้ำของเดิมแทบเป็นศูนย์ แม้ลบแล้วตั้งใหม่)
export function randomVer() {
  const a = new Uint32Array(2); crypto.getRandomValues(a);
  return (a[0] & 0xfffff) * 4294967296 + a[1] + 1;
}
export function randomHex(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return hex(a); }
export function randomPin() {
  // ตัวเลข 6 หลักแบบสุ่มสม่ำเสมอ (ตัดค่าที่ทำให้เอียง)
  const a = new Uint32Array(1);
  for (;;) { crypto.getRandomValues(a); if (a[0] < 4294000000) return String(a[0] % 1000000).padStart(6, '0'); }
}
export function weakPin(p) {
  if (!/^\d{6}$/.test(p)) return true;
  if (/^(\d)\1{5}$/.test(p)) return true;
  const up = '0123456789012', dn = '9876543210987';
  return up.indexOf(p) >= 0 || dn.indexOf(p) >= 0;
}

// ---------- service account ----------
function saKey(env) {
  if (!env.FB_SA_KEY) throw new Error('FB_SA_KEY not set');
  const k = JSON.parse(env.FB_SA_KEY);
  if (!k.client_email || !k.private_key) throw new Error('FB_SA_KEY invalid');
  return k;
}
async function importPkcs8(pem) {
  const b = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(b), function (c) { return c.charCodeAt(0); });
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}
async function signJwt(env, payload) {
  const k = saKey(env);
  const head = b64urlJson({ alg: 'RS256', typ: 'JWT' });
  const body = b64urlJson(payload);
  const key = await importPkcs8(k.private_key);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, te.encode(head + '.' + body));
  return head + '.' + body + '.' + b64url(sig);
}
let _at = null; // { token, exp }
export async function accessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (_at && _at.exp - 120 > now) return _at.token;
  const k = saKey(env);
  const assertion = await signJwt(env, {
    iss: k.client_email, sub: k.client_email, aud: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/firebase',
    iat: now, exp: now + 3600
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + assertion
  });
  const j = await r.json().catch(function () { return {}; });
  if (!j.access_token) throw new Error('sa token fail ' + r.status);
  _at = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  return _at.token;
}
// custom token: uid เดิมของบัญชี + claim บทบาท (developer claims)
// expSec (ไม่บังคับ): เวลาหมดอายุแบบกำหนดเอง (วินาที) — /api/login ใช้ = เวลา commit + 5 นาที (แบบ r27 ข้อ 2.5)
export async function customToken(env, uid, claims, expSec) {
  const k = saKey(env);
  const now = Math.floor(Date.now() / 1000);
  const exp = expSec ? Math.min(expSec, now + 3600) : now + 3600;
  if (exp <= now) throw new Error('token expired before issue');
  return signJwt(env, { iss: k.client_email, sub: k.client_email, aud: TOKEN_AUD_CUSTOM, iat: now, exp: exp, uid: uid, claims: claims });
}

// ---------- ตรวจ Firebase ID token ----------
let _jwk = null; // { keys, exp }
async function jwks() {
  const now = Date.now();
  if (_jwk && _jwk.exp > now) return _jwk.keys;
  const r = await fetch(JWK_URL);
  if (!r.ok) throw new Error('jwks fetch ' + r.status);
  const j = await r.json();
  const m = /max-age=(\d+)/.exec(r.headers.get('cache-control') || '');
  _jwk = { keys: j.keys || [], exp: now + (m ? Math.min(+m[1], 21600) : 3600) * 1000 };
  return _jwk.keys;
}
// คืน payload ถ้าบัตรถูกต้อง · ไม่ถูก = null
export async function verifyIdToken(env, token, opts) {
  opts = opts || {};
  if (typeof token !== 'string' || token.length > 4096) return null;
  const parts = token.split('.'); if (parts.length !== 3) return null;
  let head, p;
  try { head = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0]))); p = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]))); }
  catch (e) { return null; }
  const now = Math.floor(Date.now() / 1000);
  if (head.alg !== 'RS256' || typeof head.kid !== 'string') return null;
  const jwk = (await jwks()).find(function (k) { return k.kid === head.kid; });
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const sigOk = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlDecode(parts[2]), te.encode(parts[0] + '.' + parts[1]));
  if (!sigOk) return null;
  if (p.aud !== FB_PROJECT || p.iss !== 'https://securetoken.google.com/' + FB_PROJECT) return null;
  if (typeof p.sub !== 'string' || !p.sub || p.sub.length > 128) return null;
  if (!(p.exp > now) || !(p.iat <= now + 300) || !(p.auth_time <= now + 300)) return null;
  if (opts.checkRevoked) {
    const u = await lookupUser(env, p.sub);
    // ผู้ใช้ไม่มีแล้ว / ถูกปิด / ล็อกอินก่อนเวลาที่สั่งตัด → ไม่ผ่าน (เทียบ auth_time เหมือน Firebase Admin)
    if (!u || u.disabled || p.auth_time < Number(u.validSince || 0)) return null;
  }
  return p;
}
export async function lookupUser(env, uid) {
  const at = await accessToken(env);
  const r = await fetch(idtBase(env) + '/v1/projects/' + FB_PROJECT + '/accounts:lookup', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + at },
    body: JSON.stringify({ localId: [uid] })
  });
  const j = await r.json().catch(function () { return {}; });
  return (j.users && j.users[0]) || null;
}
// ตัด refresh token ทุกเครื่องของ uid (บัตรที่ออกแล้วหมดอายุเองภายใน 1 ชม.)
// ตั้งเวลาตัด = "ตอนนี้" เสมอ · คืนเวลาตัด (วินาที) ที่ส่งไป
// ข้อจำกัดของ Firebase: ไม่มีการเขียนแบบ "ต้องมากกว่าค่าเดิม" → คำขอที่ค้างในเครือข่ายแล้วไปถึงทีหลังอาจเขียนค่าที่เก่ากว่าทับได้
//   → revoke ซ้ำ "ตรวจและซ่อม" ทุกรอบ (tha-guard revokeAgainRun: เทียบ validSince จริงกับเวลาตัดที่บันทึกไว้)
export async function revokeUid(env, uid) {
  const at = await accessToken(env);
  const since = Math.floor(Date.now() / 1000);
  const r = await fetch(idtBase(env) + '/v1/projects/' + FB_PROJECT + '/accounts:update', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + at },
    body: JSON.stringify({ localId: uid, validSince: String(since) })
  });
  if (!r.ok) throw new Error('revoke fail ' + r.status);
  return since;
}
export function roleUids(env) {
  const a = env.THA_UID_ADMIN || '', s = env.THA_UID_STAFF || '';
  if (!a || !s || a === s) throw new Error('THA_UID_* not set');
  return { admin: a, staff: s };
}
// บัตรของหน้าเว็บท่าทราย: uid ต้องตรงบทบาท · ป้ายต้องตรง · เลขรุ่น PIN (pv) ต้องตรงกับปัจจุบัน
// (เปลี่ยน PIN = เลขรุ่นขึ้น → บัตรเก่าทุกใบใช้ไม่ได้ทันที ทั้ง API และกฎ Firestore)
export async function thaRoleOf(env, payload) {
  if (!payload) return null;
  const u = roleUids(env);
  let role = null;
  if (payload.sub === u.admin && payload.tha_role === 'admin') role = 'admin';
  else if (payload.sub === u.staff && payload.tha_role === 'staff') role = 'staff';
  if (!role || !Number.isInteger(payload.pv)) return null;
  const at = await accessToken(env);
  const r = await fetch(fsBase(env) + '/tha_auth/' + role, { headers: { Authorization: 'Bearer ' + at } });
  if (!r.ok) return null;
  const d = await r.json().catch(function () { return null; });
  return Number(fv(d, 'ver')) === payload.pv ? role : null;
}

// ---------- Firestore REST (service account ข้าม rules) ----------
function toFs(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  return { stringValue: String(v) };
}
export function fsFields(o) { const f = {}; Object.keys(o).forEach(function (k) { f[k] = toFs(o[k]); }); return f; }
export function fv(doc, f) {
  const v = doc && doc.fields && doc.fields[f]; if (!v) return undefined;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  return undefined;
}
export function docName(env, path) { return fsBase(env).replace(/^https?:\/\/[^/]+\/v1\//, '') + '/' + path; }
async function fsCall(env, method, url, body) {
  const at = await accessToken(env);
  const r = await fetch(url, {
    method: method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + at },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(function () { return {}; });
  return { status: r.status, body: j };
}
export async function txBegin(env) {
  const r = await fsCall(env, 'POST', fsBase(env) + ':beginTransaction', { options: { readWrite: {} } });
  if (!r.body.transaction) throw new Error('tx begin ' + r.status);
  return r.body.transaction;
}
// อ่านหลายเอกสารในธุรกรรม · คืน { path: doc|null }
export async function txGet(env, tx, paths) {
  const uniq = paths.filter(function (p, i) { return paths.indexOf(p) === i; });
  const r = await fsCall(env, 'POST', fsBase(env) + ':batchGet', { documents: uniq.map(function (p) { return docName(env, p); }), transaction: tx });
  if (r.status === 409 || r.status === 429 || r.status >= 500) throw new Error('ABORTED');
  if (r.status !== 200 || !Array.isArray(r.body)) throw new Error('batchGet ' + r.status);
  // ต้องได้คำตอบ found/missing ครบทุก path ครั้งเดียว · ไม่ครบ/ผิดรูป = error (ไม่ถือว่าเอกสารไม่มี)
  const out = {}, seen = {};
  r.body.forEach(function (x) {
    const name = (x.found && x.found.name) || x.missing || '';
    const p = uniq.find(function (q) { return name === docName(env, q); });
    if (!p || seen[p]) throw new Error('batchGet bad');
    seen[p] = true; out[p] = x.found || null;
  });
  if (uniq.some(function (p) { return !seen[p]; })) throw new Error('batchGet incomplete');
  return out;
}
// เขียนแบบ commit (ถ้ามี tx = ยืนยันธุรกรรม · ชนกัน = โยน error 'ABORTED')
export async function commit(env, tx, writes) {
  const body = { writes: writes }; if (tx) body.transaction = tx;
  const r = await fsCall(env, 'POST', fsBase(env) + ':commit', body);
  if (r.status === 409 || (r.body.error && r.body.error.status === 'ABORTED')) throw new Error('ABORTED');
  if (r.status !== 200) throw new Error('commit ' + r.status + ' ' + ((r.body.error && r.body.error.status) || ''));
  return r.body;
}
export async function rollback(env, tx) {
  try { await fsCall(env, 'POST', fsBase(env) + ':rollback', { transaction: tx }); } catch (e) {}
}
export function wUpdate(env, path, obj, opts) {
  const w = { update: { name: docName(env, path), fields: fsFields(obj) } };
  if (opts && opts.mask) w.updateMask = { fieldPaths: Object.keys(obj) };   // เขียนเฉพาะช่องที่ระบุ ไม่ลบช่องอื่น
  if (opts && opts.mustExist) w.currentDocument = { exists: true };
  if (opts && opts.mustNotExist) w.currentDocument = { exists: false };
  if (opts && opts.updateTime) w.currentDocument = { updateTime: opts.updateTime };
  return w;
}
export function wDelete(env, path) { return { delete: docName(env, path) }; }
// อ่านเอกสารเดียวนอกธุรกรรม · ไม่มี = null · อ่านไม่ได้ = โยน error
export async function getDocSA(env, path) {
  const r = await fsCall(env, 'GET', fsBase(env) + '/' + path);
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error('get ' + r.status);
  return r.body;
}
export function wIncrement(env, path, field, by) {
  return { transform: { document: docName(env, path), fieldTransforms: [{ fieldPath: field, increment: { integerValue: String(by) } }] } };
}
// ชนกัน = ลองใหม่โดยรอสุ่ม (ค่าเริ่ม 8 ครั้ง) · ยังไม่ได้ = โยน error ให้ปฏิเสธคำขอ (ไม่เปิดทาง)
export async function withTx(env, fn, maxTry) {
  const n = maxTry || 8;
  for (let i = 0; i < n; i++) {
    const tx = await txBegin(env);
    try { return await fn(tx); }
    catch (e) {
      await rollback(env, tx);
      if (String(e && e.message) !== 'ABORTED' || i === n - 1) throw e;
      await new Promise(function (s) { setTimeout(s, 40 + Math.floor(Math.random() * 120 * (i + 1))); });
    }
  }
}

// ตัวจำกัดการเดา PIN ย้ายไป _lib/tha-guard.js (แบบ r27)

// ---------- Telegram (กลุ่มแจ้งเตือนท่าทรายเดิม) ----------
export const GROUP_CHAT_ID = '-5450363615';
export async function tgSend(env, text, extra) {
  if (!env.TELEGRAM_BOT_TOKEN) return false;
  try {
    const r = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ chat_id: GROUP_CHAT_ID, text: String(text).slice(0, 3500), parse_mode: 'HTML', disable_web_page_preview: true }, extra || {}))
    });
    const j = await r.json().catch(function () { return {}; });
    return !!j.ok;
  } catch (e) { return false; }
}
