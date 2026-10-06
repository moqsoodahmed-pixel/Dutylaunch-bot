import { MessageLog } from '../models/index.js';
import { normalizeInbound } from '../services/msg91/msg91.inbound.js';
import * as events from '../services/events/webhookEvents.service.js';

const PROVIDER = 'msg91';
const STATUS_RANK = { submitted: 0, sent: 1, delivered: 2, read: 3 };
const LOWER_THAN = (s) => Object.keys(STATUS_RANK).filter((k) => STATUS_RANK[k] < (STATUS_RANK[s] ?? 0));

/**
 * POST /webhooks/whatsapp
 *  1. normalise (400 for unusable payloads)
 *  2. claim every event in the idempotency collection (duplicates are skipped; DB down => 503 so MSG91 retries)
 *  3. ACK immediately, then process in the background (per-number ordering is guaranteed by the engine lock)
 */
export function createWebhookController({ engine, analytics, logger }) {
  const inflight = new Set();
  const track = (p) => { inflight.add(p); p.finally(() => inflight.delete(p)); return p; };

  async function handleStatus(ev) {
    const row = await MessageLog.findOne({ providerMessageId: ev.messageId }).lean();
    if (!row) return;
    if (ev.status === 'failed') {
      await MessageLog.updateOne({ providerMessageId: ev.messageId }, { $set: { status: 'failed', errorCode: ev.errorCode || undefined, errorCategory: 'delivery' } });
      await analytics.track(row.kind === 'template' ? 'template_error' : 'delivery_failed', { contactId: row.contactId, conversationId: row.conversationId, meta: { code: ev.errorCode, via: 'status_webhook' } });
    } else if (ev.status in STATUS_RANK) {
      await MessageLog.updateOne({ providerMessageId: ev.messageId, status: { $in: LOWER_THAN(ev.status) } }, { $set: { status: ev.status } });
    }
  }

  async function processEvent(ev) {
    try {
      if (ev.kind === 'message') await engine.handleInbound(ev);
      else if (ev.kind === 'status') await handleStatus(ev);
      await events.markProcessed(PROVIDER, ev.eventId);
      return true;
    } catch (err) {
      logger.error({ action: 'webhook_process_failed', eventId: ev.eventId, errorCategory: err?.name }, 'event processing failed; will retry');
      await events.markFailed(PROVIDER, ev.eventId, err?.name || 'error').catch(() => {});
      return false;
    }
  }

  async function handle(req, res) {
    let parsed;
    try { parsed = normalizeInbound(req.body); }
    catch { return res.status(400).json({ error: 'invalid_payload' }); }

    const accepted = [];
    try {
      for (const ev of parsed) {
        const r = await events.claim({ provider: PROVIDER, providerEventId: ev.eventId, eventType: ev.kind, normalized: ev });
        if (r === 'new') accepted.push(ev);
      }
    } catch (err) {
      req.log?.error({ action: 'webhook_claim_failed', errorCategory: err?.name }, 'idempotency store unavailable');
      return res.status(503).json({ error: 'storage_unavailable' });
    }
    res.status(200).json({ received: parsed.length, accepted: accepted.length, duplicates: parsed.length - accepted.length });
    if (accepted.length) {
      track((async () => { for (const ev of accepted) await processEvent(ev); })());
    }
  }

  /** Re-processes stalled/failed events (called by the retry job). */
  async function retryStalled(max = 20) {
    let n = 0;
    for (let i = 0; i < max; i += 1) {
      const doc = await events.claimRetryable();
      if (!doc) break;
      await processEvent({ ...doc.normalized, timestamp: doc.normalized?.timestamp ? new Date(doc.normalized.timestamp) : new Date() });
      n += 1;
    }
    return n;
  }

  /** Resolves when all background processing has finished (graceful shutdown and tests). */
  const drain = async () => { while (inflight.size) await Promise.allSettled([...inflight]); };

  /** Meta-style GET verification ping (hub.challenge) plus a plain liveness response. */
  function verify(req, res) {
    const challenge = req.query['hub.challenge'];
    if (challenge !== undefined) return res.status(200).send(String(challenge));
    res.status(200).json({ ok: true });
  }

  return { handle, verify, retryStalled, drain };
}
