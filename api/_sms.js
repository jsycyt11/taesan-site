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

const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtrc2preGxwbWhpdXRwYXlqb3Z0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc2Mzk3MDUsImV4cCI6MjEwMzIxNTcwNX0.N9ZhMfyMzjHWAQsf-U5YZ5UrQyoGn8GccqAJE_Zyheo';

// 알림용 짧은 요약 (이름·연락처·주소는 넣지 않아요 — 자세한 건 관리자 화면에서)
export function alertText(b) {
  const items = (b.items || []).map((i) => {
    const short = String(i.name || '').replace(/^泰山\s*/, '');
    return `${short} · ${[i.color, i.size].filter(Boolean).join(' ')} x${i.qty || 1}`;
  });
  const pay = b.payment_method === 'bank' ? `입금 대기 · 입금자 ${b.depositor}` : '카드 결제 완료';
  return [...items, `합계 ${won(b.grand_total)} (${pay})`, `주문번호 ${b.order_id}`].join('\n');
}

// 휴대폰 푸시 (ntfy 앱) — 가입·키 필요 없음
export async function sendPush(topic, title, text) {
  if (!topic) return { ok: false };
  const r = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers: {
      Title: encodeURIComponent(title).length === title.length ? title : '=?UTF-8?B?' + Buffer.from(title).toString('base64') + '?=',
      Priority: 'high',
      Tags: 'package',
      Click: 'https://www.teasan1.com/',
    },
    body: text,
  });
  if (!r.ok) console.error('푸시 실패', r.status, await r.text().catch(() => ''));
  return { ok: r.ok };
}

// 주문번호로 한 번만 알림을 보내요 (DB 함수가 중복을 막아요)
export async function notifyOrder(orderId) {
  if (!orderId) return { ok: false };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/claim_order_alert`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_order_id: orderId }),
  });
  const b = r.ok ? await r.json() : null;
  if (!b) return { ok: true, skipped: true };
  const text = alertText(b);
  const push = await sendPush(process.env.NTFY_TOPIC || b.topic, '泰山 새 주문', text);
  if (process.env.SOLAPI_API_KEY) await sendSms(`[泰山] 새 주문\n${text}`).catch(() => {});
  return push;
}
