// 태산 결제 승인 (Vercel Serverless Function)
//
// 1) 결제 금액을 서버에서 다시 계산해서 손님이 보낸 금액과 비교해요.
//    (상품 가격·쿠폰 할인·배송비를 DB에서 직접 읽기 때문에 금액 조작이 불가능해요)
// 2) 금액이 맞으면 토스페이먼츠에 결제 승인을 요청해요.
// 3) 승인되면 주문을 '결제 완료'로 바꾸고, 팔린 상품은 자동으로 SOLD 처리,
//    쿠폰 사용 횟수를 1 올려요. (SUPABASE_SERVICE_ROLE_KEY 환경변수가 있을 때)
//
// Vercel 환경변수
//   TOSS_SECRET_KEY            토스페이먼츠 시크릿 키 (필수)
//   SUPABASE_SERVICE_ROLE_KEY  Supabase service_role 키 (권장, 자동 SOLD 처리용)

const SUPABASE_URL = 'https://kksjkxlpmhiutpayjovt.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtrc2preGxwbWhpdXRwYXlqb3Z0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc2Mzk3MDUsImV4cCI6MjEwMzIxNTcwNX0.N9ZhMfyMzjHWAQsf-U5YZ5UrQyoGn8GccqAJE_Zyheo';

function sb(path, { method = 'GET', body, key } = {}) {
  const k = key || SUPABASE_ANON_KEY;
  return fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      apikey: k,
      Authorization: `Bearer ${k}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function readSetting(key, fallback) {
  const r = await sb(`/rest/v1/site_settings?key=eq.${encodeURIComponent(key)}&select=value`);
  if (!r.ok) return fallback;
  const rows = await r.json();
  return rows[0] && rows[0].value !== null && rows[0].value !== '' ? rows[0].value : fallback;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'POST 요청만 허용됩니다.' });
  }

  const { paymentKey, orderId, amount, itemIds, couponCode } = req.body || {};
  if (!paymentKey || !orderId || !amount) {
    return res.status(400).json({ message: 'paymentKey, orderId, amount가 모두 필요합니다.' });
  }

  const secretKey = process.env.TOSS_SECRET_KEY;
  if (!secretKey) {
    return res.status(500).json({ message: '서버에 TOSS_SECRET_KEY 환경변수가 설정되어 있지 않습니다.' });
  }
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  try {
    // ---------- 1. 금액 재계산 ----------
    let ids = Array.isArray(itemIds) ? [...new Set(itemIds.map(Number).filter(Boolean))] : [];
    let coupon = couponCode || null;
    // 브라우저에 저장된 정보가 없으면(다른 기기에서 결제 완료 등) 주문서에서 읽어요
    if (ids.length === 0 && serviceKey) {
      const or = await sb(`/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}&select=items,coupon_code`, {
        key: serviceKey,
      });
      const rows = or.ok ? await or.json() : [];
      if (rows[0]) {
        ids = [...new Set((rows[0].items || []).map((i) => Number(i.id)).filter(Boolean))];
        coupon = rows[0].coupon_code || null;
      }
    }
    if (ids.length === 0) {
      return res.status(400).json({ message: '주문 상품 정보가 없어요.' });
    }
    const pr = await sb(`/rest/v1/products?id=in.(${ids.join(',')})&select=id,name,price,sale_price,status`);
    const products = pr.ok ? await pr.json() : [];
    if (products.length !== ids.length) {
      return res.status(400).json({ message: '존재하지 않는 상품이 포함되어 있어요.' });
    }
    const soldOut = products.find((p) => p.status !== 'active');
    if (soldOut) {
      return res.status(409).json({ message: `이미 판매된 상품이 있어요: ${soldOut.name}` });
    }
    const subtotal = products.reduce(
      (s, p) => s + (p.sale_price !== null && p.sale_price !== undefined ? p.sale_price : p.price),
      0
    );

    let discount = 0;
    let appliedCoupon = null;
    if (coupon) {
      const cr = await sb('/rest/v1/rpc/coupon_discount', {
        method: 'POST',
        body: { p_code: coupon, p_subtotal: subtotal },
      });
      const c = cr.ok ? await cr.json() : { ok: false };
      if (!c.ok) {
        return res.status(400).json({ message: c.message || '쿠폰을 확인할 수 없어요.' });
      }
      discount = c.discount;
      appliedCoupon = c.code;
    }

    const fee = parseInt(await readSetting('shipping_fee', '3500'), 10) || 0;
    const freeOver = parseInt(await readSetting('free_ship_over', '0'), 10) || 0;
    const shipping = freeOver > 0 && subtotal >= freeOver ? 0 : fee;
    const expected = subtotal - discount + shipping;

    if (Number(amount) !== expected) {
      console.error('금액 불일치', { orderId, amount, expected });
      return res.status(400).json({ message: '결제 금액이 올바르지 않아요. 다시 주문해 주세요.' });
    }

    // ---------- 2. 토스 결제 승인 ----------
    const encodedKey = Buffer.from(secretKey + ':').toString('base64');
    const tr = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
      method: 'POST',
      headers: { Authorization: `Basic ${encodedKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentKey, orderId, amount: expected }),
    });
    const data = await tr.json();
    if (!tr.ok) {
      console.error('결제 승인 실패:', data);
      return res.status(tr.status).json(data);
    }

    // ---------- 3. 주문/재고/쿠폰 정리 ----------
    if (serviceKey) {
      await sb(`/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}`, {
        method: 'PATCH',
        key: serviceKey,
        body: { status: 'paid', payment_key: paymentKey, discount, coupon_code: appliedCoupon },
      });
      await sb(`/rest/v1/products?id=in.(${ids.join(',')})`, {
        method: 'PATCH',
        key: serviceKey,
        body: { status: 'sold' },
      });
      if (appliedCoupon) {
        const cur = await sb(`/rest/v1/coupons?code=eq.${encodeURIComponent(appliedCoupon)}&select=used_count`, {
          key: serviceKey,
        });
        const rows = cur.ok ? await cur.json() : [];
        if (rows[0]) {
          await sb(`/rest/v1/coupons?code=eq.${encodeURIComponent(appliedCoupon)}`, {
            method: 'PATCH',
            key: serviceKey,
            body: { used_count: rows[0].used_count + 1 },
          });
        }
      }
    }

    return res.status(200).json({ ...data, taesanAutoSold: !!serviceKey });
  } catch (err) {
    console.error('결제 승인 처리 중 오류:', err);
    return res.status(500).json({ message: '결제 승인 처리 중 오류가 발생했습니다.' });
  }
}
