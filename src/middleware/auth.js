import crypto from 'node:crypto';
import { getEnv } from '../config/env.js';
import { safeEqual } from '../utils/ids.js';

const deny = (res, status, code) => res.status(status).json({ error: code });

function hmacHex(secret, raw) {
  return crypto.createHmac('sha256', secret).update(raw).digest('hex');
}

/** Accepts "abcd", "sha256=abcd" (case-insensitive hex). */
function sigMatches(secret, raw, header) {
  if (!header || !raw) return false;
  const given = String(header).replace(/^sha256=/i, '').trim().toLowerCase();
  return safeEqual(hmacHex(secret, raw), given);
}

/**
 * Webhook authenticity for POST /webhooks/whatsapp.
 *  - Shared secret via `x-webhook-secret` header or `?secret=` query (MSG91 lets you configure the URL/headers).
 *  - If MSG91_WEBHOOK_HMAC_SECRET is set, `x-signature` / `x-hub-signature-256` (HMAC-SHA256 of the raw body) is ALSO required.
 *  Fails closed: with no secret configured, the endpoint is disabled outside development.
 */
export function webhookAuth(req, res, next) {
  const { msg91, isProd } = getEnv();
  if (!msg91.webhookSecret && !msg91.webhookHmacSecret) {
    if (isProd) return deny(res, 503, 'webhook_not_configured');
    req.log?.warn({ action: 'webhook_auth' }, 'no webhook secret configured: accepting (non-production only)');
    return next();
  }
  if (msg91.webhookSecret) {
    const given = req.headers['x-webhook-secret'] || req.query.secret;
    if (!safeEqual(msg91.webhookSecret, given)) return deny(res, 401, 'unauthorized');
  }
  if (msg91.webhookHmacSecret) {
    const sig = req.headers['x-signature'] || req.headers['x-hub-signature-256'];
    if (!sigMatches(msg91.webhookHmacSecret, req.rawBody, sig)) return deny(res, 401, 'bad_signature');
  }
  next();
}

/** Internal API key for admin/back-office endpoints. Fails closed when not configured (except in development). */
export function internalAuth(req, res, next) {
  const { internalApiKey, isProd } = getEnv();
  if (!internalApiKey) {
    if (isProd) return deny(res, 503, 'api_not_configured');
    return next();
  }
  const given = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!safeEqual(internalApiKey, given)) return deny(res, 401, 'unauthorized');
  next();
}

/** Payment provider events: HMAC-SHA256 of the raw body with PAYMENT_WEBHOOK_SECRET. Always required. */
export function paymentAuth(req, res, next) {
  const { paymentWebhookSecret } = getEnv();
  if (!paymentWebhookSecret) return deny(res, 503, 'payment_webhook_not_configured');
  const sig = req.headers['x-signature'] || req.headers['x-payment-signature'];
  if (!sigMatches(paymentWebhookSecret, req.rawBody, sig)) return deny(res, 401, 'bad_signature');
  next();
}

export { hmacHex };
