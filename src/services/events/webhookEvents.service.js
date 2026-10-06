import { WebhookEvent } from '../../models/index.js';
import { sha256 } from '../../utils/phone.js';

const LOCK_MS = 60 * 1000;
export const MAX_ATTEMPTS = 5;

/**
 * Idempotency gate. Returns 'new' (caller should process), 'duplicate' (already processed)
 * or 'in_progress' (another worker holds it / a retry is pending). The unique index makes this race-safe.
 */
export async function claim({ provider, providerEventId, eventType, payload, normalized }) {
  try {
    await WebhookEvent.create({
      provider, providerEventId, eventType, payloadHash: sha256(payload ?? normalized ?? ''),
      normalized, lockedUntil: new Date(Date.now() + LOCK_MS)
    });
    return 'new';
  } catch (e) {
    if (e?.code !== 11000) throw e;
    const existing = await WebhookEvent.findOne({ provider, providerEventId }).lean();
    return existing?.processed ? 'duplicate' : 'in_progress';
  }
}

export const markProcessed = (provider, providerEventId) =>
  WebhookEvent.updateOne({ provider, providerEventId }, { $set: { processed: true, processedAt: new Date(), error: null }, $unset: { normalized: 1 } });

export const markFailed = (provider, providerEventId, category) =>
  WebhookEvent.updateOne({ provider, providerEventId }, { $set: { error: String(category).slice(0, 100), lockedUntil: new Date(Date.now() + 30 * 1000) } });

/** Atomically claims one stalled/failed event for retry. */
export async function claimRetryable() {
  const now = new Date();
  return WebhookEvent.findOneAndUpdate(
    { processed: false, attempts: { $lt: MAX_ATTEMPTS }, lockedUntil: { $lt: now }, normalized: { $ne: null } },
    { $set: { lockedUntil: new Date(now.getTime() + LOCK_MS) }, $inc: { attempts: 1 } },
    { new: true }
  ).lean();
}
