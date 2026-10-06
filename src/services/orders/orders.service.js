import { Order } from '../../models/index.js';
import { cleanText } from '../../utils/sanitize.js';

const RANK = { unknown: 0, pending: 1, failed: 1, paid: 2, refunded: 3 };
export const PAYMENT_STATUSES = ['paid', 'failed', 'pending', 'refunded'];

/**
 * Server-side order lookup. Status is revealed only when the order belongs to the requesting WhatsApp number.
 * A user's claim or screenshot is never treated as proof of payment.
 * Replace the body with a call to your real order backend / payment provider if orders live elsewhere.
 */
export async function lookupForUser({ orderId, number }) {
  try {
    const o = await Order.findOne({ orderId: cleanText(orderId, 64) }).lean();
    if (!o) return { available: true, found: false };
    if (o.customerPhone !== number) return { available: true, found: true, verified: false };
    return { available: true, found: true, verified: true, order: pick(o) };
  } catch {
    return { available: false };
  }
}

export async function getOrderPublic(orderId, number) {
  const o = await Order.findOne({ orderId: cleanText(orderId, 64) }).lean();
  if (!o) return null;
  if (number && o.customerPhone !== number) return null;
  return pick(o);
}

const pick = (o) => ({ orderId: o.orderId, status: o.status, paymentStatus: o.paymentStatus, refundStatus: o.refundStatus, amount: o.amount, currency: o.currency, serviceId: o.serviceId });

/** Applies a verified payment event. Out-of-order events cannot downgrade state (e.g. pending after paid). */
export async function applyPaymentEvent({ eventId, orderId, status, amount, currency, customerPhone, customerEmail, providerRef, serviceId }) {
  let order = await Order.findOne({ orderId });
  if (!order) {
    try { order = await Order.create({ orderId, customerPhone, customerEmail, serviceId, amount, currency }); }
    catch (e) { if (e?.code !== 11000) throw e; order = await Order.findOne({ orderId }); }
  }
  if (order.lastPaymentEventId === eventId) return { order: order.toObject(), changed: false };
  const set = { lastPaymentEventId: eventId };
  if (customerPhone && !order.customerPhone) set.customerPhone = customerPhone;
  if (customerEmail && !order.customerEmail) set.customerEmail = customerEmail;
  if (amount !== undefined) set.amount = amount;
  if (currency) set.currency = currency;
  if (providerRef) set.paymentProviderRef = providerRef;
  let changed = false;
  if ((RANK[status] ?? 0) >= (RANK[order.paymentStatus] ?? 0)) {
    changed = order.paymentStatus !== status;
    set.paymentStatus = status;
    if (status === 'paid') set.status = 'paid';
    if (status === 'refunded') set.refundStatus = 'refunded';
  }
  await Order.updateOne({ _id: order._id }, { $set: set });
  return { order: await Order.findById(order._id).lean(), changed };
}
