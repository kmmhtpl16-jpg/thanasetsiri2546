export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const body = await request.json().catch(function(){ return {}; });
    const text = (body && body.text || '').toString().trim();
    if (!text) return json({ ok: false, error: 'no text' }, 400);
    const token = env.TELEGRAM_BOT_TOKEN;
    const chatId = env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return json({ ok: false, error: 'not configured' }, 500);
    const tgRes = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true })
    });
    const data = await tgRes.json().catch(function(){ return {}; });
    return json({ ok: !!data.ok, telegram: data }, tgRes.ok ? 200 : 502);
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e) }, 500);
  }
}
export async function onRequestGet() {
  return json({ ok: true, info: 'use POST' }, 200);
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
}
