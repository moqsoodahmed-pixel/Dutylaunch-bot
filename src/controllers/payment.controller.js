import { Order, Contact } from '../models/index.js';
import { getEnv } from '../config/env.js';
import { normalizePhone } from '../utils/phone.js';
import { KeyedQueue } from '../utils/keyedQueue.js';
import * as ordersSvc from '../services/orders/orders.service.js';
import * as events from '../services/events/webhookEvents.service.js';
import * as catalog from '../services/catalog/catalog.service.js';
import { validatePaymentEvent } from '../validators/index.js';
import { text } from '../services/conversation/prompts.js';

/**
 * POST /events/payment (HMAC-signed by the payment backend).
 * Idempotent per eventId; out-of-order events cannot downgrade an order; the payment confirmation
 * is sent at most once per order (atomic claim), and never claims success if the send failed.
 */
export function createPaymentController({ messenger, analytics, logger }) {
  const queue = new KeyedQueue();

  async function sendConfirmation(order) {
    const env = getEnv();
    const phone = normalizePhone(order.customerPhone, env.defaultCountryCode);
    if (!phone) return { sent: false, reason: 'no_phone' };
    const contact = await Contact.findOne({ normalizedWhatsappNumber: phone });
    if (!contact) return { sent: false, reason: 'unknown_contact' };

    const claimed = await Order.findOneAndUpdate(
      { orderId: order.orderId, confirmationSentAt: null, confirmationClaimedAt: null },
      { $set: { confirmationClaimedAt: new Date() } }, { new: true }
    );
    if (!claimed) return { sent: false, reason: 'already_sent_or_in_progress' };

    const service = order.serviceId ? await catalog.getService(order.serviceId) : null;
    const name = (contact.name || contact.profileName || 'there').split(/\s+/)[0];
    const spec = env.templates.paymentConfirmation
      ? { kind: 'template', name: env.templates.paymentConfirmation, variables: [name, service?.name || 'your DutyLaunch order', order.orderId], languageCode: env.templateLanguage }
      : text(`Hi ${name}, we've received your payment for ${service?.name || 'your DutyLaunch order'} (order ${order.orderId}). Thank you!`);
    const r = await messenger.send({ contact, spec, purpose: 'service' });
    if (r.ok) {
      await Order.updateOne({ orderId: order.orderId }, { $set: { confirmationSentAt: new Date() } });
      return { sent: true };
    }
    await Order.updateOne({ orderId: order.orderId }, { $set: { confirmationClaimedAt: null } });   // allow a later retry
    return { sent: false, reason: r.error?.reason || r.error?.category || 'send_failed' };
  }

  async function handle(req, res) {
    const input = validatePaymentEvent(req.body);
    let claim;
    try {
      claim = await events.claim({ provider: 'payment', providerEventId: input.eventId, eventType: `payment.${input.status}`, normalized: { orderId: input.orderId, status: input.status } });
    } catch (err) {
      req.log?.error({ action: 'payment_claim_failed', errorCategory: err?.name }, 'idempotency store unavailable');
      return res.status(503).json({ error: 'storage_unavailable' });
    }
    if (claim === 'duplicate') return res.status(200).json({ duplicate: true });

    const result = await queue.run(input.orderId, async () => {
      const phone = input.customerPhone ? normalizePhone(input.customerPhone, getEnv().defaultCountryCode) : undefined;
      const { order, changed } = await ordersSvc.applyPaymentEvent({ ...input, customerPhone: phone || undefined });
      let confirmation = { sent: false, reason: 'not_paid' };
      if (order.paymentStatus === 'paid') {
        if (changed) {
          const contact = order.customerPhone ? await Contact.findOne({ normalizedWhatsappNumber: order.customerPhone }).lean() : null;
          await analytics.track('payment_confirmed', { contactId: contact?.contactId, serviceId: order.serviceId, meta: { orderId: order.orderId } });
        }
        confirmation = await sendConfirmation(order);
      }
      return { order, changed, confirmation };
    }).catch(async (err) => {
      await events.markFailed('payment', input.eventId, err?.name).catch(() => {});
      throw err;
    });
    await events.markProcessed('payment', input.eventId);
    logger.info({ action: 'payment_event', orderId: input.orderId, status: input.status, changed: result.changed, confirmation: result.confirmation.reason || 'sent' }, 'payment event applied');
    res.status(200).json({ ok: true, paymentStatus: result.order.paymentStatus, changed: result.changed, confirmation: result.confirmation });
  }

  return { handle };
}
