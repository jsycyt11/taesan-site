// 새 주문 알림 (계좌이체 주문 접수 직후 사이트에서 불러요)
import { notifyOrder } from './_sms.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ message: 'POST only' });
  const { orderId } = req.body || {};
  if (!orderId || !/^TS\d{6,20}$/.test(String(orderId))) return res.status(400).json({ message: 'bad order id' });
  try {
    const r = await notifyOrder(String(orderId));
    return res.status(200).json({ ok: !!r.ok });
  } catch (e) {
    console.error('주문 알림 오류', e);
    return res.status(200).json({ ok: false });
  }
}
