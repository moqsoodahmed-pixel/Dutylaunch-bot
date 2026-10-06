import { getEnv } from './config/env.js';
import { logger as defaultLogger } from './utils/logger.js';
import { Msg91Client } from './services/msg91/msg91.client.js';
import { createWhatsApp } from './services/msg91/msg91.whatsapp.js';
import { createMessenger } from './services/messaging/messenger.js';
import { createNotifier } from './services/messaging/notifier.js';
import { createAnalytics } from './services/analytics/analytics.service.js';
import { createSupportService } from './services/support/support.service.js';
import { createEngine } from './services/conversation/engine.js';

/**
 * Composition root. Everything that touches the network is injectable (fetchImpl / whatsapp) so the
 * full stack can be exercised in tests without calling MSG91.
 */
export function buildContainer({ fetchImpl, whatsapp, logger = defaultLogger, sleep } = {}) {
  const env = getEnv();
  const client = new Msg91Client({
    authKey: env.msg91.authKey, integratedNumber: env.msg91.integratedNumber, baseUrl: env.msg91.baseUrl,
    timeoutMs: env.msg91.timeoutMs, maxRetries: env.msg91.maxRetries, logger,
    ...(fetchImpl ? { fetchImpl } : {}), ...(sleep ? { sleep } : {})
  });
  const wa = whatsapp || createWhatsApp(client, { defaultLanguage: env.templateLanguage, namespace: env.msg91.templateNamespace });
  const analytics = createAnalytics({ logger });
  const notifier = createNotifier({ getEnv, logger, ...(fetchImpl ? { fetchImpl } : {}) });
  const messenger = createMessenger({ whatsapp: wa, analytics, logger });
  const support = createSupportService({ notifier, analytics });
  const engine = createEngine({ messenger, support, analytics, notifier, logger });
  return { env, client, whatsapp: wa, analytics, notifier, messenger, support, engine, logger };
}
