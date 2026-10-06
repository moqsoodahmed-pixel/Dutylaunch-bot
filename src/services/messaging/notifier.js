import { logger as defaultLogger } from '../../utils/logger.js';

/**
 * Internal team notification. Posts {text} to NOTIFY_WEBHOOK_URL (Slack-compatible) when configured.
 * Returns { delivered } so callers never claim the team was notified when it was not.
 */
export function createNotifier({ getEnv, fetchImpl = globalThis.fetch, logger = defaultLogger }) {
  return {
    async notify({ queue, owner, title, lines = [] }) {
      const url = getEnv().notifyWebhookUrl;
      if (!url) { logger.warn({ action: 'notify', queue }, 'NOTIFY_WEBHOOK_URL not set; internal notification not delivered'); return { delivered: false }; }
      const text = [`*${title}* (queue: ${queue}${owner ? `, owner: ${owner}` : ''})`, ...lines].join('\n');
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      try {
        const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }), signal: ctrl.signal });
        return { delivered: res.ok };
      } catch (err) {
        logger.error({ action: 'notify', queue, errorCategory: err?.name }, 'internal notification failed');
        return { delivered: false };
      } finally { clearTimeout(t); }
    }
  };
}
