import express from 'express';
import { webhookAuth, internalAuth, paymentAuth } from '../middleware/auth.js';
import { webhookLimiter, apiLimiter } from '../middleware/rateLimit.js';
import { wrap } from '../middleware/errorHandler.js';

export function buildRoutes({ webhook, payment, api }) {
  const r = express.Router();

  r.get('/health', wrap(api.health));

  // --- provider-facing ---
  r.get('/webhooks/whatsapp', webhookAuth, webhook.verify);
  r.post('/webhooks/whatsapp', webhookLimiter(), webhookAuth, wrap(webhook.handle));
  // Same webhook with the secret in the path (MSG91's form does not allow "?" in URLs)
  r.get('/webhooks/whatsapp/:secret', webhookAuth, webhook.verify);
  r.post('/webhooks/whatsapp/:secret', webhookLimiter(), webhookAuth, wrap(webhook.handle));
  r.post('/events/payment', apiLimiter(300), paymentAuth, wrap(payment.handle));

  // --- internal / back-office (API key + rate limit applied per route, so unknown paths are a plain 404) ---
  const guard = [apiLimiter(), internalAuth];
  r.post('/contacts/upsert', ...guard, wrap(api.upsertContact));
  r.post('/leads', ...guard, wrap(api.createLead));
  r.get('/orders/:orderId', ...guard, wrap(api.getOrder));
  r.post('/support/tickets', ...guard, wrap(api.createTicket));
  r.post('/messages/send', ...guard, wrap(api.sendMessage));
  r.get('/services', ...guard, wrap(api.listServices));
  r.put('/services/:id', ...guard, wrap(api.updateService));
  r.get('/analytics/summary', ...guard, wrap(api.analyticsSummary));
  r.post('/handoff/:ticketId/release', ...guard, wrap(api.releaseHandoff));
  return r;
}