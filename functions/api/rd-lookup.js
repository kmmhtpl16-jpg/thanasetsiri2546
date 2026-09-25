/* ค้นข้อมูลผู้ประกอบการจดทะเบียน VAT จากกรมสรรพากร (VAT Service · SOAP)
   GET /api/rd-lookup?tin=0413541001000   หรือ   ?name=บุรินทร์
   คืน { ok, rows:[{tin,branch,branchName,name,address,province,postcode,since}], error? }
   Why ทำเป็นตัวกลาง: เบราว์เซอร์เรียกเว็บกรมสรรพากรตรง ๆ ไม่ได้ (CORS) — ฟังก์ชันนี้รันฝั่งเซิร์ฟเวอร์ของ Cloudflare
   ไม่เก็บข้อมูลอะไรไว้ · ใช้บัญชีกลาง anonymous ตามที่กรมสรรพากรกำหนด */
const RD_URL = 'https://rdws.rd.go.th/serviceRD3/vatserviceRD3.asmx';
const NS = 'https://rdws.rd.go.th/serviceRD3/vatserviceRD3';

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const tin = (url.searchParams.get('tin') || '').replace(/\D/g, '');
  const name = (url.searchParams.get('name') || '').trim().slice(0, 100);
  if (!tin && name.length < 2) return json({ ok: false, error: 'ใส่เลข 13 หลัก หรือชื่ออย่างน้อย 2 ตัวอักษร' }, 400);
  if (tin && tin.length !== 13) return json({ ok: false, error: 'เลขผู้เสียภาษีต้องมี 13 หลัก' }, 400);
  const body = '<?xml version="1.0" encoding="utf-8"?>'
    + '<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
    + '<soap:Body><Service xmlns="' + NS + '">'
    + '<username>anonymous</username><password>anonymous</password>'
    + '<TIN>' + esc(tin) + '</TIN><Name>' + esc(tin ? '' : name) + '</Name>'
    + '<ProvinceCode>0</ProvinceCode><BranchNumber>0</BranchNumber><AmphurCode>0</AmphurCode>'
    + '</Service></soap:Body></soap:Envelope>';
  try {
    const res = await fetch(RD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': '"' + NS + '/Service"' },
      body: body,
      redirect: 'manual'
    });
    const text = await res.text();
    if (!res.ok) return json({ ok: false, error: 'กรมสรรพากรตอบกลับ ' + res.status, status: res.status }, 502);
    const f = (tag) => pick(text, tag);
    const err = f('vmsgerr').filter(Boolean).join(' ');
    const tins = f('vNID');
    const rows = tins.map(function (t, i) {
      const g = (tag) => (f(tag)[i] || '').trim();
      const nm = [g('vtitleName'), g('vName'), g('vSurname')].filter(function (x) { return x && x !== '-'; }).join(' ');
      const addrParts = [
        g('vBuildingName') && ('อาคาร' + g('vBuildingName')),
        g('vRoomNumber') && g('vRoomNumber') !== '-' && ('ห้อง ' + g('vRoomNumber')),
        g('vFloorNumber') && g('vFloorNumber') !== '-' && ('ชั้น ' + g('vFloorNumber')),
        g('vVillageName') && g('vVillageName') !== '-' && ('หมู่บ้าน' + g('vVillageName')),
        g('vHouseNumber') && g('vHouseNumber') !== '-' && ('เลขที่ ' + g('vHouseNumber')),
        g('vMooNumber') && g('vMooNumber') !== '-' && g('vMooNumber') !== '0' && ('หมู่ ' + g('vMooNumber')),
        g('vSoiName') && g('vSoiName') !== '-' && ('ซ.' + g('vSoiName')),
        g('vStreetName') && g('vStreetName') !== '-' && ('ถ.' + g('vStreetName')),
        g('vThambol') && ('ต.' + g('vThambol')),
        g('vAmphur') && ('อ.' + g('vAmphur')),
        g('vProvince') && ('จ.' + g('vProvince')),
        g('vPostCode')
      ].filter(Boolean);
      const bn = g('vBranchNumber');
      return {
        tin: t.trim(), branch: bn, branchName: (+bn === 0 || bn === '') ? 'สำนักงานใหญ่' : ('สาขาที่ ' + String(bn).padStart(5, '0') + (g('vBranchName') && g('vBranchName') !== '-' ? ' ' + g('vBranchName') : '')),
        name: nm, address: addrParts.join(' '), province: g('vProvince'), postcode: g('vPostCode'), since: g('vBusinessFirstDate')
      };
    });
    return json({ ok: true, rows: rows.slice(0, 50), error: rows.length ? '' : (err || 'ไม่พบข้อมูล') });
  } catch (e) {
    return json({ ok: false, error: 'ติดต่อกรมสรรพากรไม่ได้: ' + String((e && e.message) || e) }, 502);
  }
}
function pick(xml, tag) {
  const m = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>').exec(xml);
  if (!m) return [];
  const out = []; const re = /<anyType[^>]*>([\s\S]*?)<\/anyType>|<anyType[^>]*\/>/g; let a;
  while ((a = re.exec(m[1]))) out.push(unesc(a[1] || ''));
  return out;
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function unesc(s) { return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'); }
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
