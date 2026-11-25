// ============================================================
// ตัวล็อกการกด PIN ผิด + บัตรเครื่อง + revoke ซ้ำ (แบบ r27 ข้อ 2.1 / 2.5 · คุณหลิงเคาะ 24 พ.ย. 69)
//
// ตัวนับ (tha_login_guard/*) — นับแบบ transaction เดียวกับการตรวจ PIN:
//   เครื่องแปลก : ip_<hash>  ผิด 5 ใน 1 ชม. → ล็อก IP · global  ผิดรวม 5 ใน 1 ชม. → ล็อกเครื่องแปลกทุกเครื่อง
//   เครื่องรู้จัก: dev_<hash> ผิด 10 ใน 1 ชม. → ล็อกเครื่องนั้น · known ผิดรวม 30 ใน 24 ชม. → ล็อกเครื่องรู้จักทุกเครื่อง
//   pin-change : + uid_<hash> ผิด 5 ใน 1 ชม.
//   ระยะล็อก 15 นาที · ล็อกซ้ำภายใน 24 ชม. นานขึ้นเท่าตัว สูงสุด 24 ชม. · ไม่ผิดเลย 24 ชม. = เริ่มระดับใหม่
// บัตรเครื่อง: cookie __Host-tha_dev (สุ่ม 256 บิต) · ฐานเก็บแค่ SHA-256 ใน tha_devices/{hash}
//   ใช้ได้ = พบ + อยู่ในรายการ meta + gen ตรง meta + ver ตรง tha_auth ของบทบาท + ยังไม่หมดอายุ
// ห้าม log PIN / บัตร / IP เต็ม
// ============================================================
import {
  json, sha256hex, safeEq, pinHash, randomHex, withTx, txGet, rollback, commit, wUpdate, wDelete, fv,
  getDocSA, revokeUid, lookupUser, roleUids, tgSend
} from './tha-auth.js';

const MIN = 60000, HOUR = 3600000, DAY = 86400000;
export const LOCK_BASE_MS = 15 * MIN;
export const CAPS = {
  ip: { cap: 5, win: HOUR }, global: { cap: 5, win: HOUR },
  dev: { cap: 10, win: HOUR }, known: { cap: 30, win: DAY },
  uid: { cap: 5, win: HOUR }
};
export const DEV_COOKIE = '__Host-tha_dev';
const DEV_TTL = 180 * DAY, DEV_MAX = 20, DEV_PER_DAY = 5, STALE_MS = 30 * DAY;
export const REVOKE_AGAIN_AFTER_MS = 6 * MIN;     // custom token 5 นาที + เผื่อ 1 นาที
export const CUSTOM_TOKEN_MS = 5 * MIN;
const LEASE_MS = 2 * MIN, LEASE_MARGIN_MS = 60000;   // จองงาน revoke 2 นาที · เหลือน้อยกว่า 1 นาทีก่อนเรียก revoke = ไม่ทำ
const META = 'tha_devices_meta/main';
const KIND_TH = { ip: 'IP เดียว', global: 'เครื่องแปลกทั้งหมด', dev: 'เครื่องเดียว (เครื่องที่เคยเข้า)', known: 'เครื่องที่เคยเข้าทั้งหมด', uid: 'การเปลี่ยน PIN ของ admin' };

// ---------- บัตรเครื่องจาก cookie ----------
// คืน { raw } ถ้ามี cookie ชื่อนี้ใบเดียวและรูปแบบถูก · อย่างอื่น = null (เครื่องแปลก)
export function deviceCookie(request) {
  const h = request.headers.get('Cookie') || '';
  const vals = [];
  h.split(';').forEach(function (part) {
    const i = part.indexOf('='); if (i < 0) return;
    if (part.slice(0, i).trim() === DEV_COOKIE) vals.push(part.slice(i + 1).trim());
  });
  if (vals.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(vals[0])) return null;
  return vals[0];
}
function newDeviceRaw() {
  const a = new Uint8Array(32); crypto.getRandomValues(a);
  let s = ''; for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function deviceSetCookie(raw) {
  return DEV_COOKIE + '=' + raw + '; Max-Age=' + Math.floor(DEV_TTL / 1000) + '; Path=/; Secure; HttpOnly; SameSite=Strict';
}
export async function devHash(raw) { return sha256hex('tha_dev|' + raw); }
export async function counterPath(env, kind, raw) {
  if (kind === 'global' || kind === 'known') return 'tha_login_guard/' + kind;
  return 'tha_login_guard/' + kind + '_' + (await sha256hex(env.PIN_PEPPER + '|' + kind + '|' + raw)).slice(0, 40);
}
function bkkDay(ms) { return new Date(ms + 7 * HOUR).toISOString().slice(0, 10).replace(/-/g, ''); }
function n(d, f) { return Number(fv(d, f) || 0); }

// บัตรเครื่องใช้ได้ไหม (เรียกภายใน transaction ด้วยเอกสารที่อ่านมาในธุรกรรมเดียวกัน) · คืนบทบาท หรือ null
export function knownDeviceRole(d, meta, auth, dh, now) {
  if (!d || !meta || !dh) return null;
  const role = fv(d, 'role');
  if (role !== 'admin' && role !== 'staff') return null;
  const list = parseList(meta);
  const ok = n(d, 'expiresAt') > now
    && String(fv(d, 'gen') || '') === String(fv(meta, 'gen') || '') && String(fv(meta, 'gen') || '') !== ''
    && n(d, 'ver') > 0 && n(d, 'ver') === n(auth[role], 'ver')
    && list.some(function (x) { return x.h === dh; });
  return ok ? role : null;
}

// ---------- กติกาตัวนับ ----------
export function counterState(d) {
  return { count: n(d, 'count'), firstFailAt: n(d, 'firstFailAt'), lastFailAt: n(d, 'lastFailAt'),
    lockUntil: n(d, 'lockUntil'), level: n(d, 'level'), lastLockAt: n(d, 'lastLockAt'),
    unlockId: fv(d, 'unlockId') || '', notifiedAt: n(d, 'notifiedAt') };
}
// ผิด 1 ครั้ง → สถานะใหม่ + locked (เพิ่งล็อกรอบนี้หรือไม่)
export function applyFail(c, now, cap, win) {
  c = Object.assign({}, c);
  if (c.lockUntil && c.lockUntil <= now) { c.lockUntil = 0; c.count = 0; c.firstFailAt = 0; c.unlockId = ''; }   // ล็อกหมดเวลา
  if (c.lastFailAt && now - c.lastFailAt >= DAY) c.level = 0;                                                   // ไม่ผิดเลย 24 ชม.
  if (!c.firstFailAt || now - c.firstFailAt > win) { c.count = 0; c.firstFailAt = now; }
  c.count += 1; c.lastFailAt = now;
  let locked = false;
  if (c.count >= cap) {
    c.level = (c.level > 0 && c.lastLockAt && now - c.lastLockAt < DAY) ? c.level + 1 : 1;
    c.lockUntil = now + Math.min(DAY, LOCK_BASE_MS * Math.pow(2, c.level - 1));
    c.lastLockAt = now; c.count = 0; c.firstFailAt = 0; c.notifiedAt = 0;
    c.unlockId = randomHex(16); locked = true;
  }
  return { c: c, locked: locked };
}
export function clearFails(c, now) {
  c = Object.assign({}, c);
  if (c.lockUntil && c.lockUntil <= now) { c.lockUntil = 0; c.unlockId = ''; }
  c.count = 0; c.firstFailAt = 0;
  return c;
}

// ---------- ตรวจ PIN + นับ + บัตรเครื่อง ใน transaction เดียว ----------
// opts: { ip, devRaw, uidKey (pin-change), requireKnownRole ('admin' = ต้องเป็นเครื่องรู้จักของ admin),
//         acceptRole ('admin' = PIN ของบทบาทอื่นนับเป็น "ผิด" — ใช้ใน pin-change กันใช้ PIN staff ล้างตัวนับ), issueDevice (bool) }
// commitMs = เวลา "ก่อน" ส่ง commit (ไม่ช้ากว่า commit จริง) → exp ของ custom token นับจากเวลานี้ไม่เกิน 5 นาทีหลัง commit แน่นอน
// คืน { status:'locked', until } | { status:'wrong', locks } | { status:'device' }
//     | { status:'ok', role, ver, commitMs, newDevRaw, locks:[], quotaAlert }
export async function pinAttempt(env, pin, opts) {
  const now0 = Date.now();
  const devRaw = opts.devRaw || null;
  const dh = devRaw ? await devHash(devRaw) : null;
  const P = {
    ip: await counterPath(env, 'ip', opts.ip || '0.0.0.0'), global: 'tha_login_guard/global',
    dev: dh ? await counterPath(env, 'dev', dh) : null, known: 'tha_login_guard/known',
    uid: opts.uidKey ? await counterPath(env, 'uid', opts.uidKey) : null
  };
  const out = await withTx(env, async function (tx) {
    const now = Date.now();
    const paths = ['tha_auth/admin', 'tha_auth/staff', META, P.ip, P.global, P.known];
    if (dh) paths.push('tha_devices/' + dh, P.dev);
    if (P.uid) paths.push(P.uid);
    const got = await txGet(env, tx, paths);           // อ่านไม่สำเร็จ = โยน error → ตอบ "ลองใหม่"
    const meta = got[META];
    const auth = { admin: got['tha_auth/admin'], staff: got['tha_auth/staff'] };
    // เครื่องรู้จัก?
    const devRole = dh ? knownDeviceRole(got['tha_devices/' + dh], meta, auth, dh, now) : null;
    const known = !!devRole;
    if (opts.requireKnownRole && devRole !== opts.requireKnownRole) { await rollback(env, tx); return { status: 'device' }; }
    const kinds = known ? ['dev', 'known'] : ['ip', 'global'];
    if (P.uid) kinds.push('uid');
    const st = {};
    kinds.forEach(function (k) { st[k] = counterState(got[P[k]]); });
    let until = 0;
    kinds.forEach(function (k) { if (st[k].lockUntil > now) until = Math.max(until, st[k].lockUntil); });
    if (until) { await rollback(env, tx); return { status: 'locked', until: until }; }

    // ตรวจ PIN กับทั้ง 2 บทบาท (คำนวณทั้งคู่เสมอ)
    let hit = null;
    for (const role of ['admin', 'staff']) {
      const d = auth[role];
      const salt = fv(d, 'salt'), h = fv(d, 'hash');
      const calc = await pinHash(env, salt || 'x', pin);
      if (salt && h && safeEq(calc, h) && !hit) hit = { role: role, ver: n(d, 'ver') };
    }
    if (hit && opts.acceptRole && hit.role !== opts.acceptRole) hit = null;   // PIN บทบาทอื่น = ผิด (นับ)
    const writes = [], locks = [];
    if (!hit) {
      kinds.forEach(function (k) {
        const r = applyFail(st[k], now, CAPS[k].cap, CAPS[k].win);
        writes.push(wUpdate(env, P[k], r.c));
        if (r.locked) {
          locks.push({ path: P[k], kind: k, level: r.c.level, until: r.c.lockUntil, unlockId: r.c.unlockId });
          writes.push(wUpdate(env, 'tha_unlock/' + r.c.unlockId, { counter: P[k], until: r.c.lockUntil }));
        }
      });
      await commit(env, tx, writes);
      return { status: 'wrong', locks: locks };
    }
    // ถูก: ล้างครั้งผิดของ ip/dev/uid ของคำขอนี้ (ไม่ล้าง global/known · ไม่ล้างระดับ)
    kinds.forEach(function (k) { if (k !== 'global' && k !== 'known') writes.push(wUpdate(env, P[k], clearFails(st[k], now))); });
    // เครื่องที่รู้จัก: ต่ออายุเฉพาะเมื่อจะส่ง cookie ต่ออายุด้วย (login ปกติ) — โหมดตรวจ PIN อย่างเดียวไม่แตะ (อายุสองฝั่งตรงกัน)
    if (known && opts.touchDevice && devRole === hit.role) {
      writes.push(wUpdate(env, 'tha_devices/' + dh, { expiresAt: now + DEV_TTL, lastOkAt: now }, { mask: true }));
      writes.push(wUpdate(env, META, metaFields(meta, touchList(parseList(meta), dh, now), now, 0), { mask: true }));
    }
    const preCommit = Date.now();                       // ก่อนส่ง commit = ไม่ช้ากว่าเวลา commit จริง
    await commit(env, tx, writes);
    return { status: 'ok', role: hit.role, ver: hit.ver, commitMs: preCommit, locks: [], known: known, devRole: devRole, dh: dh };
  }, 3);
  if (out.locks && out.locks.length) await notifyLocks(env, out.locks);
  return out;
}

// ออกบัตรเครื่องใหม่ — ทำ "หลัง" ออก custom token สำเร็จแล้วเท่านั้น (ไม่เปลืองโควตาเมื่อขั้นออกบัตรผ่านล้ม)
// transaction เดียว: เช็ก ver ของบทบาทยังเดิม + โควตา 5/วัน + รายการ ≤ 20 · คืน raw หรือ null
// keepHash: บัตรเดิมของเครื่องนี้ (อีกบทบาท) — ห้ามหลุดรายการแม้รายการเต็ม
export async function issueDevice(env, role, ver, keepHash) {
  let quotaAlert = false, fullAlert = false;
  const raw = await withTx(env, async function (tx) {
    const now = Date.now();
    const got = await txGet(env, tx, [META, 'tha_auth/' + role]);
    if (n(got['tha_auth/' + role], 'ver') !== ver) { await rollback(env, tx); return null; }
    const meta = got[META];
    const day = bkkDay(now);
    const issued = fv(meta, 'issuedDay') === day ? n(meta, 'issuedCount') : 0;
    if (issued >= DEV_PER_DAY) {
      if (fv(meta, 'overAlertDay') !== day) { quotaAlert = true; await commit(env, tx, [wUpdate(env, META, { overAlertDay: day }, { mask: true })]); }
      else await rollback(env, tx);
      return null;
    }
    const r = newDeviceRaw();
    const nh = await devHash(r);
    const gen = (meta && fv(meta, 'gen')) || randomHex(16);
    // รายการเต็ม 20: เอาออกได้เฉพาะใบที่ไม่ได้ใช้เกิน 30 วัน (และไม่ใช่บัตรเดิมของเครื่องนี้) · ไม่มี = ไม่ออกใบใหม่ (ไม่ดันบัตรที่ใช้งานอยู่หลุด)
    let list = parseList(meta);
    if (list.length >= DEV_MAX) {
      const stale = list.filter(function (x) { return x.h !== keepHash && now - x.t > STALE_MS; }).sort(function (a, b) { return a.t - b.t; })[0];
      if (!stale) {
        if (fv(meta, 'fullAlertDay') !== day) { fullAlert = true; await commit(env, tx, [wUpdate(env, META, { fullAlertDay: day }, { mask: true })]); }
        else await rollback(env, tx);
        return null;
      }
      list = list.filter(function (x) { return x.h !== stale.h; });
    }
    const mf = metaFields(meta, touchList(list, nh, now, keepHash), now, 1);
    mf.gen = gen;
    await commit(env, tx, [
      wUpdate(env, 'tha_devices/' + nh, { role: role, ver: ver, gen: gen, createdAt: now, expiresAt: now + DEV_TTL, lastOkAt: now }),
      wUpdate(env, META, mf, { mask: true })
    ]);
    return r;
  }, 3);
  if (fullAlert) tgSend(env, '⚠️ แอปท่าทราย: เครื่องที่จำไว้ครบ ' + DEV_MAX + ' เครื่องที่ยังใช้งานอยู่ — เครื่องใหม่เข้าได้แต่ไม่ถูกจำ · ถ้าต้องการ กด 🛡️ ล้างเครื่องที่จำไว้ทั้งหมด').catch(function () {});
  if (quotaAlert) tgSend(env, '⚠️ แอปท่าทราย: ออกบัตรเครื่องใหม่ครบ ' + DEV_PER_DAY + ' เครื่องแล้ววันนี้ — เครื่องใหม่หลังจากนี้เข้าได้แต่ระบบไม่จำเครื่อง (ถ้าไม่ใช่พนักงานเปลี่ยนเครื่องเอง ให้เปลี่ยน PIN)').catch(function () {});   // ไม่รอ
  return raw;
}
// ตัวนับที่เกี่ยวกับคำขอ pin-change (ใช้ตรวจซ้ำใน transaction เขียน PIN)
export async function pinChangeCounterPaths(env, devRaw, uidKey) {
  const dh = await devHash(devRaw);
  return [await counterPath(env, 'dev', dh), 'tha_login_guard/known', await counterPath(env, 'uid', uidKey)];
}
export function anyLocked(docs, now) { return docs.some(function (d) { return counterState(d).lockUntil > now; }); }
function parseList(meta) {
  try { const a = JSON.parse(fv(meta, 'listJson') || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}
// keep: บัตรที่ต้องไม่หลุดรายการ (บัตรเดิมของเครื่องที่กำลังขอใบใหม่ — ถ้าเบราว์เซอร์ไม่ได้รับใบใหม่ ใบเดิมต้องยังใช้ได้)
function touchList(list, h, now, keep) {
  list = list.filter(function (x) { return x && x.h !== h; });
  list.push({ h: h, t: now });
  list.sort(function (a, b) { return b.t - a.t; });
  if (keep && list.length > DEV_MAX && list.slice(0, DEV_MAX).every(function (x) { return x.h !== keep; })) {
    const k = list.find(function (x) { return x.h === keep; });
    if (k) list = list.filter(function (x) { return x.h !== keep; }).slice(0, DEV_MAX - 1).concat([k]);
  }
  return list.slice(0, DEV_MAX);                         // เกิน 20 = ใบเก่าสุด (ที่ไม่ใช่ keep) หลุดรายการ = ใช้ไม่ได้
}
function metaFields(meta, list, now, add) {
  const day = bkkDay(now);
  const issued = fv(meta, 'issuedDay') === day ? n(meta, 'issuedCount') : 0;
  const f = { listJson: JSON.stringify(list), issuedDay: day, issuedCount: issued + add };
  if (!meta || !fv(meta, 'gen')) f.gen = randomHex(16);
  return f;
}

// ---------- แจ้ง Telegram เมื่อล็อก (best-effort) ----------
function bkkHM(ms) { return new Date(ms + 7 * HOUR).toISOString().slice(11, 16); }
export async function notifyLocks(env, locks) {
  for (const l of locks) {
    try {
      const withBtn = env.TG_UNLOCK_ENABLED === '1';
      const short = l.path.split('/')[1].split('_').pop().slice(0, 6);
      const text = '🔒 แอปท่าทราย: ล็อกการกด PIN — ' + (KIND_TH[l.kind] || l.kind) + ' (' + short + ') ระดับ ' + l.level + ' ถึง ' + bkkHM(l.until) + ' น.'
        + (withBtn ? '\nถ้าเป็นพนักงานกดผิดเอง คุณหลิงกดปุ่มปลดล็อกได้' : '\n(ปุ่มปลดล็อกยังไม่เปิดใช้ — รอหมดเวลา หรือลบตัวนับใน Firestore Console)');
      const extra = withBtn ? { reply_markup: { inline_keyboard: [[{ text: '🔓 ปลดล็อก', callback_data: 'thaul:' + l.unlockId }]] } } : {};
      const sent = await tgSend(env, text, extra);
      if (sent) await commit(env, null, [wUpdate(env, l.path, { notifiedAt: Date.now() }, { mask: true, mustExist: true })]).catch(function () {});
    } catch (e) {}
  }
}

// ---------- ปลดล็อกจากปุ่ม Telegram (ตรวจผู้กด/secret ที่ tg-webhook) ----------
// คืน 'ok' | 'stale'
export async function unlockById(env, unlockId) {
  if (!/^[0-9a-f]{32}$/.test(unlockId || '')) return 'stale';
  return withTx(env, async function (tx) {
    const ref = 'tha_unlock/' + unlockId;
    const g1 = await txGet(env, tx, [ref]);
    const counter = fv(g1[ref], 'counter');
    if (!counter || !/^tha_login_guard\/[a-z0-9_]+$/.test(counter)) { await rollback(env, tx); return 'stale'; }
    const g2 = await txGet(env, tx, [counter]);
    const c = counterState(g2[counter]);
    const now = Date.now();
    if (c.unlockId !== unlockId || !(c.lockUntil > now)) {
      await commit(env, tx, [wDelete(env, ref)]);
      return 'stale';
    }
    const nc = Object.assign({}, c, { lockUntil: 0, count: 0, firstFailAt: 0, unlockId: '' });   // ระดับ + lastLockAt ยังจำ
    await commit(env, tx, [wUpdate(env, counter, nc), wDelete(env, ref),
      wUpdate(env, 'tha_login_guard_log/' + randomHex(12), { what: 'unlock', counter: counter, at: now })]);
    return 'ok';
  });
}

// ---------- ล้างเครื่องทั้งหมด (ปุ่ม admin) ----------
export async function clearAllDevices(env) {
  await withTx(env, async function (tx) {
    await txGet(env, tx, [META]);
    await commit(env, tx, [wUpdate(env, META, { gen: randomHex(16), listJson: '[]', issuedCount: 0, overAlertDay: '' }, { mask: true })]);   // ล้างโควตาวันนี้ด้วย = ทางกู้เมื่อโควตาเต็ม
  });
}

// ---------- revoke ซ้ำรายบทบาท (แบบ r27 ข้อ 2.5) ----------
// ค้าง = revokedAgainVer ≠ ver · ทำได้เมื่อ ≥ เวลาเริ่มนับ + 6 นาที · บันทึกหลัง revoke สำเร็จเท่านั้น (ถ้า ver ยังเดิม)
// เวลาเริ่มนับ = verSeenAt: เวลาที่เซิร์ฟเวอร์ "เห็น" ver ใหม่ถูกบันทึกแล้วครั้งแรก (อ่านเจอหลัง commit จึงไม่เร็วกว่า commit จริง)
//   ผูกกับ ver ผ่าน verSeenFor — pin-change/pin-setup ประทับทันทีหลัง commit สำเร็จ · ไม่มี = ตัวกระตุ้นแรกที่เห็นประทับให้
//   (login ด้วย PIN เก่าต้อง commit ก่อน ver ใหม่ เพราะ transaction อ่าน tha_auth ชนกัน → token เก่าหมดอายุก่อน verSeenAt + 5 นาที)
// คืน { admin:{state,dueAt}, staff:{...} } state = 'done' | 'wait' | 'pending' | 'failed'
// opts.statusOnly = อ่านสถานะอย่างเดียว ไม่สั่ง revoke · state 'unknown' = ไม่มีเอกสาร/เลขรุ่น/changedAt (ไม่อ้างว่าเสร็จ)
export async function revokeAgainRun(env, opts) {
  opts = opts || {};
  const uids = roleUids(env);
  const out = {};
  for (const role of ['admin', 'staff']) {
    const path = 'tha_auth/' + role;
    let d;
    try { d = await getDocSA(env, path); } catch (e) {
      out[role] = { state: 'failed' };
      if (opts.alert) await tgSend(env, '⚠️ แอปท่าทราย: อ่านสถานะตัดบัตรเก่าของบทบาท ' + role + ' ไม่ได้ — ถ้าเพิ่งเปลี่ยน PIN ให้เปิดแท็บตั้งค่าดูสถานะ หรือแจ้งห้อง Code');
      continue;
    }
    const ver = n(d, 'ver');
    if (!d || !ver) {
      out[role] = { state: 'unknown' };
      if (opts.alert) await tgSend(env, '⚠️ แอปท่าทราย: ไม่พบข้อมูล PIN ของบทบาท ' + role + ' (tha_auth) — แจ้งห้อง Code');
      continue;
    }
    if (n(d, 'revokedAgainVer') === ver) {
      // ตรวจและซ่อม: เวลาตัดจริงใน Firebase ต้องไม่ต่ำกว่าเวลาตัดที่บันทึกไว้ (กันคำขอ revoke เก่าที่ไปถึงช้าเขียนทับ)
      // ตรวจกับ Firebase ทุกครั้ง (รวมหน้าสถานะ): done = ตรวจแล้ว validSince ≥ เวลาตัดที่บันทึก · unverified = ตรวจไม่ได้/ซ่อมไม่สำเร็จ
      // statusOnly = ตรวจอย่างเดียว ไม่ซ่อม (ต้องซ่อม → unverified ให้กดปุ่ม)
      const cut = n(d, 'revokedAgainCut');
      let vs = NaN;
      try { const u = await lookupUser(env, uids[role]); vs = u ? Number(u.validSince) : NaN; } catch (e) {}
      if (!Number.isFinite(vs) || vs < 0) {
        out[role] = { state: 'unverified', at: n(d, 'revokedAgainAt') };
        if (opts.alert) await tgSend(env, '⚠️ แอปท่าทราย: ตรวจเวลาตัดบัตรเก่าของบทบาท ' + role + ' กับ Firebase ไม่ได้ (รอบนี้) — ระบบจะลองใหม่รอบถัดไป · ถ้าเตือนซ้ำหลายรอบ แจ้งห้อง Code');
        continue;
      }
      if (!cut || vs < cut) {
        if (opts.statusOnly) { out[role] = { state: 'unverified', needRepair: true, at: n(d, 'revokedAgainAt') }; continue; }
        // ไม่มีเวลาตัดที่บันทึกไว้ หรือเวลาตัดจริงต่ำกว่าที่บันทึก (คำขอเก่าไปถึงช้าเขียนทับ) → ตัดใหม่ + บันทึกเวลาตัดใหม่
        let newCut = 0;
        try { newCut = await revokeUid(env, uids[role]); } catch (e) {}
        let saved = false, checkCut = 0;   // checkCut = เวลาตัดล่าสุดในฐาน (ใช้ตรวจ Firebase)
        // บันทึกเวลาตัดใหม่ใน transaction: ต้องยังเป็นรุ่นเดิม + done ของรุ่นนี้ + ไม่ลดค่าที่บันทึกไว้ (กันงานซ่อมเก่าทับรุ่นใหม่)
        if (newCut) {
          try {
            saved = await withTx(env, async function (tx) {
              const g = await txGet(env, tx, [path]);
              if (n(g[path], 'ver') !== ver || n(g[path], 'revokedAgainVer') !== ver) { await rollback(env, tx); return false; }
              if (n(g[path], 'revokedAgainCut') >= newCut) { checkCut = n(g[path], 'revokedAgainCut'); await rollback(env, tx); return true; }   // มีค่าใหม่กว่าอยู่แล้ว
              await commit(env, tx, [wUpdate(env, path, { revokedAgainCut: newCut }, { mask: true, mustExist: true })]);
              checkCut = newCut;
              return true;
            });
          } catch (e) { saved = false; }
        }
        if (cut || !saved) await tgSend(env, '⚠️ แอปท่าทราย: ' + (cut ? 'เวลาตัดบัตรเก่าของบทบาท ' + role + ' ถูกเขียนย้อนกลับ (คำขอที่ค้างในเครือข่ายไปถึงช้า)' : 'ยังไม่มีเวลาตัดบัตรเก่าที่บันทึกไว้ของบทบาท ' + role) + ' — ' + (saved ? 'ตัดใหม่ให้แล้ว' : 'ตัดใหม่ไม่สำเร็จ กด "revoke ซ้ำ" ในแท็บตั้งค่า / แจ้งห้อง Code'));
        const vOk = saved ? await verifyCut(env, uids[role], checkCut, path, ver) : false;   // อ่าน Firebase ซ้ำ เทียบกับเวลาตัดล่าสุดในฐาน + ยืนยันฐานไม่เปลี่ยนระหว่างตรวจ
        out[role] = { state: saved && vOk ? 'done' : 'unverified', repaired: saved, verified: vOk === true, at: n(d, 'revokedAgainAt') }; continue;
      }
      // ยืนยันว่าฐานไม่เปลี่ยน (รุ่น/เวลาตัด) ระหว่างอ่าน Firebase · เปลี่ยน = unverified (รอบหน้าตรวจใหม่)
      let same = false;
      try { const d2 = await getDocSA(env, path); same = n(d2, 'ver') === ver && n(d2, 'revokedAgainVer') === ver && n(d2, 'revokedAgainCut') === cut; } catch (e) {}
      out[role] = same ? { state: 'done', at: n(d, 'revokedAgainAt'), verified: true } : { state: 'unverified', changed: true, at: n(d, 'revokedAgainAt') }; continue;
    }
    let seenAt = n(d, 'verSeenFor') === ver ? n(d, 'verSeenAt') : 0;
    if (!seenAt) {
      try { seenAt = await stampVerSeen(env, role, ver); } catch (e) {
        out[role] = { state: 'failed' };
        if (opts.alert) await tgSend(env, '⚠️ แอปท่าทราย: เริ่มนับเวลาตัดบัตรเก่าของบทบาท ' + role + ' ไม่สำเร็จ — เปิดแท็บตั้งค่าดูสถานะ หรือแจ้งห้อง Code');
        continue;
      }
      if (!seenAt) { out[role] = { state: 'pending' }; continue; }        // ver เปลี่ยนระหว่างทาง
    }
    const dueAt = seenAt + REVOKE_AGAIN_AFTER_MS;
    if (Date.now() < dueAt) { out[role] = { state: 'wait', dueAt: dueAt }; continue; }
    if (opts.statusOnly) { out[role] = { state: 'pending', dueAt: dueAt }; continue; }
    let st = 'failed', lastCut = 0;
    try {
      // จองงาน: ผู้ทำได้ทีละราย ต่อ ver (กันตัวกระตุ้นพร้อมกันหลายตัว revoke ซ้ำหลังอีกตัวบันทึกเสร็จแล้ว ไปตัด session ใหม่)
      const leaseId = randomHex(8);
      let leaseStart = 0;
      const leaseUntil = await withTx(env, async function (tx) {
        const g = await txGet(env, tx, [path]);
        const now = Date.now();
        if (n(g[path], 'ver') !== ver) { await rollback(env, tx); return -2; }                 // เปลี่ยน PIN ระหว่างทาง
        if (n(g[path], 'revokedAgainVer') === ver) { await rollback(env, tx); return 0; }       // มีคนทำเสร็จแล้ว
        if (n(g[path], 'revokeLeaseVer') === ver && n(g[path], 'revokeLeaseUntil') > now) { await rollback(env, tx); return -1; }   // มีคนทำอยู่
        const until = now + LEASE_MS;
        leaseStart = now;
        await commit(env, tx, [wUpdate(env, path, { revokeLeaseVer: ver, revokeLeaseUntil: until, revokeLeaseId: leaseId, revokeCutSec: Math.floor(now / 1000) }, { mask: true, mustExist: true })]);
        return until;
      });
      if (leaseUntil === 0) st = 'done-other';
      else if (leaseUntil === -2) st = 'pending';
      else if (leaseUntil < 0) st = 'busy';
      else {
        try {
          if (Date.now() > leaseUntil - LEASE_MARGIN_MS) throw new Error('lease late');   // ช้าเกิน ไม่ revoke (รอบหน้าทำใหม่)
          // ความเสี่ยงที่ยอมรับ (ระดับต่ำ): คำขอที่ค้างเกินเวลาจอง / ทำซ้ำหลังบันทึกล้ม อาจตัด session ที่เพิ่งเข้าใหม่
          //   → ผู้ใช้กด PIN ใหม่ 1 ครั้ง ไม่กระทบความปลอดภัย (ไม่ตั้งเวลาตัดย้อนหลัง จึงไม่มีทางเปิด session เก่ากลับ)
          const cutSec = await revokeUid(env, uids[role]);
          lastCut = cutSec;
          st = await withTx(env, async function (tx) {
            const g = await txGet(env, tx, [path]);
            if (n(g[path], 'ver') !== ver) { await rollback(env, tx); return 'pending'; }   // เปลี่ยน PIN ระหว่างทาง = รอบใหม่ค้างต่อ
            if (fv(g[path], 'revokeLeaseId') !== leaseId) { await rollback(env, tx); return 'pending'; }
            await commit(env, tx, [wUpdate(env, path, { revokedAgainVer: ver, revokedAgainAt: Date.now(), revokedAgainCut: cutSec, revokeLeaseUntil: 0 }, { mask: true, mustExist: true })]);
            return 'done';
          });
        } catch (e) {
          st = 'failed';
          // ปล่อยงานที่จองไว้ (ถ้ายังเป็นของเรา) ให้รอบหน้าทำใหม่ได้ทันที
          try { await withTx(env, async function (tx) {
            const g = await txGet(env, tx, [path]);
            if (fv(g[path], 'revokeLeaseId') !== leaseId) { await rollback(env, tx); return; }
            await commit(env, tx, [wUpdate(env, path, { revokeLeaseUntil: 0 }, { mask: true, mustExist: true })]);
          }); } catch (e2) {}
        }
      }
    } catch (e) { st = 'failed'; }
    // done จากรอบนี้: อ่าน Firebase ยืนยันก่อนบอกว่าตรวจแล้ว · done-other (อีกคำขอทำเสร็จ) = ยังไม่ได้ตรวจในรอบนี้
    let ver2 = false;
    if (st === 'done' && lastCut) ver2 = await verifyCut(env, uids[role], lastCut, path, ver) === true;
    out[role] = { state: (st === 'done' || st === 'done-other') ? 'done' : 'pending', dueAt: dueAt, failed: st === 'failed', busy: st === 'busy', verified: ver2 };
    if (opts.alert && st !== 'done' && Date.now() > dueAt + HOUR) {
      await tgSend(env, '⚠️ แอปท่าทราย: ยังตัดบัตรเก่าของบทบาท ' + role + ' หลังเปลี่ยน PIN ไม่สำเร็จ (ค้างเกิน 1 ชม.) — เข้าแอปด้วย PIN admin แล้วกด "revoke ซ้ำ" ในแท็บตั้งค่า หรือแจ้งห้อง Code');
    }
  }
  return out;
}
// อ่าน validSince จริงจาก Firebase เทียบกับเวลาตัด · true / false / null (อ่านไม่ได้)
// path/ver: หลังอ่าน Firebase อ่านฐานซ้ำ — รุ่นหรือเวลาตัดล่าสุดเปลี่ยนไปแล้ว = null (ไม่ยืนยันด้วยข้อมูลเก่า)
// ผลเป็นการตรวจ ณ เวลานั้น — ถูกเขียนย้อนภายหลังได้ (ข้อจำกัด Firebase) → ตรวจและซ่อมทุกรอบ
async function verifyCut(env, uid, cut, path, ver) {
  try {
    const u = await lookupUser(env, uid); const vs = u ? Number(u.validSince) : NaN;
    if (!Number.isFinite(vs)) return null;
    if (path) {
      const d2 = await getDocSA(env, path);
      if (n(d2, 'ver') !== ver || n(d2, 'revokedAgainVer') !== ver || n(d2, 'revokedAgainCut') !== cut) return null;
    }
    return vs >= cut;
  } catch (e) { return null; }
}
// ประทับเวลาที่เห็น ver นี้ถูกบันทึกแล้ว (ครั้งแรกเท่านั้น · ผูก ver) · คืนเวลาที่ใช้ หรือ 0 ถ้า ver เปลี่ยน
export async function stampVerSeen(env, role, ver) {
  const path = 'tha_auth/' + role;
  return withTx(env, async function (tx) {
    const g = await txGet(env, tx, [path]);
    if (n(g[path], 'ver') !== ver) { await rollback(env, tx); return 0; }
    if (n(g[path], 'verSeenFor') === ver && n(g[path], 'verSeenAt')) { await rollback(env, tx); return n(g[path], 'verSeenAt'); }
    const now = Date.now();
    await commit(env, tx, [wUpdate(env, path, { verSeenFor: ver, verSeenAt: now }, { mask: true, mustExist: true })]);
    return now;
  });
}
// เรียกแบบไม่บล็อกคำตอบ (ใช้ waitUntil ถ้ามี)
export function bg(context, p) {
  const safe = Promise.resolve(p).catch(function () {});
  if (context && typeof context.waitUntil === 'function') { context.waitUntil(safe); return Promise.resolve(); }
  return safe;
}
export { json };
