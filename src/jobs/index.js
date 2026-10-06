import { logger as defaultLogger } from '../utils/logger.js';
import { runFollowUps } from './followUp.js';

/**
 * Background sweepers. Every tick is wrapped so one failure never stops the loop. Timers are unref'd.
 *  - webhook retries (events that failed after the ACK)
 *  - resend prompts that could not be delivered (provider outage)
 *  - expire stale conversations / handoff timeouts
 */
export function startJobs({ engine, webhook, messenger, analytics, logger = defaultLogger, intervals = {} }) {
  const cfg = { retry: 15_000, resend: 30_000, expire: 60_000, followUp: 300_000, ...intervals };
  const timers = [];
  const every = (name, ms, fn) => {
    let running = false;
    const t = setInterval(async () => {
      if (running) return;
      running = true;
      try { const out = await fn(); if (out) logger.info({ action: `job_${name}`, out }, 'job tick'); }
      catch (err) { logger.error({ action: `job_${name}`, errorCategory: err?.name }, 'job failed'); }
      finally { running = false; }
    }, ms);
    t.unref?.();
    timers.push(t);
  };
  every('webhook_retry', cfg.retry, async () => { const n = await webhook.retryStalled(); return n || null; });
  every('resend_pending', cfg.resend, async () => { const n = await engine.resendPending(); return n || null; });
  every('expire_stale', cfg.expire, async () => { const o = await engine.expireStale(); return o.expired || o.handoffTimeouts ? o : null; });
  if (messenger && analytics) {
    every('follow_up', cfg.followUp, async () => { const o = await runFollowUps({ messenger, analytics }); return o.sent || o.skipped ? o : null; });
  }
  return { stop: () => timers.forEach(clearInterval) };
}
