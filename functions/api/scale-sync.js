// ============================================================
// /api/scale-sync — รับข้อมูลตั๋วชั่งจากโปรแกรม THEO TruckWeight (20 พ.ย. 2569)
// ตัวส่ง: สคริปต์ PowerShell บนคอมเครื่องชั่ง อ่านฐานข้อมูล THEO แบบอ่านอย่างเดียว แล้ว POST มาที่นี่
// - ยืนยันตัวด้วยหัว x-scale-key (repo สาธารณะ → เก็บแค่ sha256 รหัสจริงอยู่ในเครื่องชั่ง + _ลับ-ห้ามอัป)
// - เขียนลง weighings ด้วย id = วันที่ชั่งออก_เลขตั๋ว (ตรงกับตัวนำเข้า CSV → ส่งซ้ำ/นำเข้าซ้ำไม่เกิดยอดซ้ำ)
// - ตั๋วเดิมที่ข้อมูลใน THEO เปลี่ยน (DataHash ต่าง) → อัปเดตเฉพาะช่องของตาชั่ง + เก็บประวัติ scale_edits + แจ้ง Telegram
// - ไม่ทับช่องที่แอปจัดการเอง (ราคา, หน่วยขาย, ช่องทางชำระ, ชื่อลูกค้าที่แก้ในแอป)
// ============================================================

const GROUP_CHAT_ID = '-5450363615';
const FB_API_KEY = 'AIzaSyAaxKbw-MKrsVnCEw6IY_cYkiWsp1Ql8SA'; // public apiKey
const FB_PROJECT = 'thanasetsiri2546-20cb6';
const FS = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;
const SCALE_KEY_SHA256 = '4f80ac1c34f99419160c4395fd1b6bfe5b4144a74d11a7c3e9c6ddfad21eedd0';
const MAX_TICKETS = 200;
const MAX_BODY = 512 * 1024;
const GENERAL = 'ลูกค้า (ทั่วไป)';

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await keyOk(request))) return json({ ok: false, error: 'unauthorized' }, 401);
  const cl = +(request.headers.get('content-length') || 0);
  if (cl > MAX_BODY) return json({ ok: false, error: 'body too large' }, 413);
  let body;
  try {
    const rawText = await request.text();   // ตรวจขนาดจริงด้วย (เผื่อไม่มีหัว content-length)
    if (new TextEncoder().encode(rawText).length > MAX_BODY) return json({ ok: false, error: 'body too large' }, 413);
    body = JSON.parse(rawText);
  } catch (e) { return json({ ok: false, error: 'bad json' }, 400); }
  const list = Array.isArray(body && body.tickets) ? body.tickets : null;
  if (!list) return json({ ok: false, error: 'no tickets' }, 400);
  if (list.length > MAX_TICKETS) return json({ ok: false, error: 'too many tickets (max ' + MAX_TICKETS + ')' }, 400);

  try {
    const idToken = await login(env);
    const res = { created: 0, updated: 0, unchanged: 0, skipped: 0, errors: [] };
    const accepted = [];   // dataId ที่บันทึก/ตรวจแล้วจริง → ตัวส่งจำไว้ไม่ส่งซ้ำ (ที่เหลือส่งใหม่รอบหน้า)
    const rejected = [];   // ข้อมูลไม่ครบ/ผิดรูป → ตัวส่งไม่จำ จะส่งซ้ำและเขียนลง log
    const alerts = [];
    const newSeqs = [];
    for (const raw of list) {
      const t = clean(raw);
      if (!t) { res.skipped++; rejected.push(String((raw && raw.dataId) || '').slice(0, 60) + '#' + String((raw && raw.seq) || '').slice(0, 12)); continue; }
      newSeqs.push(+t.seq);   // ทุกตั๋วที่ชั่งออกแล้ว (รวมยกเลิก/มีอยู่แล้ว/เขียนไม่สำเร็จที่จะส่งซ้ำ) ไม่นับเป็นเลขหาย
      try {
        const r = await syncOne(idToken, t);
        res[r.kind]++;
        if (r.alert) alerts.push(r.alert);
        accepted.push(t.dataId);
      } catch (e) { res.errors.push(t.seq + ': ' + ((e && e.message) || e)); }
    }

    // เลขตั๋วกระโดด (ตั๋วหาย/ถูกลบ)
    const meta = await getDoc(idToken, 'app_meta', 'scale_sync').catch(function () { return null; });
    let maxSeq = meta ? (fval(meta, 'maxSeq') || 0) : 0;
    newSeqs.sort(function (a, b) { return a - b; });
    if (maxSeq > 0) {
      const seen = new Set(newSeqs);
      const missing = [];
      const top = newSeqs.length ? newSeqs[newSeqs.length - 1] : maxSeq;
      for (let s = maxSeq + 1; s < top && missing.length < 20; s++) if (!seen.has(s)) missing.push(s);
      if (missing.length) alerts.unshift('⚠️ <b>เลขตั๋วหาย</b> (ไม่มีในฐานข้อมูล THEO หรือยังไม่ชั่งออก): ' + missing.map(pad7).join(', '));
    }
    if (newSeqs.length) maxSeq = Math.max(maxSeq, newSeqs[newSeqs.length - 1]);
    await patchDoc(idToken, 'app_meta', 'scale_sync', {
      maxSeq: { integerValue: String(maxSeq) }, lastSyncAt: str(new Date().toISOString()),
      lastStation: str(String((body && body.station) || '').slice(0, 40))
    }, null).catch(function () {});

    let tgOk = true;
    if (alerts.length && !env.TELEGRAM_BOT_TOKEN) tgOk = false;
    if (alerts.length && env.TELEGRAM_BOT_TOKEN) {
      // แบ่งเป็นหลายข้อความ ไม่เกิน ~3500 ตัวอักษร/ข้อความ (ไม่ตัดกลางรายการ) สูงสุด 8 ข้อความต่อรอบ · เกิน = telegramOk false (ตัวส่งเขียน log) · เลขตั๋วหายอยู่บนสุดเสมอ
      const msgs = []; let cur = '⚖️ <b>ตาชั่ง THEO — สิ่งที่ต้องดู</b>';
      for (const a0 of alerts) {
        const a = a0.length > 3000 ? a0.slice(0, 3000).replace(/<[^>]*$/, '') + ' …' : a0;
        if (cur.length + a.length + 1 > 3500) { msgs.push(cur); cur = '⚖️ (ต่อ)'; }
        cur += '\n' + a;
      }
      msgs.push(cur);
      const send = msgs.slice(0, 8);
      if (msgs.length > 8) { send[7] += '\n… ยังมีอีก ' + (msgs.length - 8) + ' ข้อความที่ไม่ได้ส่ง (ประวัติแก้/ยกเลิกอยู่ใน scale_edits)'; tgOk = false; }
      for (const m of send) { if (!(await tgSend(env.TELEGRAM_BOT_TOKEN, GROUP_CHAT_ID, m))) tgOk = false; }
    }
    return json({ ok: true, created: res.created, updated: res.updated, unchanged: res.unchanged, skipped: res.skipped, alerts: alerts.length, telegramOk: tgOk, accepted: accepted, rejected: rejected.slice(0, 50), errors: res.errors.slice(0, 10) });
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e) }, 500);
  }
}

// ---------- ตั๋ว 1 ใบ ----------
// ข้อความแจ้งเตือน: ค่าที่มาจากผู้ใช้ (ลูกค้า/หมายเหตุ/ทะเบียน) ผ่าน esc() ทุกตัว · <b> ใส่เองเฉพาะข้อความคงที่
async function syncOne(idToken, t, retry) {
  const id = t.date + '_' + t.seq;
  const head = 'ตั๋ว ' + t.seq + ' (' + esc(t.plateRaw) + ', ' + beDate(t.date) + ')';
  const old = await getDoc(idToken, 'weighings', id);
  if (!old) {
    if (t.cancel) {
      await logEdit(idToken, id, t, false, 'ตั๋วยกเลิกใน THEO (ไม่ได้สร้างในแอป)');   // ล้ม = throw → ไม่ accepted → ส่งใหม่
      return { kind: 'skipped', alert: '🚫 ' + head + ' ถูก<b>ยกเลิก</b>ใน THEO (ไม่ได้ลงในแอป)' };
    }
    // สร้างแบบ "ต้องยังไม่มี" — ถ้าตัวนำเข้า CSV/รอบอื่นสร้างตัดหน้า (409) → อ่านใหม่แล้วไปทางอัปเดต ไม่ทับราคา
    const made = await createDocId(idToken, 'weighings', id, newDocFields(t));
    if (!made) { if (retry) throw new Error('create conflict'); return syncOne(idToken, t, true); }
    let alert = null;
    if (t.adjKg > 0) alert = '➖ ตั๋วใหม่ ' + head + ' มีหักน้ำหนัก ' + fmt(t.adjKg) + ' กก.' + (t.remark ? ' — ' + esc(t.remark) : ' — <b>ไม่ใส่หมายเหตุ</b>');
    return { kind: 'created', alert: alert };
  }
  const oldHash = fval(old, 'theoHash');
  if (oldHash && oldHash === t.hash) return { kind: 'unchanged' };
  const diffs = diffOf(old, t, !oldHash);   // แต่ละข้อ escape แล้ว
  const upd = theoFields(t);
  if (!t.cancel) {
    // ปกติ → อัปเดตเฉพาะช่องของตาชั่ง (ไม่แตะ price/sale_unit/sale_amount/pay_method)
    upd.kg = num(t.net); upd.plate = str(t.plate); upd.product = str(t.product || 'ทราย'); upd.time = str(t.time);
    const oldCust = fval(old, 'customer');
    if (t.customer && !fval(old, 'customerOriginal') && (!oldCust || oldCust === GENERAL)) upd.customer = str(t.customer);
  }
  // ตั๋วยกเลิก → เก็บแค่ theo* (theoCancel=true) ไม่เปลี่ยนยอด/ลูกค้าในแอป ให้คนลบเอง
  // บันทึกประวัติ (scale_edits) ก่อนแก้ตั๋ว: ถ้าบันทึกล้ม → throw ตั๋วไม่ถูกแตะ ส่งใหม่รอบหน้า (ประวัติไม่หาย)
  if (diffs.length) await logEdit(idToken, id, t, !oldHash, diffs.join(' | ').replace(/<\/?b>/g, ''));
  // เขียนแบบมีเงื่อนไข updateTime: ถ้าคนแก้ในแอปพอดีระหว่างนี้ → อ่านใหม่แล้วลองอีกครั้ง (ไม่ทับลูกค้าที่เพิ่งแก้)
  const okW = await patchDoc(idToken, 'weighings', id, upd, Object.keys(upd), old.updateTime);
  if (!okW) { if (retry) throw new Error('update conflict'); return syncOne(idToken, t, true); }
  if (!diffs.length) return { kind: 'updated' };
  return {
    kind: 'updated',
    alert: (t.cancel ? '🚫 ' : '✏️ ') + head + ' ' + (oldHash ? 'ถูกแก้ใน THEO' : 'ข้อมูลไม่ตรงกับที่นำเข้าจาก CSV') + ':\n   ' + diffs.join('\n   ')
  };
}
function logEdit(idToken, id, t, firstSync, changes) {
  return createDoc(idToken, 'scale_edits', {
    ticketId: str(id), seq: str(t.seq), plate: str(t.plateRaw), at: str(new Date().toISOString()),
    firstSync: { booleanValue: !!firstSync }, cancel: { booleanValue: !!t.cancel }, changes: str(changes)
  });
}

// ---------- แปลง/ตรวจข้อมูลที่ส่งมา ----------
function clean(r) {
  if (!r || typeof r !== 'object') return null;
  const seq = String(r.seq || '').trim();
  const date = String(r.date || '').trim();
  if (!/^\d{1,10}$/.test(seq) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;   // ยังไม่ชั่งออก / ข้อมูลไม่ครบ
  const n = function (v) { const x = Number(v); return isFinite(x) ? Math.round(x * 100) / 100 : 0; };
  const s = function (v, m) { return String(v == null ? '' : v).trim().slice(0, m || 120); };
  const t = {
    seq: seq, date: date, time: /^\d{1,2}:\d{2}(:\d{2})?$/.test(s(r.time)) ? s(r.time) : '',
    plate: s(r.plate, 30).replace(/[^0-9\-]/g, ''), plateRaw: s(r.plate, 30),
    customer: s(r.customer), product: s(r.product, 60), weighType: s(r.weighType, 30),
    wIn: n(r.wIn), wOut: n(r.wOut), gross: n(r.gross), net: n(r.net),
    adjKg: n(r.adjKg), adjPct: n(r.adjPct), remark: s([r.remark1, r.remark2, r.remark3].filter(Boolean).join(' / '), 150),
    cancel: r.cancel === true || r.cancel === 'Y', printOut: Math.max(0, Math.floor(n(r.printOut))),
    userIn: s(r.userIn, 40), userOut: s(r.userOut, 40), dataId: s(r.dataId, 60), hash: String(r.hash == null ? '' : r.hash).trim()
  };
  // hash = DataHash|พิมพ์ซ้ำ|ยกเลิก — ห้ามตัดสั้น (ตัดแล้วส่วนท้ายหาย = จับการยกเลิก/พิมพ์ซ้ำไม่ได้) ยาวเกินถือว่าผิดรูป
  if (!t.hash || t.hash.length > 200 || !t.dataId) return null;
  return t;
}
function theoFields(t) {
  return {
    source: str('theo-sync'), theoDataId: str(t.dataId), theoHash: str(t.hash), theoPlate: str(t.plateRaw),
    theoCustomer: str(t.customer), theoWeighType: str(t.weighType),
    theoWeightIn: num(t.wIn), theoWeightOut: num(t.wOut), theoGross: num(t.gross), theoNet: num(t.net),
    theoAdjKg: num(t.adjKg), theoAdjPct: num(t.adjPct), theoRemark: str(t.remark), theoCancel: { booleanValue: t.cancel },
    theoPrintOut: { integerValue: String(t.printOut) }, theoUserIn: str(t.userIn), theoUserOut: str(t.userOut),
    theoSyncedAt: str(new Date().toISOString())
  };
}
function newDocFields(t) {
  const f = theoFields(t);
  f.seq = str(t.seq); f.date = str(t.date); f.time = str(t.time); f.plate = str(t.plate);
  f.customer = str(t.customer || GENERAL); f.product = str(t.product || 'ทราย'); f.kg = num(t.net);
  f.importedAt = str(new Date().toISOString()); f.importedBy = str('scale-sync'); f.fileName = str('THEO อัตโนมัติ');
  return f;
}
function diffOf(old, t, fromCsv) {
  const d = [];
  const ok = Number(fval(old, 'theoNet') != null ? fval(old, 'theoNet') : fval(old, 'kg')) || 0;
  if (Math.abs(ok - t.net) > 0.001) d.push('น้ำหนักสุทธิ ' + fmt(ok) + ' → ' + fmt(t.net) + ' กก.');
  if (!fromCsv) {
    const pairs = [['theoWeightIn', 'wIn', 'นน.ชั่งเข้า'], ['theoWeightOut', 'wOut', 'นน.ชั่งออก'], ['theoAdjKg', 'adjKg', 'หักน้ำหนัก(กก.)'], ['theoAdjPct', 'adjPct', 'หักน้ำหนัก(%)']];
    pairs.forEach(function (p) { const a = Number(fval(old, p[0])) || 0; if (Math.abs(a - t[p[1]]) > 0.001) d.push(p[2] + ' ' + fmt(a) + ' → ' + fmt(t[p[1]])); });
    const oc = fval(old, 'theoCustomer') || ''; if (oc !== t.customer) d.push('ลูกค้า "' + esc(oc) + '" → "' + esc(t.customer) + '"');
    const op = fval(old, 'theoPlate') || ''; if (op !== t.plateRaw) d.push('ทะเบียน ' + esc(op) + ' → ' + esc(t.plateRaw));
    const orm = fval(old, 'theoRemark') || ''; if (orm !== t.remark) d.push('หมายเหตุ "' + esc(orm) + '" → "' + esc(t.remark) + '"');
    if (!fval(old, 'theoCancel') && t.cancel) d.push('<b>ยกเลิกตั๋ว</b> — ยอดนี้ยังอยู่ในแอป ต้องลบเองถ้ายกเลิกจริง');
    const pr = Number(fval(old, 'theoPrintOut')) || 0; if (t.printOut > pr && pr > 0) d.push('พิมพ์ตั๋วซ้ำ (ครั้งที่ ' + t.printOut + ')');
  } else {
    const oc = fval(old, 'customer') || ''; if (t.customer && oc && oc !== GENERAL && oc !== t.customer && !fval(old, 'customerOriginal')) d.push('ลูกค้าในแอป "' + esc(oc) + '" / THEO "' + esc(t.customer) + '"');
    if (t.cancel) d.push('<b>ตั๋วนี้ถูกยกเลิกใน THEO</b> แต่มียอดในแอป');
  }
  return d;
}

// ---------- รหัสตาชั่ง ----------
async function keyOk(request) {
  const k = request.headers.get('x-scale-key') || '';
  if (k.length < 32) return false;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(k));
  const hex = Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  let diff = hex.length ^ SCALE_KEY_SHA256.length;
  for (let i = 0; i < hex.length && i < SCALE_KEY_SHA256.length; i++) diff |= hex.charCodeAt(i) ^ SCALE_KEY_SHA256.charCodeAt(i);
  return diff === 0;
}

// ---------- Firestore REST ----------
async function login(env) {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FB_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.FB_EMAIL, password: env.FB_PASSWORD, returnSecureToken: true })
  });
  const j = await r.json();
  if (!j.idToken) throw new Error('login fail');
  return j.idToken;
}
async function getDoc(idToken, coll, id) {
  const r = await fetch(`${FS}/${coll}/${encodeURIComponent(id)}`, { headers: { 'Authorization': 'Bearer ' + idToken } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('get fail ' + r.status);
  return await r.json();
}
// updateTime (ถ้าให้มา) = เขียนได้เฉพาะเมื่อเอกสารยังไม่ถูกแก้หลังจากที่อ่าน → ชนกัน (400/409) คืน false
async function patchDoc(idToken, coll, id, fields, mask, updateTime) {
  const q = [];
  if (mask && mask.length) mask.forEach(function (m) { q.push('updateMask.fieldPaths=' + encodeURIComponent(m)); });
  if (updateTime) q.push('currentDocument.updateTime=' + encodeURIComponent(updateTime));
  const u = `${FS}/${coll}/${encodeURIComponent(id)}` + (q.length ? '?' + q.join('&') : '');
  const r = await fetch(u, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
    body: JSON.stringify({ fields })
  });
  if (updateTime && (r.status === 400 || r.status === 409)) return false;
  if (!r.ok) throw new Error('write fail ' + r.status);
  return true;
}
// สร้างเอกสารด้วย id ที่กำหนด แบบ "ต้องยังไม่มี" → true = สร้างแล้ว, false = มีอยู่แล้ว (409)
async function createDocId(idToken, coll, id, fields) {
  const r = await fetch(`${FS}/${coll}?documentId=${encodeURIComponent(id)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
    body: JSON.stringify({ fields })
  });
  if (r.status === 409) return false;
  if (!r.ok) throw new Error('create fail ' + r.status);
  return true;
}
async function createDoc(idToken, coll, fields) {
  const r = await fetch(`${FS}/${coll}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
    body: JSON.stringify({ fields })
  });
  if (!r.ok) throw new Error('create fail ' + r.status);
}
function fval(doc, f) {
  const v = doc && doc.fields && doc.fields[f]; if (!v) return undefined;
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('integerValue' in v) return Number(v.integerValue);
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  return undefined;
}
function str(v) { return { stringValue: String(v == null ? '' : v) }; }
function num(v) { return { doubleValue: Number(v) || 0 }; }
// ส่ง Telegram: ถ้าแบบ HTML ถูกปฏิเสธ (เช่นตัดข้อความกลางแท็ก) → ส่งซ้ำเป็นข้อความธรรมดา · คืน true/false
async function tgSend(token, chatId, text) {
  const send = function (payload) {
    return fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    }).then(function (r) { return r.ok; }).catch(function () { return false; });
  };
  if (await send({ chat_id: chatId, text: text.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true })) return true;
  const plain = text.replace(/<\/?b>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return await send({ chat_id: chatId, text: plain.slice(0, 4000), disable_web_page_preview: true });
}
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function fmt(n) { return Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 }); }
function pad7(n) { return String(n).padStart(7, '0'); }
function beDate(ymd) { const p = ymd.split('-'); return parseInt(p[2]) + '/' + p[1] + '/' + (parseInt(p[0]) + 543); }
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
}
