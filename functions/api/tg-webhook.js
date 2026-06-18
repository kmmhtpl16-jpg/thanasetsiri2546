// ============================================================
// Telegram webhook สำหรับ thanaset_alert_bot (บอทโต้ตอบ)
// คำสั่ง: "ยอดธีรนพ", "ยอดน้ำมัน", "ออกบิล", "ยืนยันออกบิล"
// อ่าน/เขียน Firestore ฝั่งเซิร์ฟเวอร์ผ่านบัญชี admin (เก็บรหัสเป็น secret env)
// สั่งงานสำคัญ (ออกบิล) ได้เฉพาะคุณหลิง (OWNER_ID) เท่านั้น
// ============================================================

const OWNER_ID   = 8066824631;        // คุณหลิง (@LhingP) — คนเดียวที่ออกบิลได้
const FB_API_KEY = 'AIzaSyAaxKbw-MKrsVnCEw6IY_cYkiWsp1Ql8SA';   // public apiKey (มีในแอปอยู่แล้ว)
const FB_PROJECT = 'thanasetsiri2546-20cb6';
const KPC        = 1500;              // 1 คิว = 1,500 กก.
const TEERANOP_KEY = 'ธีรนพ';        // คำที่ใช้จับชื่อลูกค้าธีรนพ
const TEERANOP_PRICE = 145;          // บาท/คิว (รวม VAT แล้ว)
const THRESHOLD  = 5000;             // เกณฑ์คิว

const FS = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;

export async function onRequestPost(context) {
  const { request, env } = context;
  // กันคนอื่นยิง webhook ปลอม: ตรวจ secret token ที่ตั้งตอน setWebhook
  if (env.TG_WEBHOOK_SECRET) {
    const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (got !== env.TG_WEBHOOK_SECRET) return json({ ok: false }, 401);
  }
  let update = {};
  try { update = await request.json(); } catch (e) {}
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return json({ ok: true });   // ไม่ใช่ข้อความ ข้ามไป

  const chatId = msg.chat.id;
  const fromId = msg.from && msg.from.id;
  const text   = msg.text.trim();
  const token  = env.TELEGRAM_BOT_TOKEN;
  GLOBAL_ENV = env;   // ให้ helper (login) เข้าถึง FB_EMAIL/FB_PASSWORD ได้

  try {
    if (/^\/?start|^เมนู|^help|^ช่วย/i.test(text)) {
      await tgSend(token, chatId, menuText());
    } else if (/ธีรนพ/.test(text) && !/ออกบิล|ยืนยัน/.test(text)) {
      await tgSend(token, chatId, await reportTeeranop());
    } else if (/น้ำมัน/.test(text)) {
      await tgSend(token, chatId, await reportFuel());
    } else if (/^ยืนยันออกบิล/.test(text)) {
      if (fromId !== OWNER_ID) { await tgSend(token, chatId, '⛔ คำสั่งนี้เฉพาะคุณหลิงเท่านั้น'); return json({ ok: true }); }
      await tgSend(token, chatId, await confirmIssueInvoice());
    } else if (/ออกบิล|ออกใบแจ้งหนี้/.test(text)) {
      if (fromId !== OWNER_ID) { await tgSend(token, chatId, '⛔ คำสั่งนี้เฉพาะคุณหลิงเท่านั้น'); return json({ ok: true }); }
      await tgSend(token, chatId, await prepareInvoice());
    }
    // ข้อความอื่นๆ: เงียบ (ไม่สแปมในกลุ่ม)
  } catch (e) {
    await tgSend(token, chatId, '⚠️ ระบบขัดข้อง: ' + String((e && e.message) || e));
  }
  return json({ ok: true });
}

export async function onRequestGet() { return json({ ok: true, info: 'telegram webhook' }); }

// ---------- Firestore (อ่าน/เขียนด้วยบัญชี admin) ----------
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
  if (!Array.isArray(arr)) throw new Error('query fail: ' + JSON.stringify(arr).slice(0, 120));
  return arr.filter(x => x.document).map(x => x.document);
}
function fval(doc, f) {  // อ่านค่า field แปลง type
  const v = doc.fields && doc.fields[f]; if (!v) return undefined;
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('integerValue' in v) return Number(v.integerValue);
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  return undefined;
}
function docId(doc) { const p = doc.name.split('/'); return p[p.length - 1]; }

// ---------- คำนวณยอดธีรนพ (เฉพาะรอบที่ยังไม่วางบิล) ----------
async function teeranopSummary() {
  const idToken = await login();
  // 1) หาวันสุดท้ายที่ออกใบแจ้งหนี้ธีรนพไปแล้ว (status != cancelled)
  const invs = await runQuery(idToken, { from: [{ collectionId: 'invoices' }] });
  let lastBilledTo = '';
  invs.forEach(d => {
    const cust = fval(d, 'customer') || '';
    if (cust.indexOf(TEERANOP_KEY) >= 0 && fval(d, 'status') !== 'cancelled') {
      const to = fval(d, 'dateTo') || '';
      if (to > lastBilledTo) lastBilledTo = to;
    }
  });
  // 2) ดึง deductions ทั้งหมด (id -> cubic)
  const deds = await runQuery(idToken, { from: [{ collectionId: 'deductions' }] });
  const dMap = {}; deds.forEach(d => { dMap[docId(d)] = fval(d, 'cubic') || 0; });
  // 3) ดึง weighings วันที่ > lastBilledTo แล้วกรองธีรนพ
  const wq = { from: [{ collectionId: 'weighings' }] };
  if (lastBilledTo) wq.where = { fieldFilter: { field: { fieldPath: 'date' }, op: 'GREATER_THAN', value: { stringValue: lastBilledTo } } };
  const ws = await runQuery(idToken, wq);
  let net = 0, trips = 0, dateFrom = '', dateTo = '', custName = '';
  ws.forEach(d => {
    const cust = fval(d, 'customer') || '';
    if (cust.indexOf(TEERANOP_KEY) < 0) return;
    if (!custName) custName = cust;   // ใช้ชื่อลูกค้าเต็มจริงจากข้อมูล
    const kg = fval(d, 'kg') || 0;
    const ded = dMap[docId(d)] || 0;
    net += Math.max(0, kg / KPC - ded);
    trips++;
    const dt = fval(d, 'date') || '';
    if (!dateFrom || dt < dateFrom) dateFrom = dt;
    if (dt > dateTo) dateTo = dt;
  });
  return { idToken, net, trips, lastBilledTo, dateFrom, dateTo, custName };
}
async function reportTeeranop() {
  const s = await teeranopSummary();
  const net = Math.round(s.net * 100) / 100;
  const left = Math.round((THRESHOLD - net) * 100) / 100;
  let m = '🏖️ <b>ยอดทรายธีรนพ</b> (รอบใหม่ที่ยังไม่วางบิล)\n';
  m += `• สะสม = <b>${fmt(net)} คิว</b> (${s.trips} เที่ยว)\n`;
  if (net >= THRESHOLD) m += `• ✅ ครบเกณฑ์ 5,000 คิวแล้ว (เกิน ${fmt(net - THRESHOLD)})\n  พิมพ์ "ออกบิล" เพื่อออกใบแจ้งหนี้`;
  else m += `• เกณฑ์ 5,000 คิว → ขาดอีก <b>${fmt(left)} คิว</b>`;
  if (s.lastBilledTo) m += `\n(วางบิลล่าสุดถึง ${s.lastBilledTo})`;
  return m;
}

// ---------- ยอดน้ำมันคงเหลือ ----------
async function reportFuel() {
  const idToken = await login();
  const fin = await runQuery(idToken, { from: [{ collectionId: 'fuel_in' }] });
  const fout = await runQuery(idToken, { from: [{ collectionId: 'fuel_out' }] });
  let tin = 0, tout = 0;
  fin.forEach(d => tin += (fval(d, 'liters') || 0));
  fout.forEach(d => tout += (fval(d, 'liters') || 0));
  const remain = tin - tout;
  return `⛽ <b>น้ำมันคงเหลือในสต็อก</b>\n• คงเหลือ = <b>${fmt(remain)} ลิตร</b>\n  (รับเข้ารวม ${fmt(tin)} − จ่ายออก ${fmt(tout)})`;
}

// ---------- เตรียมออกบิล (แสดงยอด + ขอยืนยัน) ----------
async function prepareInvoice() {
  const s = await teeranopSummary();
  const net = Math.round(s.net * 1000) / 1000;
  if (net <= 0) return 'ℹ️ ยังไม่มียอดทรายธีรนพใหม่ที่ยังไม่วางบิล';
  const grand = Math.round(net * TEERANOP_PRICE * 100) / 100;
  const custName = s.custName || ('หจก.' + TEERANOP_KEY);
  // เก็บ pending ไว้ใน Firestore (app_meta/tg_pending_invoice) อายุ 5 นาที
  await setDoc(s.idToken, 'app_meta', 'tg_pending_invoice', {
    customer: { stringValue: custName },
    dateFrom: { stringValue: s.dateFrom }, dateTo: { stringValue: s.dateTo },
    netKiu: { doubleValue: net }, grandTotal: { doubleValue: grand },
    price: { doubleValue: TEERANOP_PRICE },
    expireAt: { stringValue: new Date(Date.now() + 5 * 60000).toISOString() }
  });
  return `🧾 <b>เตรียมออกใบแจ้งหนี้ธีรนพ</b>\n• ช่วง ${s.dateFrom} ถึง ${s.dateTo}\n• ${fmt(net)} คิว × ${TEERANOP_PRICE} = <b>${fmt(grand)} บาท</b> (รวม VAT)\n\nพิมพ์ <b>ยืนยันออกบิล</b> ภายใน 5 นาที เพื่อออกจริง`;
}

// ---------- ยืนยันออกบิลจริง ----------
async function confirmIssueInvoice() {
  const idToken = await login();
  const pend = await getDoc(idToken, 'app_meta', 'tg_pending_invoice');
  if (!pend) return '⚠️ ไม่พบรายการรอออกบิล พิมพ์ "ออกบิล" ใหม่อีกครั้ง';
  const exp = fval(pend, 'expireAt');
  if (exp && new Date(exp).getTime() < Date.now()) return '⏰ คำขอออกบิลหมดอายุแล้ว พิมพ์ "ออกบิล" ใหม่';
  const custName = fval(pend, 'customer'); const dateFrom = fval(pend, 'dateFrom'); const dateTo = fval(pend, 'dateTo');
  const netKiu = fval(pend, 'netKiu'); const grand = fval(pend, 'grandTotal'); const price = fval(pend, 'price');
  // กันออกซ้ำ: customer+dateFrom+dateTo ที่ยังไม่ยกเลิก
  const invs = await runQuery(idToken, { from: [{ collectionId: 'invoices' }],
    where: { compositeFilter: { op: 'AND', filters: [
      { fieldFilter: { field: { fieldPath: 'customer' }, op: 'EQUAL', value: { stringValue: custName } } },
      { fieldFilter: { field: { fieldPath: 'dateFrom' }, op: 'EQUAL', value: { stringValue: dateFrom } } },
      { fieldFilter: { field: { fieldPath: 'dateTo' }, op: 'EQUAL', value: { stringValue: dateTo } } }
    ] } } });
  const dup = invs.find(d => fval(d, 'status') !== 'cancelled');
  if (dup) return `⚠️ ยอดช่วงนี้เคยออกใบแจ้งหนี้แล้ว (${fval(dup, 'docNo')}) — ถ้าจะออกใหม่ ให้ยกเลิกใบเดิมในแอปก่อน`;
  // สร้างเลขที่ + เขียน doc
  const t = new Date(); const yyyymmdd = t.getFullYear() + String(t.getMonth() + 1).padStart(2, '0') + String(t.getDate()).padStart(2, '0');
  const docNo = 'BL' + yyyymmdd + String(Math.floor(Math.random() * 900 + 100));
  await setDoc(idToken, 'invoices', docNo, {
    docNo: { stringValue: docNo }, customer: { stringValue: custName },
    dateFrom: { stringValue: dateFrom }, dateTo: { stringValue: dateTo },
    sandType: { stringValue: 'ทราย (รับเอง)' }, price: { doubleValue: price },
    vatType: { stringValue: 'inclusive' }, balFwd: { doubleValue: 0 }, remark: { stringValue: 'ออกผ่านบอท Telegram' },
    totalNetKiu: { doubleValue: Math.round(netKiu * 1000) / 1000 }, grandTotal: { doubleValue: Math.round(grand * 100) / 100 },
    status: { stringValue: 'pending' }, createdAt: { stringValue: new Date().toISOString() }, createdBy: { stringValue: 'telegram-bot' }
  });
  // ลบ pending
  await deleteDoc(idToken, 'app_meta', 'tg_pending_invoice');
  return `✅ <b>ออกใบแจ้งหนี้แล้ว</b>\n• เลขที่ ${docNo}\n• ${custName}\n• ${fmt(netKiu)} คิว = <b>${fmt(grand)} บาท</b>\n• สถานะ: รอวางบิล (ดู/แก้ในแอปได้)`;
}

// ---------- Firestore REST write helpers ----------
async function setDoc(idToken, coll, id, fields) {
  const r = await fetch(`${FS}/${coll}/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
    body: JSON.stringify({ fields })
  });
  if (!r.ok) throw new Error('write fail ' + r.status);
}
async function getDoc(idToken, coll, id) {
  const r = await fetch(`${FS}/${coll}/${encodeURIComponent(id)}`, { headers: { 'Authorization': 'Bearer ' + idToken } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('get fail ' + r.status);
  return await r.json();
}
async function deleteDoc(idToken, coll, id) {
  await fetch(`${FS}/${coll}/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + idToken } });
}

// ---------- Telegram ----------
async function tgSend(token, chatId, text) {
  await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true })
  });
}
function menuText() {
  return '🤖 <b>คำสั่งบอทท่าทราย</b>\n• <b>ยอดธีรนพ</b> — ดูยอดทรายสะสมเทียบ 5,000 คิว\n• <b>ยอดน้ำมัน</b> — ดูน้ำมันคงเหลือในสต็อก\n• <b>ออกบิล</b> — เตรียมใบแจ้งหนี้ธีรนพ (เฉพาะคุณหลิง)\n• <b>ยืนยันออกบิล</b> — ยืนยันออกจริง';
}
function fmt(n) { return Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function json(obj, status) { return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json; charset=utf-8' } }); }

// env เข้าถึงผ่าน context ใน onRequestPost; กำหนด global ให้ helper ใช้
let GLOBAL_ENV = {};
