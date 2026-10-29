// 주문 알림 문자 (SOLAPI 솔라피) — api 폴더의 다른 파일에서 불러 써요. 밑줄(_)로 시작해서 주소로는 열리지 않아요.
//
// Vercel 환경변수
//   SOLAPI_API_KEY     솔라피 API Key
//   SOLAPI_API_SECRET  솔라피 API Secret
//   SMS_FROM           솔라피에 등록한 발신번호 (예: 01031477590)
//   SMS_TO             알림 받을 번호 (비우면 SMS_FROM 으로 보내요)
//   SUPABASE_SERVICE_ROLE_KEY  주문서 읽기·알림 기록용

import crypto from 'node:crypto';

const SUPABASE_URL = 'https://kksjkxlpmhiutpayjovt.supabase.co';
const won = (n) => Number(n || 0).toLocaleString('ko-KR') + '원';

export function orderSmsText(o) {
  const items = (o.items || []).map((i) => {
    const short = String(i.name || '').replace(/^泰山\s*/, '');
    const opt = [i.color, i.size].filter(Boolean).join(' ');
    return `- ${short}${opt ? ' ' + opt : ''} x${i.qty || 1}`;
  });
  const pay = o.payment_method === 'bank'
    ? `입금대기 / 입금자 ${o.depositor || o.name}`
    : (o.status === 'paid' ? '카드결제 완료' : o.status);
  return [
    `[泰山] 새 주문 ${o.order_id}`,
    ...items,
    `합계 ${won(o.grand_total)} (${pay})`,
    `${o.name} ${o.phone}`,
    `${o.address}`,
    o.memo ? `메모: ${o.memo}` : null,
  ].filter(Boolean).join('\n');
}

export async function sendSms(text) {
  const apiKey = process.env.SOLAPI_API_KEY;
  const secret = process.env.SOLAPI_API_SECRET;
  const from = (process.env.SMS_FROM || '').replace(/\D/g, '');
  const to = (process.env.SMS_TO || from).replace(/\D/g, '');
  if (!apiKey || !secret || !from || !to) return { ok: false, reason: 'SMS 환경변수가 없어요' };
  const date = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const salt = crypto.randomBytes(16).toString('hex');
  const signature = crypto.createHmac('sha256', secret).update(date + salt).digest('hex');
  const r = await fetch('https://api.solapi.com/messages/v4/send-many/detail', {
    method: 'POST',
    headers: {
      Authorization: `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messages: [{ to, from, text }] }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) console.error('문자 발송 실패', r.status, body);
  return { ok: r.ok, status: r.status };
}

// 주문번호로 주문서를 읽어 한 번만 알림을 보내요 (notified_at 으로 중복 방지)
export async function notifyOrder(orderId) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || !orderId) return { ok: false, reason: 'no key or order' };
  const h = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}&select=*`, { headers: h });
  const rows = r.ok ? await r.json() : [];
  const o = rows[0];
  if (!o) return { ok: false, reason: 'not found' };
  if (o.notified_at) return { ok: true, skipped: true };
  if (Date.now() - new Date(o.created_at).getTime() > 30 * 60 * 1000) return { ok: false, reason: 'too old' };
  if (!['awaiting_deposit', 'paid'].includes(o.status)) return { ok: false, reason: 'status' };
  // 먼저 기록해서 두 번 보내지 않게 해요
  const lock = await fetch(
    `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}&notified_at=is.null`,
    { method: 'PATCH', headers: { ...h, Prefer: 'return=representation' }, body: JSON.stringify({ notified_at: new Date().toISOString() }) }
  );
  const locked = lock.ok ? await lock.json() : [];
  if (!locked.length) return { ok: true, skipped: true };
  return sendSms(orderSmsText(o));
}
