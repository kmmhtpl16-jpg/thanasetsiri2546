// ============================================================
// /api/daily-summary — v2 (9 ก.ย. 2569)
// เปลี่ยนจาก v1:
//   1) เพิ่มบล็อก "น้ำหนักขาย" (เที่ยว / คิว / ตัน / หักทรายเปียก / สุทธิ)
//   2) เพิ่มบล็อก "น้ำมัน" เต็ม (ค่าน้ำมันรถแยกทะเบียน + รับเข้า + เบิกออก)
//   3) เลิกกลืน error — ถ้าอ่าน Firestore ไม่ได้ จะขึ้น ⚠️ บอกสาเหตุจริงในข้อความ
//   4) โหมดตรวจ: ?debug=1  → ไม่ส่ง Telegram คืน JSON ให้ดูว่าแต่ละ collection ได้กี่แถว/error อะไร
//   5) ย้อนวันได้: ?date=2026-09-08
// ============================================================

const GROUP_CHAT_ID = '-5450363615';
const FB_API_KEY = 'AIzaSyAaxKbw-MKrsVnCEw6IY_cYkiWsp1Ql8SA'; // public apiKey
const FB_PROJECT = 'thanasetsiri2546-20cb6';
const KPC = 1500;              // 1 คิว = 1,500 กก.
const TON_PER_CUBIC = 1.5;     // 1 คิว = 1.5 ตัน (ตรงกับสูตรในแอป)
const FS = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;
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
    const idToken = await login();
    if (!force && !debug) {
      const meta = await getDoc(idToken, 'app_meta', 'notify_daily').catch(function () { return null; });
      if (meta && fval(meta, 'lastSent') === today) return json({ ok: true, skipped: 'already sent ' + today });
    }
    const out = await buildSummary(idToken, today);
    if (debug) return json({ ok: true, date: today, errors: ERRS, counts: out.counts, text: out.text });
    await tgSend(token, GROUP_CHAT_ID, out.text);
    await setDoc(idToken, 'app_meta', 'notify_daily', {
      lastSent: { stringValue: today }, sentAt: { stringValue: new Date().toISOString() }
    }).catch(function () {});
    return json({ ok: true, sent: today, errors: ERRS, counts: out.counts });
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e), errors: ERRS }, 500);
  }
}

function bkkDate() { return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10); }

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

// ⬇️ ไม่กลืน error แล้ว — เก็บไว้รายงาน
async function qDate(idToken, coll, today) {
  try {
    return await runQuery(idToken, {
      from: [{ collectionId: coll }],
      where: { fieldFilter: { field: { fieldPath: 'date' }, op: 'EQUAL', value: { stringValue: today } } }
    });
  } catch (e) { ERRS.push(coll + ' → ' + ((e && e.message) || e)); return []; }
}
async function qAll(idToken, coll) {
  try { return await runQuery(idToken, { from: [{ collectionId: coll }] }); }
  catch (e) { ERRS.push(coll + ' → ' + ((e && e.message) || e)); return []; }
}

async function buildSummary(idToken, today) {
  const res = await Promise.all([
    qDate(idToken, 'withdrawals', today),
    qDate(idToken, 'expenses', today),
    qDate(idToken, 'fuel_in', today),
    qDate(idToken, 'fuel_expense', today),
    qDate(idToken, 'weighings', today),
    qDate(idToken, 'os_bills', today),
    qAll(idToken, 'deductions'),
    qDate(idToken, 'fuel_out', today)
  ]);
  const wd = res[0], ex = res[1], fin = res[2], fexp = res[3], weigh = res[4], obills = res[5], deds = res[6], fout = res[7];

  let wdTot = 0, wdN = 0; wd.forEach(function (d) { wdTot += fval(d, 'amount') || 0; wdN++; });
  let exTot = 0, exN = 0; ex.forEach(function (d) { exTot += fval(d, 'amount') || 0; exN++; });

  // ── น้ำมัน ──
  let fiL = 0, fiB = 0; fin.forEach(function (d) { fiL += fval(d, 'liters') || 0; fiB += fval(d, 'total_amount') || 0; });
  let foL = 0; fout.forEach(function (d) { foL += fval(d, 'liters') || 0; });
  let feTot = 0, feL = 0, feN = 0;
  const byPlate = {};
  fexp.forEach(function (d) {
    const amt = fval(d, 'total_amount') || 0, lit = fval(d, 'liters') || 0;
    const p = fval(d, 'plate') || 'ไม่ระบุทะเบียน';
    feTot += amt; feL += lit; feN++;
    if (!byPlate[p]) byPlate[p] = { l: 0, b: 0 };
    byPlate[p].l += lit; byPlate[p].b += amt;
  });

  const dMap = {}; deds.forEach(function (d) { dMap[docId(d)] = fval(d, 'cubic') || 0; });

  // ── น้ำหนัก + รายได้ขายทราย ──
  let sandRev = 0, kgTot = 0, dedTot = 0, netQTot = 0, noPrice = 0;
  const byProd = {};
  weigh.forEach(function (w) {
    const id = docId(w);
    const kg = fval(w, 'kg') || 0;
    const ded = dMap[id] || 0;
    const net = Math.max(0, (kg / KPC) - ded);
    kgTot += kg; dedTot += ded; netQTot += net;
    const prod = fval(w, 'product') || 'ทราย';
    if (!byProd[prod]) byProd[prod] = { q: 0, n: 0 };
    byProd[prod].q += net; byProd[prod].n++;

    const unit = fval(w, 'sale_unit');
    if (unit === 'เหมา') { sandRev += fval(w, 'sale_amount') || 0; return; }
    const price = fval(w, 'price') || 0; if (price <= 0) { noPrice++; return; }
    const qty = (unit === 'ตัก') ? (fval(w, 'scoop') || 0) : ((unit === 'ตัน') ? net * TON_PER_CUBIC : net);
    sandRev += qty * price;
  });
  sandRev = Math.round(sandRev * 100) / 100;

  // ── ขายดิน/อื่น ──
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
  const received = sandRev + osCash + osTrans;
  const expTot = exTot + wdTot + feTot;
  const netCash = Math.round((received - expTot) * 100) / 100;

  const L = [];
  L.push('📊 <b>สรุปประจำวัน ' + beDate(today) + '</b>');
  L.push('━━━━━━━━━━━━');

  // ⬇️ บล็อกใหม่: น้ำหนักขาย
  L.push('⚖️ <b>น้ำหนักขายวันนี้</b>');
  L.push('  🚚 เที่ยวชั่ง: ' + weigh.length + ' เที่ยว · ' + fmtL(kgTot) + ' กก.');
  Object.keys(byProd).forEach(function (p) {
    L.push('  · ' + p + ': ' + fmt(byProd[p].q) + ' คิว (' + byProd[p].n + ' เที่ยว)');
  });
  if (dedTot > 0) L.push('  ➖ หักทรายเปียก: ' + fmt(dedTot) + ' คิว');
  L.push('  รวมสุทธิ: <b>' + fmt(netQTot) + ' คิว</b> (≈ ' + fmt(netQTot * TON_PER_CUBIC) + ' ตัน)');
  L.push('');

  L.push('💰 <b>รายได้วันนี้</b>');
  L.push('  ⛏️ ขายทราย: ' + fmt(sandRev) + ' ฿');
  L.push('  🧱 ขายดิน/อื่น: ' + fmt(dirtTot) + ' ฿');
  if (osCash > 0) L.push('     · เงินสด ' + fmt(osCash));
  if (osTrans > 0) L.push('     · โอน ' + fmt(osTrans));
  if (osCredit > 0) L.push('     · ลงบัญชี ' + fmt(osCredit));
  L.push('  รวมรายได้: <b>' + fmt(totalRev) + ' ฿</b>');
  L.push('  💵 เงินเข้าจริง: ' + fmt(received) + ' ฿');
  L.push('  📒 ค้างชำระ: ' + fmt(osCredit) + ' ฿');
  if (noPrice > 0) L.push('  ⚠️ ใบชั่งยังไม่ใส่ราคา: <b>' + noPrice + '/' + weigh.length + ' ใบ</b> — ยอดขายจริงสูงกว่านี้');
  L.push('');

  // ⬇️ บล็อกใหม่: น้ำมัน
  L.push('⛽ <b>น้ำมันวันนี้</b>');
  if (feN === 0) L.push('  🚛 ค่าน้ำมันรถ: — ไม่มีรายการ —');
  else {
    L.push('  🚛 ค่าน้ำมันรถ: ' + fmtL(feL) + ' ล. / ' + fmt(feTot) + ' ฿ (' + feN + ' ครั้ง)');
    Object.keys(byPlate).sort(function (a, b) { return byPlate[b].b - byPlate[a].b; }).forEach(function (p) {
      L.push('     · ' + p + ' ' + fmtL(byPlate[p].l) + ' ล. / ' + fmt(byPlate[p].b) + ' ฿');
    });
  }
  if (fiL > 0) L.push('  🛢️ รับน้ำมันเข้า: ' + fmtL(fiL) + ' ล. / ' + fmt(fiB) + ' ฿');
  if (foL > 0) L.push('  🔻 เบิกออกใช้งาน: ' + fmtL(foL) + ' ล.');
  L.push('');

  L.push('💸 <b>รายจ่ายวันนี้</b>');
  L.push('  🧾 รายจ่ายทั่วไป: ' + fmt(exTot) + ' ฿ (' + exN + ' รายการ)');
  L.push('  👷 เบิกเงินเดือน: ' + fmt(wdTot) + ' ฿ (' + wdN + ' รายการ)');
  L.push('  ⛽ ค่าน้ำมันรถ: ' + fmt(feTot) + ' ฿ (' + feN + ' ครั้ง)');
  L.push('  รวมรายจ่าย: <b>' + fmt(expTot) + ' ฿</b>');
  L.push('━━━━━━━━━━━━');
  L.push('📈 <b>คงเหลือ (เงินเข้าจริง − รายจ่าย): ' + (netCash >= 0 ? '+' : '') + fmt(netCash) + ' ฿</b>');

  // ⬇️ กันเคส "ศูนย์เงียบ"
  const emptyAll = (weigh.length === 0 && obills.length === 0 && exN === 0 && wdN === 0 && feN === 0 && fin.length === 0);
  if (ERRS.length) {
    L.push('');
    L.push('⚠️ <b>อ่านข้อมูลไม่สำเร็จ — ตัวเลขข้างบนไม่ครบ</b>');
    ERRS.slice(0, 6).forEach(function (e) { L.push('   • ' + e); });
  } else if (emptyAll) {
    L.push('');
    L.push('⚠️ <b>วันนี้ไม่พบข้อมูลเลยสักหมวด</b>');
    L.push('   ถ้าในแอปมีรายการอยู่ แปลว่าบัญชีบอท (admin@sand.local) อ่าน Firestore ไม่ได้ → ตรวจ security rules');
  }

  return {
    text: L.join('\n'),
    counts: {
      weighings: weigh.length, os_bills: obills.length, expenses: exN, withdrawals: wdN,
      fuel_expense: feN, fuel_in: fin.length, fuel_out: fout.length, deductions: deds.length
    }
  };
}

// ---------- helpers ----------
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
function fmtL(n) { return Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 1 }); }
function beDate(ymd) { const p = ymd.split('-'); return parseInt(p[2]) + '/' + p[1] + '/' + (parseInt(p[0]) + 543); }
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
}
