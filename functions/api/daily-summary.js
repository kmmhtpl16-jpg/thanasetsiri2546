// ============================================================
// /api/daily-summary — v2 (9 ก.ย. 2569)
// เปลี่ยนจาก v1:
//   1) เพิ่มบล็อก "น้ำหนักขาย" (เที่ยว / คิว / ตัน / หักทรายเปียก / สุทธิ)
//   2) เพิ่มบล็อก "น้ำมัน" เต็ม (ค่าน้ำมันรถแยกทะเบียน + รับเข้า + เบิกออก)
//   3) เลิกกลืน error — ถ้าอ่าน Firestore ไม่ได้ จะขึ้น ⚠️ บอกสาเหตุจริงในข้อความ
//   4) โหมดตรวจ: ?debug=1  → ไม่ส่ง Telegram คืน JSON ให้ดูว่าแต่ละ collection ได้กี่แถว/error อะไร
//   5) ย้อนวันได้: ?date=2026-09-08
// v3 (21 พ.ย. 2569): สรุปแบบสั้น — แสดงเฉพาะบรรทัดที่มีข้อมูล · ไม่มีอะไร = "วันนี้ไม่มีรายการ"
//   + บรรทัด "ตาชั่งส่งข้อมูล N/3 รอบ" จาก app_meta/scale_runs_<วันที่> (เขียนโดย /api/scale-sync)
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
  // 28 ก.ย. 2569: โหมดทดสอบ/บังคับ/ย้อนวัน ต้องมีรหัสแอดมิน (กันคนนอกดูชื่อ-ยอดเงิน หรือสั่งยิงซ้ำ)
  if ((force || debug || url.searchParams.has('date')) && !(await adminOk(request, url))) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  try {
    const token = env.TELEGRAM_BOT_TOKEN;
    if (!token && !debug) return json({ ok: false, error: 'no token' }, 500);
    const today = dateQ || bkkDate();
    // รอบปกติ = ไม่มี force/debug/date เท่านั้น · ?date= (แอดมิน) ส่งแบบไม่แตะตัวจดรายวัน เหมือน force
    const plain = !force && !debug && !url.searchParams.has('date');
    // 20 พ.ย. 69: เรียกแบบไม่มีรหัส (ตัวตั้งเวลา / แอปเปิดหลัง 18:00) ส่งได้เฉพาะเวลาไทย ≥ 18:00
    // กันคนนอกเรียกก่อนเวลาแล้วสรุปออกก่อน + รอบเย็นถูกข้าม
    if (plain && bkkHM() < OPEN_AT) return json({ ok: true, skipped: 'too early' });
    const idToken = await login();
    // จองสิทธิ์ส่งของวันนี้ (มีเงื่อนไข) → เรียกพร้อมกันหลายทาง ส่งได้ทางเดียว · ส่งถึงแล้ว = ไม่ส่งอีก
    // force (แอดมิน) ไม่แตะตัวจดนี้เลย → ไม่รบกวนรอบปกติ
    let claim = null;
    if (plain) {
      claim = await claimDay(idToken, today);
      if (claim.skip) return json({ ok: true, skipped: claim.skip + ' ' + today });   // already sent / in progress
      if (claim.exhausted) return json({ ok: false, skipped: 'gave up after ' + MAX_TRIES + ' tries ' + today + ' (admin force needed)' });
    }
    // 20 พ.ย. 69 (คุณหลิงสั่ง "ถ้ายังไม่ส่ง ให้ส่งซ้ำ"): Telegram ไม่มีทางให้บอทเช็กย้อนหลังว่าข้อความถึงไหม
    //   ตอบ ok = ถึงแน่ · ตอบปฏิเสธ = ไม่ถึงแน่ · เน็ตหลุด/ไม่มีคำตอบ = ไม่รู้ → ส่งซ้ำ 1 ครั้งพร้อมป้าย 🔁
    //   ยังไม่สำเร็จ → คืนสิทธิ์ให้รอบถัดไป (ตัวตั้งเวลา/เปิดแอป) ส่งใหม่ และจดผลไว้ใน app_meta/notify_daily.sendStatus
    //   ตัวจดใน app_meta/notify_daily: sentDay = วันที่ส่งถึงแน่ · maybeDay = วันที่เคย "ไม่รู้ผล" (ติดป้าย 🔁 จนกว่าจะส่งถึง)
    //   tries = "<วันที่>:<จำนวนรอบ>" สูงสุด MAX_TRIES รอบ/วัน กันส่งซ้ำไม่จบ · ทุกรอบส่ง Telegram ได้ไม่เกิน 2 ข้อความที่อาจถึงกลุ่ม
    let out;
    try {
      out = await buildSummary(idToken, today);
    } catch (e) {
      if (claim) await finishMeta(idToken, { lastSent: { stringValue: '' }, sendStatus: { stringValue: 'failed-build ' + today }, sendTriedAt: { stringValue: new Date().toISOString() } }, claim.ut);
      throw e;
    }
    if (debug) return json({ ok: true, date: today, errors: ERRS, counts: out.counts, text: out.text });
    const RETRY_TAG = '🔁 <b>ส่งซ้ำ</b> — รอบก่อนไม่แน่ใจว่าถึงกลุ่ม (ถ้าเห็นสรุปวันนี้ 2 ข้อความ ใช้อันนี้)\n';
    let res = await tgSend(token, GROUP_CHAT_ID, (claim && claim.prevUnknown ? RETRY_TAG : '') + out.text);
    let status = res.outcome === 'ok' ? (claim && claim.prevUnknown ? 'sent-retry' : 'sent') : res.outcome;
    let unknownSeen = res.outcome === 'unknown';
    if (res.outcome === 'unknown') {
      await new Promise(function (r) { setTimeout(r, 3000); });
      res = await tgSend(token, GROUP_CHAT_ID, RETRY_TAG + out.text);
      status = res.outcome === 'ok' ? 'sent-retry' : (res.outcome === 'rejected' ? 'unknown-then-rejected' : 'unknown');
    }
    if (claim) {
      const now = new Date().toISOString();
      const f = { sendStatus: { stringValue: status + ' ' + today }, sendTriedAt: { stringValue: now } };
      if (res.outcome === 'ok') {
        f.sentDay = { stringValue: today }; f.sentAt = { stringValue: now }; f.sentMsgId = { integerValue: String(res.msgId || 0) };
      } else {
        f.lastSent = { stringValue: '' };   // ยังไม่ถึง/ไม่รู้ → คืนสิทธิ์ ให้รอบถัดไป (ตัวตั้งเวลา/เปิดแอป) ส่งใหม่
        if (unknownSeen) f.maybeDay = { stringValue: today };   // อาจถึงแล้ว → รอบถัดไปติดป้าย 🔁 (ไม่ถูกล้างด้วยผลแบบอื่น)
      }
      await finishMeta(idToken, f, claim.ut);   // เขียนไม่ได้ → จองค้าง → เกิน 15 นาทีรอบถัดไปส่งแทนพร้อมป้าย 🔁
    }
    if (res.outcome !== 'ok') return json({ ok: false, error: 'telegram ' + status, errors: ERRS }, 500);
    return json({ ok: true, sent: today, errors: ERRS.length });   // 28 ก.ย.: ไม่คืนตัวเลขให้คนนอกเห็น
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e), errors: ERRS }, 500);
  }
}

function bkkDate() { return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10); }
function bkkHM() { return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(11, 16); }
const OPEN_AT = '18:00';

// จองสิทธิ์ส่งของวัน: คืน { ut: updateTime ของการจอง (เงื่อนไขตอนจดผล), prevUnknown: ต้องติดป้าย 🔁 } · null = ไม่ต้องส่ง
const MAX_TRIES = 6;                 // จองได้ไม่เกิน 6 รอบ/วัน
const STALE_MS = 15 * 60 * 1000;     // จองค้างเกิน 15 นาทีโดยไม่มีผล (ถูกตัดกลางทาง/จดผลไม่สำเร็จ) = ส่งแทนได้
async function claimDay(idToken, today) {
  const meta = await getDoc(idToken, 'app_meta', 'notify_daily');   // อ่านไม่ได้ = throw (ไม่เดาว่ายังไม่ส่ง)
  const g = function (k) { return meta ? (fval(meta, k) || '') : ''; };
  const last = g('lastSent');
  if (g('sentDay') === today) return { skip: 'already sent' };   // ส่งถึงแน่แล้ว
  if (last > today) return { skip: 'newer day claimed' };        // คำขอค้างข้ามเที่ยงคืน → ห้ามถอยตัวจด
  let stale = false;
  if (last === today) {
    // จองไว้แต่ยังไม่ส่งถึง: รอผลถ้ายังไม่เกิน 15 นาที · ข้อมูลเวอร์ชันเก่า (ไม่มี claimedAt) ถือว่าส่งแล้ว
    const c = g('claimedAt'), s = g('sentAt');
    if (!c || (s && s >= c)) return { skip: 'already sent' };   // เวอร์ชันก่อน (f5949b4) จด sentAt หลังส่งถึง ไม่มี sentDay
    if (!(Date.now() - Date.parse(c) > STALE_MS)) return { skip: 'in progress' };
    stale = true;
  }
  const tm = /^(\d{4}-\d{2}-\d{2}):(\d+)$/.exec(g('tries'));
  const n = (tm && tm[1] === today) ? +tm[2] : 0;
  if (n >= MAX_TRIES) return { exhausted: true };   // ลองครบแล้ววันนี้ → หยุด (แอดมินสั่ง force ได้)
  const pre = meta && meta.updateTime
    ? 'currentDocument.updateTime=' + encodeURIComponent(meta.updateTime)
    : 'currentDocument.exists=false';
  const fields = { lastSent: { stringValue: today }, claimedAt: { stringValue: new Date().toISOString() }, tries: { stringValue: today + ':' + (n + 1) } };
  if (stale) fields.maybeDay = { stringValue: today };   // รับช่วงจองค้าง = รอบนั้นอาจส่งถึงแล้ว → ป้าย 🔁 ติดไปจนส่งถึง
  const mask = Object.keys(fields).map(function (k) { return 'updateMask.fieldPaths=' + k; }).join('&');
  const r = await fetch(`${FS}/app_meta/notify_daily?${mask}&${pre}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
    body: JSON.stringify({ fields: fields })
  });
  let j = null;
  try { j = await r.json(); } catch (e) { /* ignore */ }
  if (r.ok) {
    if (!j || !j.updateTime) throw new Error('claim: no updateTime');
    // เคยไม่รู้ผลวันนี้ หรือรับช่วงจากการจองที่ค้าง (ไม่รู้ว่ารอบนั้นส่งไปหรือยัง) → ติดป้าย 🔁
    return { ut: j.updateTime, prevUnknown: stale || g('maybeDay') === today };
  }
  const st = (j && j.error && j.error.status) || '';
  if (r.status === 409 || st === 'FAILED_PRECONDITION' || st === 'ALREADY_EXISTS' || st === 'ABORTED') return { skip: 'in progress' };   // มีคนจองตัดหน้า
  throw new Error('claim fail ' + r.status + ' ' + st);
}
// จดผลรอบนี้: ลองซ้ำ 3 ครั้ง (เน็ต/ฐานข้อมูลสะดุด) · ยังไม่ได้ = ปล่อยให้ "จองค้าง" ไปรับช่วงเกิน 15 นาที
async function finishMeta(idToken, fields, ut) {
  for (let i = 0; i < 3; i++) {
    try { await patchMeta(idToken, fields, ut); return true; }
    catch (e) {
      if (/write fail (400|409)/.test(String(e && e.message))) return false;   // ไม่ใช่การจองของเราแล้ว ลองซ้ำไม่มีประโยชน์
      await new Promise(function (r) { setTimeout(r, 500 * (i + 1)); });
    }
  }
  return false;
}
// เขียนตัวจดแบบมีเงื่อนไข: แก้ได้เฉพาะเมื่อยังเป็นการจองของเราเอง (updateTime ตรง)
async function patchMeta(idToken, fields, updateTime) {
  const mask = Object.keys(fields).map(function (k) { return 'updateMask.fieldPaths=' + encodeURIComponent(k); }).join('&');
  const r = await fetch(`${FS}/app_meta/notify_daily?${mask}&currentDocument.updateTime=${encodeURIComponent(updateTime)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
    body: JSON.stringify({ fields })
  });
  if (!r.ok) throw new Error('write fail ' + r.status);
}

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
  // 30 ก.ย. 2569: Firestore ส่ง error มาในรูป array [{error:{...}}] ได้ (HTTP ไม่ 200) — เดิมถูกนับเป็น 0 แถวเงียบ ๆ
  const bad = arr.find(function (x) { return x && x.error; });
  if (bad || !r.ok) {
    const e = (bad && bad.error) || {};
    throw new Error(((e.status || ('HTTP ' + r.status)) + ' ' + (e.message || '')).trim());
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
  let sandRev = 0, sandCredit = 0, kgTot = 0, dedTot = 0, netQTot = 0, noPrice = 0;
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
    let amt = 0;
    if (unit === 'เหมา') { amt = fval(w, 'sale_amount') || 0; }
    else {
      const price = fval(w, 'price') || 0; if (price <= 0) { noPrice++; return; }
      const qty = (unit === 'ตัก') ? (fval(w, 'scoop') || 0) : ((unit === 'ตัน') ? net * TON_PER_CUBIC : net);
      amt = qty * price;
    }
    sandRev += amt;
    if (fval(w, 'pay_method') === 'ลงบัญชี') sandCredit += amt;   // เฟส 1.2: ขายทรายลงบัญชี = ค้างชำระ
  });
  sandRev = Math.round(sandRev * 100) / 100;
  sandCredit = Math.round(sandCredit * 100) / 100;

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
  const received = sandRev - sandCredit + osCash + osTrans;
  const expTot = exTot + wdTot + feTot;
  const netCash = Math.round((received - expTot) * 100) / 100;

  // ── สรุปแบบสั้น (21 พ.ย. 2569): แสดงเฉพาะบล็อก/บรรทัดที่มีข้อมูล ไม่แสดงบรรทัดที่เป็น 0 ──
  const blocks = [];
  if (weigh.length > 0) {
    const b = ['⚖️ <b>น้ำหนักขายวันนี้</b>'];
    b.push('  🚚 เที่ยวชั่ง: ' + weigh.length + ' เที่ยว · ' + fmtL(kgTot) + ' กก.');
    Object.keys(byProd).forEach(function (p) {
      b.push('  · ' + esc(p) + ': ' + fmt(byProd[p].q) + ' คิว (' + byProd[p].n + ' เที่ยว)');
    });
    if (dedTot > 0) b.push('  ➖ หักทรายเปียก: ' + fmt(dedTot) + ' คิว');
    b.push('  รวมสุทธิ: <b>' + fmt(netQTot) + ' คิว</b> (≈ ' + fmt(netQTot * TON_PER_CUBIC) + ' ตัน)');
    blocks.push(b);
  }
  if (sandRev !== 0 || dirtTot !== 0 || noPrice > 0) {
    const b = ['💰 <b>รายได้วันนี้</b>'];
    if (sandRev !== 0) b.push('  ⛏️ ขายทราย: ' + fmt(sandRev) + ' ฿');
    if (sandCredit > 0) b.push('     · ลงบัญชี ' + fmt(sandCredit));
    if (dirtTot !== 0) b.push('  🧱 ขายดิน/อื่น: ' + fmt(dirtTot) + ' ฿');
    if (osCash > 0) b.push('     · เงินสด ' + fmt(osCash));
    if (osTrans > 0) b.push('     · โอน ' + fmt(osTrans));
    if (osCredit > 0) b.push('     · ลงบัญชี ' + fmt(osCredit));
    if (totalRev !== 0) b.push('  รวมรายได้: <b>' + fmt(totalRev) + ' ฿</b>');
    if (received !== 0) b.push('  💵 เงินเข้าจริง: ' + fmt(received) + ' ฿');
    if (osCredit + sandCredit > 0) b.push('  📒 ค้างชำระ: ' + fmt(osCredit + sandCredit) + ' ฿');
    if (noPrice > 0) b.push('  ⚠️ ใบชั่งยังไม่ใส่ราคา: <b>' + noPrice + '/' + weigh.length + ' ใบ</b> — ยอดขายจริงสูงกว่านี้');
    blocks.push(b);
  }
  if (feN > 0 || fin.length > 0 || fout.length > 0) {   // มีรายการ = แสดง (แม้ลิตรเป็น 0)
    const b = ['⛽ <b>น้ำมันวันนี้</b>'];
    if (feN > 0) {
      b.push('  🚛 ค่าน้ำมันรถ: ' + fmtL(feL) + ' ล. / ' + fmt(feTot) + ' ฿ (' + feN + ' ครั้ง)');
      Object.keys(byPlate).sort(function (a, c) { return byPlate[c].b - byPlate[a].b; }).forEach(function (p) {
        b.push('     · ' + esc(p) + ' ' + fmtL(byPlate[p].l) + ' ล. / ' + fmt(byPlate[p].b) + ' ฿');
      });
    }
    if (fin.length > 0) b.push('  🛢️ รับน้ำมันเข้า: ' + fmtL(fiL) + ' ล. / ' + fmt(fiB) + ' ฿');
    if (fout.length > 0) b.push('  🔻 เบิกออกใช้งาน: ' + fmtL(foL) + ' ล.');
    blocks.push(b);
  }
  if (exN > 0 || wdN > 0 || feN > 0) {
    const b = ['💸 <b>รายจ่ายวันนี้</b>'];
    if (exN > 0) b.push('  🧾 รายจ่ายทั่วไป: ' + fmt(exTot) + ' ฿ (' + exN + ' รายการ)');
    if (wdN > 0) b.push('  👷 เบิกเงินเดือน: ' + fmt(wdTot) + ' ฿ (' + wdN + ' รายการ)');
    if (feN > 0) b.push('  ⛽ ค่าน้ำมันรถ: ' + fmt(feTot) + ' ฿ (' + feN + ' ครั้ง)');
    b.push('  รวมรายจ่าย: <b>' + fmt(expTot) + ' ฿</b>');
    blocks.push(b);
  }
  if (received !== 0 || expTot !== 0) {
    blocks.push(['📈 <b>คงเหลือ (เงินเข้าจริง − รายจ่าย): ' + (netCash >= 0 ? '+' : '') + fmt(netCash) + ' ฿</b>']);
  }

  // ── ตาชั่งรายงานตัว (เริ่ม 21/11/2569) — อ่านก่อนตัดสินว่า "ไม่มีรายการ" เพราะอ่านพลาดต้องเข้า ERRS ──
  const scale = await scaleRunsLine(idToken, today);

  const L = [];
  L.push('📊 <b>สรุปประจำวัน ' + beDate(today) + '</b>');
  if (blocks.length) {
    L.push('━━━━━━━━━━━━');
    blocks.forEach(function (b, i) { if (i) L.push(''); b.forEach(function (x) { L.push(x); }); });
  } else if (!ERRS.length) {
    L.push('วันนี้ไม่มีรายการ');   // อ่านพลาด (ERRS) ห้ามขึ้นบรรทัดนี้ — จะเข้าใจผิดว่าไม่มีรายการจริง
  }

  // ท้ายข้อความ (บรรทัดตาชั่ง + คำเตือนอ่านพลาด) ต้องไม่ถูกตัดทิ้ง → กันที่ไว้ แล้วตัดเฉพาะส่วนบนที่ขอบบรรทัด
  const T = [];
  if (scale.line) { T.push(''); T.push(scale.line); }
  if (ERRS.length) {
    T.push('');
    T.push('⚠️ <b>อ่านข้อมูลไม่สำเร็จ — ตัวเลข' + (blocks.length ? 'ข้างบน' : '') + 'ไม่ครบ</b>');
    // จำกัดขนาด: 6 ข้อ × 100 ตัวอักษร (escape แล้วยาวสุด ~3,000) ท้ายข้อความไม่เกินที่กันไว้
    ERRS.slice(0, 6).forEach(function (e) { T.push('   • ' + esc(String(e).slice(0, 100))); });
    if (ERRS.length > 6) T.push('   • … อีก ' + (ERRS.length - 6) + ' ข้อ');
  }
  const tail = T.join('\n');
  let head = L.join('\n');
  const room = 3800 - tail.length;   // เผื่อป้าย 🔁 ส่งซ้ำ (~100 ตัวอักษร) ไม่ให้ tgSend ตัดท้ายทิ้ง
  if (head.length > room) { head = head.slice(0, room); head = head.slice(0, Math.max(0, head.lastIndexOf('\n'))) + '\n… (ตัดบางรายการ ดูเต็มในแอป)'; }

  return {
    text: tail ? head + '\n' + tail : head,   // tail ขึ้นต้นด้วยบรรทัดว่างอยู่แล้ว
    counts: {
      weighings: weigh.length, os_bills: obills.length, expenses: exN, withdrawals: wdN,
      fuel_expense: feN, fuel_in: fin.length, fuel_out: fout.length, deductions: deds.length,
      scaleRuns: scale.times
    }
  };
}

// ---------- ตาชั่งส่งข้อมูลกี่รอบ (app_meta/scale_runs_YYYY-MM-DD.times = ["09:00", …] เวลาไทย) ----------
const SCALE_FROM = '2026-11-21';
const SCALE_SLOTS = [
  { label: '09:00', from: '08:30', to: '11:59' },
  { label: '12:00', from: '12:00', to: '16:59' },
  { label: '17:00', from: '17:00', to: '23:59' }   // ถึงก่อนส่งสรุป (สรุปส่ง 18:00 รอบที่ส่งหลังสรุปไม่ทันนับ)
];
async function scaleRunsLine(idToken, today) {
  if (today < SCALE_FROM) return { line: '', times: null };
  let doc;
  try { doc = await getDoc(idToken, 'app_meta', 'scale_runs_' + today); }
  catch (e) { ERRS.push('รอบตาชั่ง → ' + ((e && e.message) || e)); return { line: '', times: null }; }
  const times = [];
  const arr = doc && doc.fields && doc.fields.times && doc.fields.times.arrayValue && doc.fields.times.arrayValue.values;
  (arr || []).forEach(function (v) { if (v && typeof v.stringValue === 'string' && /^\d{2}:\d{2}$/.test(v.stringValue)) times.push(v.stringValue); });
  const missing = SCALE_SLOTS.filter(function (s) {
    return !times.some(function (t) { return t >= s.from && t <= s.to; });
  }).map(function (s) { return s.label; });
  const n = SCALE_SLOTS.length - missing.length;
  const line = missing.length
    ? '⚠️ ตาชั่งส่งข้อมูล ' + n + '/3 รอบ — ขาดรอบ ' + missing.join(', ') + ' (เช็กว่าคอมเครื่องชั่งเปิดอยู่)'
    : '⚖️ ตาชั่งส่งข้อมูล 3/3 รอบ';
  return { line: line, times: times };
}

// ---------- รหัสแอดมิน (28 ก.ย. 2569) ----------
// ?debug=1 / ?force=1 / ?date=... ใช้ได้เฉพาะคนที่แนบรหัส: ?key=<รหัส> หรือหัว x-admin-key
// repo นี้เป็นสาธารณะ จึงเก็บแค่ sha256 ของรหัส (รหัสจริงเจ้าของเก็บเอง) ถ้าจะเปลี่ยนรหัส: สร้างใหม่แล้วเอา sha256 มาแทน
const ADMIN_KEY_SHA256 = '6c168459ac88af2c58dd57a45d0d19501fefe96db75600e1b8d957a926109203';
async function adminOk(request, url) {
  const k = request.headers.get('x-admin-key') || url.searchParams.get('key') || '';
  if (k.length < 32) return false;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(k));
  const hex = Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  let diff = hex.length ^ ADMIN_KEY_SHA256.length;
  for (let i = 0; i < hex.length && i < ADMIN_KEY_SHA256.length; i++) diff |= hex.charCodeAt(i) ^ ADMIN_KEY_SHA256.charCodeAt(i);
  return diff === 0;
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
// ส่ง Telegram (21 พ.ย. 69): ตัดยาวที่ขอบบรรทัด (ไม่ตัดกลางแท็ก/entity) · HTML ถูกปฏิเสธ → ส่งซ้ำแบบข้อความธรรมดา
// ส่งไม่สำเร็จทั้งสองแบบ = throw → ไม่บันทึก lastSent (รอบหน้าส่งใหม่ได้)
async function tgSend(token, chatId, text) {
  let t = text;
  if (t.length > 4000) { t = t.slice(0, 3990); t = t.slice(0, Math.max(0, t.lastIndexOf('\n'))) + '\n…'; }
  // คืน { outcome: 'ok' (ถึงแน่ + msgId) | 'rejected' (Telegram ปฏิเสธชัดเจน = ไม่ถึงแน่) | 'unknown' (เน็ตหลุด/5xx ไม่รู้ผล) }
  const send = function (payload) {
    return fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    }).then(async function (r) {
      if (r.ok) {
        // ถึงแน่ = Telegram ตอบ ok:true เท่านั้น · 2xx แต่อ่านคำตอบไม่ได้/ไม่ใช่ ok:true = ไม่รู้ผล
        let j = null; try { j = await r.json(); } catch (e) { /* ignore */ }
        if (j && j.ok === true) return { outcome: 'ok', msgId: (j.result && j.result.message_id) || 0 };
        return { outcome: 'unknown' };
      }
      // ปฏิเสธแน่ = Telegram ตอบเองว่า ok:false (มี error_code) และไม่ใช่ 5xx/408/429 · นอกนั้น (ตัวกลางตอบ/อ่านไม่ได้) = ไม่รู้ผล
      let j = null; try { j = await r.json(); } catch (e) { /* ignore */ }
      if (r.status < 500 && r.status !== 408 && r.status !== 429 && j && j.ok === false && j.error_code) return { outcome: 'rejected' };
      return { outcome: 'unknown' };
    }).catch(function () { return { outcome: 'unknown' }; });
  };
  const r1 = await send({ chat_id: chatId, text: t, parse_mode: 'HTML', disable_web_page_preview: true });
  if (r1.outcome !== 'rejected') return r1;   // ok หรือ unknown (unknown ให้ผู้เรียกตัดสินส่งซ้ำพร้อมป้าย)
  // HTML ถูกปฏิเสธ (ไม่ถึงแน่) → ลองแบบข้อความธรรมดา
  const plainText = t.replace(/<\/?b>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return await send({ chat_id: chatId, text: plainText, disable_web_page_preview: true });
}
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function fmt(n) { return Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtL(n) { return Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 1 }); }
function beDate(ymd) { const p = ymd.split('-'); return parseInt(p[2]) + '/' + p[1] + '/' + (parseInt(p[0]) + 543); }
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
}
