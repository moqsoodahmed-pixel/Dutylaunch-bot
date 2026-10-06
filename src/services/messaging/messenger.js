import { MessageLog } from '../../models/index.js';
import { hashNumber } from '../../utils/phone.js';
import { logger as defaultLogger } from '../../utils/logger.js';
import { canSend } from './policy.js';

/**
 * Sends a prompt spec through MSG91 after the policy gate, and records an audit row (no message body).
 * Never throws for provider problems: returns { ok:false, error } so callers never claim success.
 */
export function createMessenger({ whatsapp, analytics, logger = defaultLogger }) {
  async function send({ contact, conversationId = null, spec, purpose = 'service' }) {
    const to = contact.normalizedWhatsappNumber;
    const gate = canSend({ contact, kind: spec.kind === 'template' ? 'template' : 'freeform', purpose });
    const base = { direction: 'out', contactId: contact.contactId, conversationId, whatsappNumberHash: hashNumber(to), kind: spec.kind, templateName: spec.name };
    if (!gate.allowed) {
      await MessageLog.create({ ...base, status: 'suppressed', suppressedReason: gate.reason });
      logger.warn({ action: 'send_blocked', reason: gate.reason, conversationId }, 'outbound blocked by policy');
      return { ok: false, error: { category: 'policy', reason: gate.reason, retryable: false } };
    }
    try {
      let r;
      switch (spec.kind) {
        case 'text': r = await whatsapp.sendText(to, spec.body); break;
        case 'buttons': r = await whatsapp.sendInteractiveButtons(to, spec); break;
        case 'list': r = await whatsapp.sendInteractiveList(to, spec); break;
        case 'flow': r = await whatsapp.sendFlow(to, spec); break;
        case 'template': r = await whatsapp.sendTemplate(to, spec); break;
        default: throw new Error(`unknown prompt kind ${spec.kind}`);
      }
      const row = { ...base, status: 'submitted' };
      if (r.providerMessageId) row.providerMessageId = r.providerMessageId;
      await MessageLog.create(row).catch((e) => logger.error({ action: 'message_log', errorCategory: e?.name }, 'message log write failed'));
      return { ok: true, providerMessageId: r.providerMessageId };
    } catch (err) {
      const category = err?.category || 'unknown';
      logger.error({ action: 'send_failed', kind: spec.kind, errorCategory: category, providerStatus: err?.status, conversationId }, 'outbound send failed');
      await MessageLog.create({ ...base, status: 'failed', errorCategory: category, errorCode: err?.providerCode ? String(err.providerCode).slice(0, 100) : undefined }).catch(() => {});
      await analytics.track(spec.kind === 'template' ? 'template_error' : 'delivery_failed', { contactId: contact.contactId, conversationId, meta: { category } });
      return { ok: false, error: { category, retryable: Boolean(err?.retryable) || category === 'provider_unavailable' || category === 'timeout' || category === 'rate_limit' } };
    }
  }
  return { send };
}
