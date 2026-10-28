// 태산 결제 승인 (Vercel Serverless Function)
//
// 1) 주문서(옵션·수량)를 DB에서 읽고, 상품 가격·쿠폰·배송비로 결제 금액을 서버에서 다시 계산해요.
// 2) 한정 수량을 먼저 잡아요(예약판매 넘버링 번호도 이때 정해져요). 수량이 모자라면 결제하지 않아요.
// 3) 토스페이먼츠에 결제 승인을 요청하고, 실패하면 잡아둔 수량을 되돌려요.
// 4) 승인되면 주문을 '결제 완료'로 바꾸고 넘버링 번호를 주문서에 적어요. 쿠폰 사용 횟수도 1 올려요.
//
// Vercel 환경변수
//   TOSS_SECRET_KEY            토스페이먼츠 시크릿 키 (필수)
//   SUPABASE_SERVICE_ROLE_KEY  Supabase service_role 키 (필수 — 한정 수량·넘버링·주문 상태 처리용)

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

const priceOf = (p) => (p.sale_price !== null && p.sale_price !== undefined ? p.sale_price : p.price);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'POST 요청만 허용됩니다.' });
  }

  const { paymentKey, orderId, amount } = req.body || {};
  if (!paymentKey || !orderId || !amount) {
    return res.status(400).json({ message: 'paymentKey, orderId, amount가 모두 필요합니다.' });
  }

  const secretKey = process.env.TOSS_SECRET_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!secretKey) {
    return res.status(500).json({ message: '서버에 TOSS_SECRET_KEY 환경변수가 설정되어 있지 않습니다.' });
  }
  if (!serviceKey) {
    return res.status(500).json({ message: '서버에 SUPABASE_SERVICE_ROLE_KEY 환경변수가 설정되어 있지 않습니다.' });
  }

  const reserved = []; // 되돌릴 때 쓰는 [{ id, qty }]
  const releaseAll = async () => {
    for (const r of reserved) {
      await sb('/rest/v1/rpc/release_stock', { method: 'POST', key: serviceKey, body: { p_id: r.id, p_qty: r.qty } });
    }
    reserved.length = 0;
  };

  try {
    // ---------- 1. 주문서 읽기 ----------
    const or = await sb(
      `/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}&select=items,coupon_code,status`,
      { key: serviceKey }
    );
    const orderRows = or.ok ? await or.json() : [];
    const order = orderRows[0];
    if (!order) return res.status(404).json({ message: '주문서를 찾을 수 없어요. 다시 주문해 주세요.' });
    if (order.status !== 'pending_payment') {
      return res.status(409).json({ message: '이미 처리된 주문이에요.' });
    }

    // 같은 상품·옵션 줄은 합치고, 수량은 1~99로 제한
    const lines = [];
    for (const raw of order.items || []) {
      const id = Number(raw.id);
      const qty = Math.floor(Number(raw.qty || 1));
      if (!id || !(qty >= 1 && qty <= 99)) {
        return res.status(400).json({ message: '주문 수량이 올바르지 않아요.' });
      }
      lines.push({ ...raw, id, qty, color: raw.color || null, size: raw.size || null });
    }
    if (lines.length === 0) return res.status(400).json({ message: '주문 상품 정보가 없어요.' });

    const ids = [...new Set(lines.map((l) => l.id))];
    const pr = await sb(
      `/rest/v1/products?id=in.(${ids.join(',')})&select=*`,
      { key: serviceKey }
    );
    const products = pr.ok ? await pr.json() : [];
    const byId = Object.fromEntries(products.map((p) => [p.id, p]));
    const now = Date.now();

    // ---------- 2. 상품·옵션·기간·수량 확인, 금액 재계산 ----------
    const qtyById = {};
    let subtotal = 0;
    for (const l of lines) {
      const p = byId[l.id];
      if (!p) return res.status(400).json({ message: '존재하지 않는 상품이 포함되어 있어요.' });
      if (p.status !== 'active') return res.status(409).json({ message: `판매가 끝난 상품이에요: ${p.name}` });
      if (p.opens_at && new Date(p.opens_at).getTime() > now) {
        return res.status(409).json({ message: `아직 판매 전이에요: ${p.name}` });
      }
      if (p.closes_at && new Date(p.closes_at).getTime() <= now) {
        return res.status(409).json({ message: `예약 기간이 끝났어요: ${p.name}` });
      }
      const colors = p.colors || [];
      const sizes = p.sizes || [];
      if (colors.length && !colors.includes(l.color)) return res.status(400).json({ message: `색상을 다시 골라주세요: ${p.name}` });
      if (sizes.length && !sizes.includes(l.size)) return res.status(400).json({ message: `사이즈를 다시 골라주세요: ${p.name}` });
      qtyById[l.id] = (qtyById[l.id] || 0) + l.qty;
      const maxPer = p.kind === 'vintage' ? 1 : p.max_per_order || 99;
      if (qtyById[l.id] > maxPer) {
        return res.status(400).json({ message: `${p.name}은(는) 한 번에 ${maxPer}개까지 주문할 수 있어요.` });
      }
      subtotal += priceOf(p) * l.qty;
    }

    let discount = 0;
    let appliedCoupon = null;
    if (order.coupon_code) {
      const cr = await sb('/rest/v1/rpc/coupon_discount', {
        method: 'POST',
        body: { p_code: order.coupon_code, p_subtotal: subtotal },
      });
      const c = cr.ok ? await cr.json() : { ok: false };
      if (!c.ok) return res.status(400).json({ message: c.message || '쿠폰을 확인할 수 없어요.' });
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

    // ---------- 3. 한정 수량 잡기 + 넘버링 ----------
    for (const l of lines) {
      const r = await sb('/rest/v1/rpc/reserve_stock', {
        method: 'POST',
        key: serviceKey,
        body: { p_id: l.id, p_qty: l.qty },
      });
      const total = r.ok ? await r.json() : null;
      if (total === null || total === undefined) {
        await releaseAll();
        return res.status(409).json({ message: `남은 수량이 부족해요: ${byId[l.id].name}` });
      }
      reserved.push({ id: l.id, qty: l.qty });
      const p = byId[l.id];
      l.price = priceOf(p);
      if (p.numbered) {
        l.numbers = Array.from({ length: l.qty }, (_, i) => total - l.qty + 1 + i);
      }
    }

    // ---------- 4. 토스 결제 승인 ----------
    const encodedKey = Buffer.from(secretKey + ':').toString('base64');
    const tr = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
      method: 'POST',
      headers: { Authorization: `Basic ${encodedKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentKey, orderId, amount: expected }),
    });
    const data = await tr.json();
    if (!tr.ok) {
      console.error('결제 승인 실패:', data);
      await releaseAll();
      return res.status(tr.status).json(data);
    }
    reserved.length = 0; // 결제가 승인됐으니 이후 오류가 나도 잡은 수량은 되돌리지 않아요

    // ---------- 5. 주문 정리 ----------
    await sb(`/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}`, {
      method: 'PATCH',
      key: serviceKey,
      body: {
        status: 'paid',
        payment_key: paymentKey,
        items: lines,
        item_total: subtotal,
        shipping,
        discount,
        grand_total: expected,
        coupon_code: appliedCoupon,
      },
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

    const numbers = lines
      .filter((l) => l.numbers)
      .map((l) => ({ name: l.name, color: l.color, size: l.size, numbers: l.numbers }));
    return res.status(200).json({ ...data, taesanNumbers: numbers });
  } catch (err) {
    console.error('결제 승인 처리 중 오류:', err);
    try { await releaseAll(); } catch (e) {}
    return res.status(500).json({ message: '결제 승인 처리 중 오류가 발생했습니다.' });
  }
}
