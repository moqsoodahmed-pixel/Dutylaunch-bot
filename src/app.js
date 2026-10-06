import express from 'express';
import helmet from 'helmet';
import { logger as defaultLogger } from './utils/logger.js';
import { buildContainer } from './container.js';
import { requestId } from './middleware/requestId.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { createWebhookController } from './controllers/webhook.controller.js';
import { createPaymentController } from './controllers/payment.controller.js';
import { createApiController } from './controllers/api.controller.js';
import { buildRoutes } from './routes/index.js';

/** Builds the Express app. Returns { app, container, webhook } so server.js and tests share one wiring. */
export function createApp({ container = buildContainer(), logger = defaultLogger } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);           // behind a TLS-terminating reverse proxy / load balancer
  app.use(helmet());
  app.use(requestId(logger));
  app.use(express.json({
    limit: '256kb',
    verify: (req, _res, buf) => { req.rawBody = buf; }   // raw bytes are needed for HMAC verification
  }));

  const webhook = createWebhookController({ engine: container.engine, analytics: container.analytics, logger });
  const payment = createPaymentController({ messenger: container.messenger, analytics: container.analytics, logger });
  const api = createApiController(container);

  app.use(buildRoutes({ webhook, payment, api }));
  app.use(notFound);
  app.use(errorHandler);
  return { app, container, webhook };
}
