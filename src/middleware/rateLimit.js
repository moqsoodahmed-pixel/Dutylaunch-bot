import rateLimit from 'express-rate-limit';

const base = { standardHeaders: true, legacyHeaders: false, message: { error: 'rate_limited' } };

/** Webhook traffic comes from MSG91 and can burst; generous but bounded. */
export const webhookLimiter = (max = 600) => rateLimit({ ...base, windowMs: 60_000, limit: max });
/** Internal/back-office API. */
export const apiLimiter = (max = 120) => rateLimit({ ...base, windowMs: 60_000, limit: max });
