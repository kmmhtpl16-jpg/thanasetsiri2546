// ============================================================
// /api/daily-summary — สรุปประจำวันเข้า Telegram (ยิงด้วย cron ฝั่งเซิร์ฟเวอร์)
// อ่าน Firestore ด้วยบัญชี admin (FB_EMAIL/FB_PASSWORD env — ชุดเดียวกับ tg-webhook)
// รายได้ทุกช่องทาง (ทราย + ดิน/อื่น) + รายจ่าย + คงเหลือ
// กันซ้ำวันละครั้งด้วย app_meta/notify_daily.lastSent — ต่อท้าย ?force=1 เพื่อบังคับส่ง
// ============================================================

const GROUP_CHAT_ID = '-5450363615';
const FB_API_KEY = 'AIzaSyAaxKbw-MKrsVnCEw6IY_cYkiWsp1Ql8SA'; // public apiKey (มีในแอปอยู่แล้ว)
const FB_PROJECT = 'thanasetsiri2546-20cb6';
const KPC = 1500; // 1 คิว = 1,500 กก.
const FS = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;
let GLOBAL_ENV = {};

export async function onRequestGet(context) { return handle(context); }
export async function onRequestPost(context) { return handle(context); }

async function handle(context) {
  const { request, env } = context;
  GLOBAL_ENV = env;
  const url = new URL(request.url);
  const force = url.searchParams.get('force') === '1';
  try {
    const token = env.TELEGRAM_BOT_TOKEN;
    if (!token) return json({ ok: false, error: 'no token' }, 500);
    const today = bkkDate();
    const idToken = await login();
    if (!force) {
      const meta = await getDoc(idToken, 'app_meta', 'notify_daily').catch(function () { return null; });
      if (meta && fval(meta, 'lastSent') === today) return json({ ok: true, skipped: 'already sent ' + today });
    }
    const text = await buildSummary(idToken, today);
    await tgSend(token, GROUP_CHAT_ID, text);
    await setDoc(idToken, 'app_meta', 'notify_daily', {
      lastSent: { stringValue: today }, sentAt: { stringValue: new Date().toISOString() }
    }).catch(function () {});
    return json({ ok: true, sent: today });
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e) }, 500);
  }
}

// วันที่ตามเวลาไทย (UTC+7)
function bkkDate() { return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10); }

async function login() {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FB_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: GLOBAL_ENV.FB_EMAIL, password: GLOBAL_ENV.FB_PASSWORD, returnSecureToken: true })
  });
  const j = await r.json();
  if (!j.idToken) throw new Error('login fail');
  return j.idToken;
}
async function runQuery(idToken, structuredQuery) {
  const r = await fetch(`${FS}:runQuery`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
    body: JSON.stringify({ structuredQuery })
  });
  const arr = await r.json();
  if (!Array.isArray(arr)) throw new Error('query fail');
  return arr.filter(function (x) { return x.document; }).map(function (x) { return x.document; });
}
async function qDate(idToken, coll, today) {
  try {
    return await runQuery(idToken, {
      from: [{ collectionId: coll }],
      where: { fieldFilter: { field: { fieldPath: 'date' }, op: 'EQUAL', value: { stringValue: today } } }
    });
  } catch (e) { return []; }
}
async function qAll(idToken, coll) {
  try { return await runQuery(idToken, { from: [{ collectionId: coll }] }); } catch (e) { return []; }
}

async function buildSummary(idToken, today) {
  const res = await Promise.all([
    qDate(idToken, 'withdrawals', today),
    qDate(idToken, 'expenses', today),
    qDate(idToken, 'fuel_in', today),
    qDate(idToken, 'fuel_expense', today),
    qDate(idToken, 'weighings', today),
    qDate(idToken, 'os_bills', today),
    qAll(idToken, 'deductions')
  ]);
  const wd = res[0], ex = res[1], fin = res[2], fexp = res[3], weigh = res[4], obills = res[5], deds = res[6];

  let wdTot = 0, wdN = 0; wd.forEach(function (d) { wdTot += fval(d, 'amount') || 0; wdN++; });
  let exTot = 0, exN = 0; ex.forEach(function (d) { exTot += fval(d, 'amount') || 0; exN++; });
  let fiL = 0; fin.forEach(function (d) { fiL += fval(d, 'liters') || 0; });
  let feTot = 0, feN = 0; fexp.forEach(function (d) { feTot += fval(d, 'total_amount') || 0; feN++; });

  // ตัวหักน้ำหนัก (doc id = weighing id, field cubic)
  const dMap = {}; deds.forEach(function (d) { dMap[docId(d)] = fval(d, 'cubic') || 0; });

  // รายได้ขายทราย (ตาชั่ง × ราคา)
  let sandRev = 0;
  weigh.forEach(function (w) {
    const id = docId(w);
    const net = Math.max(0, ((fval(w, 'kg') || 0) / KPC) - (dMap[id] || 0));
    const unit = fval(w, 'sale_unit');
    if (unit === 'เหมา') { sandRev += fval(w, 'sale_amount') || 0; return; }
    const price = fval(w, 'price') || 0; if (price <= 0) return;
    const qty = (unit === 'ตัก') ? (fval(w, 'scoop') || 0) : ((unit === 'ตัน') ? net * 1.5 : net);
    sandRev += qty * price;
  });
  sandRev = Math.round(sandRev * 100) / 100;

  // รายได้ขายดิน/อื่น (os_bills) แยกช่องทาง
  let osCash = 0, osTrans = 0, osCredit = 0;
  obills.forEach(function (b) {
    if (fval(b, 'status') === 'cancelled') return;
    const amt = fval(b, 'grandTotal') || 0;
    const pay = fval(b, 'pay');
    if (pay === 'transfer') osTrans += amt;
    else if (pay === 'credit') osCredit += amt;
    else osCash += amt;
  });
  const dirtTot = osCash + osTrans + osCredit;
  const totalRev = sandRev + dirtTot;
  const received = sandRev + osCash + osTrans;   // เงินเข้าจริง (ไม่รวมลงบัญชี)
  const expTot = exTot + wdTot + feTot;
  const netCash = Math.round((received - expTot) * 100) / 100;

  const L = [];
  L.push('📊 <b>สรุปประจำวัน ' + beDate(today) + '</b>');
  L.push('━━━━━━━━━━━━');
  L.push('💰 <b>รายได้วันนี้</b>');
  L.push('  ⛏️ ขายทราย: ' + fmt(sandRev) + ' ฿');
  L.push('  🧱 ขายดิน/อื่น: ' + fmt(dirtTot) + ' ฿');
  if (osCash > 0) L.push('     · เงินสด ' + fmt(osCash));
  if (osTrans > 0) L.push('     · โอน ' + fmt(osTrans));
  if (osCredit > 0) L.push('     · ลงบัญชี ' + fmt(osCredit));
  L.push('  รวมรายได้: <b>' + fmt(totalRev) + ' ฿</b>');
  L.push('  (💵 เงินเข้าจริง ' + fmt(received) + ' · 📒 ค้างชำระ ' + fmt(osCredit) + ')');
  L.push('');
  L.push('💸 <b>รายจ่ายวันนี้</b>');
  L.push('  🧾 รายจ่ายทั่วไป: ' + fmt(exTot) + ' ฿ (' + exN + ' รายการ)');
  L.push('  👷 เบิกเงินเดือน: ' + fmt(wdTot) + ' ฿ (' + wdN + ' รายการ)');
  L.push('  ⛽ ค่าน้ำมันรถ: ' + fmt(feTot) + ' ฿ (' + feN + ' ครั้ง)');
  L.push('  รวมรายจ่าย: <b>' + fmt(expTot) + ' ฿</b>');
  L.push('━━━━━━━━━━━━');
  L.push('📈 <b>คงเหลือ (เงินเข้าจริง − รายจ่าย): ' + (netCash >= 0 ? '+' : '') + fmt(netCash) + ' ฿</b>');
  L.push('');
  L.push('ℹ️ รับน้ำมันเข้า ' + fmt(fiL) + ' ลิตร');
  return L.join('\n');
}

// ---------- helpers (แบบเดียวกับ tg-webhook.js) ----------
function fval(doc, f) {
  const v = doc.fields && doc.fields[f]; if (!v) return undefined;
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('integerValue' in v) return Number(v.integerValue);
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  return undefined;
}
function docId(doc) { const p = doc.name.split('/'); return p[p.length - 1]; }
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
async function tgSend(token, chatId, text) {
  await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true })
  });
}
function fmt(n) { return Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function beDate(ymd) { const p = ymd.split('-'); return parseInt(p[2]) + '/' + p[1] + '/' + (parseInt(p[0]) + 543); }
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
}
