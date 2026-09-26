// ============================================================
// /api/payday-reminder — เตือนวันจ่ายเงินเดือนเข้า Telegram (22 ก.ย. 2569)
// ยิงเมื่อครบ 3 ข้อ:
//   1) วันนี้ (เวลาไทย) = วันที่ 15 หรือ วันสุดท้ายของเดือน
//   2) มีใบลงเวลาของวันนี้ใน attendance อย่างน้อย 1 ใบ  (= พนักงานลงเวลาแล้ว)
//   3) ยังไม่เคยส่งของวันนี้ (app_meta/notify_payday.lastSent)
// ยอดเงิน = สูตรเดียวกับหน้า "สรุปเงินเดือน (ตามงวด)" ช่องเงินสดต้องเตรียมจ่ายงวดนี้
//   รอรับงวดนี้ = ค่าแรงงวด − ปกส (เฉพาะงวดสิ้นเดือน) − เบิกที่จ่ายล่วงหน้าไปแล้ว
//   นับเฉพาะคนที่ยอดเป็นบวก (คนติดลบไม่นับ)
// 26 ก.ย. 2569: เพิ่มรายชื่อ + ยอดที่ต้องรับรายคน และรายชื่อคนติดลบ (กลุ่มมีแต่เจ้าของ)
// ?force=1 บังคับส่ง (ไว้ทดสอบ) · ?debug=1 ไม่ส่ง คืน JSON ให้ดู · ?date=YYYY-MM-DD ย้อนวัน
// ============================================================

const GROUP_CHAT_ID = '-5450363615';
const FB_API_KEY = 'AIzaSyAaxKbw-MKrsVnCEw6IY_cYkiWsp1Ql8SA'; // public apiKey
const FB_PROJECT = 'thanasetsiri2546-20cb6';
const SOCIAL = 875;            // ปกส ต่อเดือน (ตรงกับในแอป)
const FS = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;
const TH_MONTH = ['', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
let GLOBAL_ENV = {};
let ERRS = [];

export async function onRequestGet(context) { return handle(context); }
export async function onRequestPost(context) { return handle(context); }

async function handle(context) {
  const { request, env } = context;
  GLOBAL_ENV = env;
  ERRS = [];
  const url = new URL(request.url);
  const force = url.searchParams.get('force') === '1';
  const debug = url.searchParams.get('debug') === '1';
  const dateQ = url.searchParams.get('date');
  try {
    const token = env.TELEGRAM_BOT_TOKEN;
    if (!token && !debug) return json({ ok: false, error: 'no token' }, 500);

    const today = dateQ || bkkDate();
    const ym = today.slice(0, 7);
    const day = parseInt(today.slice(8, 10), 10);
    const last = daysInMonth(ym);

    // ── ข้อ 1: ต้องเป็นวันที่ 15 หรือวันสุดท้ายของเดือน ──
    const isPayday = (day === 15) || (day === last);
    if (!isPayday && !force) return json({ ok: true, skipped: 'ไม่ใช่วันที่ 15 หรือวันสิ้นเดือน (' + today + ')' });
    const period = (day === 15) ? '1-15' : '16-end';

    const idToken = await login();

    // ── ข้อ 3: กันส่งซ้ำ (ใช้ doc แยกจากสรุปรายวัน) ──
    if (!force && !debug) {
      const meta = await getDoc(idToken, 'app_meta', 'notify_payday').catch(function () { return null; });
      if (meta && fval(meta, 'lastSent') === today) return json({ ok: true, skipped: 'ส่งไปแล้ววันนี้ ' + today });
    }

    // ── ข้อ 2: ต้องมีใบลงเวลาของวันนี้ ──
    const attToday = await qEq(idToken, 'attendance', 'date', today);
    if (!attToday.length && !force) return json({ ok: true, skipped: 'ยังไม่มีใบลงเวลาของวันนี้' });

    const out = await buildMessage(idToken, ym, period, day, last);
    if (debug) return json({ ok: true, date: today, period, attToday: attToday.length, errors: ERRS, rows: out.rows, text: out.text });

    await tgSend(token, GROUP_CHAT_ID, out.text);
    await setDoc(idToken, 'app_meta', 'notify_payday', {
      lastSent: { stringValue: today }, sentAt: { stringValue: new Date().toISOString() }
    }).catch(function () {});
    return json({ ok: true, sent: today, period, cash: out.cash, people: out.people, negative: out.negative, errors: ERRS });
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e), errors: ERRS }, 500);
  }
}

async function buildMessage(idToken, ym, period, day, last) {
  const res = await Promise.all([
    qAll(idToken, 'employees'),
    qEq(idToken, 'attendance', 'month', ym),
    qEq(idToken, 'withdrawals', 'month', ym)
  ]);
  const emps = res[0], atts = res[1], wds = res[2];

  // attendance → map key "YYYY-MM-DD_empId"
  const att = {};
  atts.forEach(function (d) {
    const k = (fval(d, 'date') || '') + '_' + (fval(d, 'empId') || '');
    att[k] = { type: fval(d, 'type'), hours: fval(d, 'hours') || 0, special: sumSpecial(d) };
  });

  const start = (period === '1-15') ? 1 : 16;
  const end = (period === '1-15') ? 15 : last;
  const days = daysInMonth(ym);

  let cash = 0, people = 0, negative = 0;
  const rows = [];
  emps.forEach(function (e) {
    if (!fval(e, 'active')) return;             // ตรงกับแอป (active ต้องเป็นจริง)
    const id = docId(e);
    const type = fval(e, 'type'), rate = fval(e, 'rate') || 0;

    let earned = 0;
    for (let d = start; d <= end; d++) {
      const r = att[ym + '-' + pad(d) + '_' + id];
      if (!r || !r.type || r.type === 'absent') continue;
      let base = 0;
      const unit = (type === 'daily') ? rate : (rate / days);
      if (r.type === 'full') base = unit;
      else if (r.type === 'half') base = unit / 2;
      else if (r.type === 'hours') base = unit * ((r.hours || 0) / 8);
      earned += Math.round((base + (r.special || 0)) * 100) / 100;
    }
    earned = Math.round(earned * 100) / 100;

    let taken = 0;
    wds.forEach(function (w) {
      if (fval(w, 'empId') === id && fval(w, 'period') === period) taken += fval(w, 'amount') || 0;
    });

    const social = (period === '16-end' && fval(e, 'socialSecurity') === true) ? SOCIAL : 0;
    const pending = Math.round((earned - social - taken) * 100) / 100;
    if (earned <= 0 && taken <= 0) return;      // ไม่มีความเคลื่อนไหวในงวดนี้ = ไม่นับ (ตรงกับหน้าจอ)
    people++;
    if (pending < 0) negative++;
    else cash += pending;
    rows.push({ id: id, name: fval(e, 'nickname') || id, earned: earned, social: social, taken: taken, pending: pending });
  });
  cash = Math.round(cash * 100) / 100;

  const mth = parseInt(ym.slice(5, 7), 10);
  const label = (period === '1-15')
    ? 'งวดที่ 1 (1–15 ' + TH_MONTH[mth] + ')'
    : 'งวดที่ 2 (16–' + last + ' ' + TH_MONTH[mth] + ')';

  const L = [];
  L.push('💰 <b>ถึงวันจ่ายเงินเดือน — ' + label + '</b>');
  L.push('');
  L.push('เงินสดต้องเตรียม   <b>' + fmt(cash) + ' บาท</b>');
  L.push('ต้องจ่าย            ' + rows.filter(function (r) { return r.pending > 0; }).length + ' คน');
  const sorted = rows.slice().sort(function (a, b) { return String(a.id).localeCompare(String(b.id)); });
  const pos = sorted.filter(function (r) { return r.pending > 0; });
  const neg = sorted.filter(function (r) { return r.pending < 0; });
  if (pos.length) {
    L.push('');
    L.push('<b>รายชื่อ · ยอดที่ต้องรับ</b>');
    pos.forEach(function (r) { L.push(esc(r.name) + '   ' + fmt(r.pending)); });
  }
  if (neg.length) {
    L.push('');
    L.push('<b>ติดลบ ไม่ต้องจ่ายงวดนี้ (' + neg.length + ' คน)</b>');
    neg.forEach(function (r) { L.push(esc(r.name) + '   −' + fmt(-r.pending)); });
  }
  L.push('');
  L.push('เปิดแอป → เงินเดือน → สรุปเงินเดือน (ตามงวด)');
  if (ERRS.length) {
    L.push('');
    L.push('⚠️ <b>อ่านข้อมูลไม่ครบ — ตัวเลขอาจไม่ตรง</b>');
    ERRS.slice(0, 4).forEach(function (e) { L.push('   • ' + e); });
  }

  return { text: L.join('\n'), cash: cash, people: people, negative: negative, rows: rows };
}

// ---------- Firestore ----------
async function login() {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FB_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: GLOBAL_ENV.FB_EMAIL, password: GLOBAL_ENV.FB_PASSWORD, returnSecureToken: true })
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
async function qEq(idToken, coll, field, value) {
  try {
    return await runQuery(idToken, {
      from: [{ collectionId: coll }],
      where: { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: { stringValue: value } } }
    });
  } catch (e) { ERRS.push(coll + ' → ' + ((e && e.message) || e)); return []; }
}
async function qAll(idToken, coll) {
  try { return await runQuery(idToken, { from: [{ collectionId: coll }] }); }
  catch (e) { ERRS.push(coll + ' → ' + ((e && e.message) || e)); return []; }
}
async function getDoc(idToken, coll, id) {
  const r = await fetch(`${FS}/${coll}/${encodeURIComponent(id)}`, { headers: { 'Authorization': 'Bearer ' + idToken } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('get fail ' + r.status);
  return await r.json();
}
async function setDoc(idToken, coll, id, fields) {
  const r = await fetch(`${FS}/${coll}/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
    body: JSON.stringify({ fields })
  });
  if (!r.ok) throw new Error('write fail ' + r.status);
}
function esc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
async function tgSend(token, chatId, text) {
  const r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true })
  });
  let j = null; try { j = await r.json(); } catch (e) {}
  if (!r.ok || !j || !j.ok) throw new Error('telegram send fail ' + r.status + ' ' + ((j && j.description) || ''));   // ไม่บันทึกว่าส่งแล้ว → รอบ 15:00 ลองใหม่
}

// ---------- helpers ----------
function fval(doc, f) {
  const v = doc.fields && doc.fields[f]; if (!v) return undefined;
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('integerValue' in v) return Number(v.integerValue);
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  return undefined;
}
function sumSpecial(doc) {   // specialWork: [{name, amount}]
  const v = doc.fields && doc.fields.specialWork;
  const arr = v && v.arrayValue && v.arrayValue.values;
  if (!arr || !arr.length) return 0;
  let s = 0;
  arr.forEach(function (it) {
    const f = it.mapValue && it.mapValue.fields && it.mapValue.fields.amount;
    if (!f) return;
    if ('doubleValue' in f) s += Number(f.doubleValue);
    else if ('integerValue' in f) s += Number(f.integerValue);
  });
  return s;
}
function docId(doc) { const p = doc.name.split('/'); return p[p.length - 1]; }
function bkkDate() { return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10); }
function daysInMonth(ym) { const p = ym.split('-'); return new Date(Number(p[0]), Number(p[1]), 0).getDate(); }
function pad(n) { return (n < 10 ? '0' : '') + n; }
function fmt(n) { return Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
}
