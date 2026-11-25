// บันทึกผลรันรายฟังก์ชัน (แบบ r27 ข้อ 2.3 · หลักฐานก่อนขั้น 4 เปลี่ยนรหัส admin@/staff@)
// เขียน app_meta/fn_run_<ชื่อ> ด้วยบัญชีของฟังก์ชันเอง (FB_EMAIL/FB_PASSWORD = server@) → uid ในบันทึก = บัญชีที่ฟังก์ชันใช้จริง
// ok = คำตอบ 2xx และไม่มี ok:false (ฟังก์ชันตอบ ok:true เฉพาะเมื่องานหลักของรอบเสร็จทุกขั้น · รอบที่ "ข้าม" เพราะทำไปแล้ว/ยังไม่ถึงเวลา = ok + ช่อง skipped)
// exception จากฟังก์ชัน = บันทึก ok:false err 'exception' แล้วโยนต่อ
// uid = บัญชีจาก FB_EMAIL/FB_PASSWORD ชุดเดียวกับที่ฟังก์ชันใช้ในคำขอเดียวกัน (ฟังก์ชันทั้ง 5 ล็อกอินด้วย env คู่นี้เท่านั้น)
// ข้อความเก็บผ่านตัวกรอง: ตัดสตริงยาวที่หน้าตาเหมือนรหัส/token ออก · extra เก็บเฉพาะช่องที่ pick เลือก (ตัวเลข/รหัสตั๋ว)
// best-effort: บันทึกไม่ได้ไม่กระทบคำตอบของฟังก์ชัน
const FB_API_KEY = 'AIzaSyAaxKbw-MKrsVnCEw6IY_cYkiWsp1Ql8SA';   // public apiKey
const FS = 'https://firestore.googleapis.com/v1/projects/thanasetsiri2546-20cb6/databases/(default)/documents';

// extra เก็บตามชนิดที่ผู้เรียกกำหนดรายช่อง (spec) เท่านั้น — ไม่เก็บข้อความจากภายนอก:
//   'num' = ตัวเลข · 'date' = YYYY-MM-DD · 'ids' = รายการรหัสตั๋วตาชั่ง YYYY-MM-DD_<เลข> (ไม่ใช่ข้อมูลลับ) · อย่างอื่น/ไม่ตรงชนิด = null
function typed(kind, v) {
  if (kind === 'num') return typeof v === 'number' && isFinite(v) ? v : null;
  if (kind === 'date') return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  if (kind === 'ids') return Array.isArray(v) ? v.slice(0, 300).filter(function (x) { return typeof x === 'string' && /^\d{4}-\d{2}-\d{2}_\d{1,12}$/.test(x); }) : null;
  return null;
}
export async function withRunLog(context, name, handler, spec) {
  let res;
  try { res = await handler(context); }
  catch (e) {
    const p0 = writeRun(context.env, name, { at: new Date(), ok: false, status: 0, err: 'exception', skipped: '', extra: '' }).catch(function () {});
    if (context && typeof context.waitUntil === 'function') context.waitUntil(p0); else await p0;
    throw e;
  }
  if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 405) return res;   // คำขอที่ไม่ผ่านการยืนยัน ไม่ใช่รอบงาน
  const p = (async function () {
    let j = null;
    try { j = await res.clone().json(); } catch (e) {}
    const ok = res.status >= 200 && res.status < 300 && !!j && j.ok === true;   // ต้องตอบ ok:true ชัดเจน (อ่านไม่ได้ = ไม่ ok)
    j = j || {};
    await writeRun(context.env, name, {
      at: new Date(), ok: ok, status: res.status,
      err: ok ? '' : ('http_' + res.status),          // รหัสคงที่ (ไม่เก็บข้อความ error จากภายนอก)
      skipped: j.skipped ? 'yes' : '',
      extra: spec ? JSON.stringify(Object.keys(spec).reduce(function (o, k) { o[k] = typed(spec[k], j[k]); return o; }, {})) : ''
    });
  })().catch(function () {});
  if (context && typeof context.waitUntil === 'function') context.waitUntil(p); else await p;
  return res;
}

async function writeRun(env, name, f) {
  const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + FB_API_KEY, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.FB_EMAIL, password: env.FB_PASSWORD, returnSecureToken: true })
  });
  const j = await r.json();
  if (!j.idToken) return;
  f.uid = j.localId || '';
  f.email = String(env.FB_EMAIL || '');
  f.commit = String(env.CF_PAGES_COMMIT_SHA || '').slice(0, 40);
  const fields = {};
  Object.keys(f).forEach(function (k) {
    const v = f[k];
    fields[k] = v instanceof Date ? { timestampValue: v.toISOString() } : typeof v === 'boolean' ? { booleanValue: v }
      : typeof v === 'number' ? { integerValue: String(Math.floor(v)) } : { stringValue: String(v) };
  });
  await fetch(FS + '/app_meta/fn_run_' + name, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + j.idToken },
    body: JSON.stringify({ fields: fields })
  });
}
