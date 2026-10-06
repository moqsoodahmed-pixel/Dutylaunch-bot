import { logger as defaultLogger } from '../../utils/logger.js';

export class Msg91Error extends Error {
  constructor(message, { category, status = null, retryable = false, providerCode = null } = {}) {
    super(message);
    this.name = 'Msg91Error';
    this.category = category;          // auth | rate_limit | invalid_request | provider_unavailable | timeout | invalid_response | config
    this.status = status;
    this.retryable = retryable;
    this.providerCode = providerCode;
  }
}

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Thin HTTP client for MSG91. Handles timeouts, 429/5xx retries with backoff, and MSG91's habit of
 * returning HTTP 200 with {status:"fail"/hasError:true}. Never logs the auth key or message bodies.
 */
export class Msg91Client {
  constructor({ authKey, integratedNumber, baseUrl = 'https://control.msg91.com', timeoutMs = 10000, maxRetries = 2, fetchImpl = globalThis.fetch, sleep = sleepDefault, logger = defaultLogger } = {}) {
    this.authKey = authKey;
    this.integratedNumber = integratedNumber;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.logger = logger;
  }

  assertConfigured() {
    if (!this.authKey || !this.integratedNumber) {
      throw new Msg91Error('MSG91 credentials are not configured', { category: 'config' });
    }
  }

  async request({ method = 'POST', path, query, body, action = 'msg91_request' }) {
    this.assertConfigured();
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));

    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const data = await this.#once(method, url, body);
        this.logger.debug({ action, attempt, providerStatus: 'ok' }, 'msg91 ok');
        return data;
      } catch (err) {
        lastErr = err;
        const retryable = err instanceof Msg91Error && err.retryable;
        this.logger.warn({ action, attempt, errorCategory: err.category, providerStatus: err.status }, 'msg91 request failed');
        if (!retryable || attempt === this.maxRetries) break;
        const retryAfterMs = err.retryAfterMs ?? Math.min(2000, 250 * 2 ** attempt);
        await this.sleep(retryAfterMs);
      }
    }
    throw lastErr;
  }

  async #once(method, url, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetch(url, {
        method,
        headers: { authkey: this.authKey, accept: 'application/json', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw new Msg91Error('MSG91 request timed out', { category: 'timeout', retryable: true });
      throw new Msg91Error('MSG91 network error', { category: 'provider_unavailable', retryable: true });
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch { json = null; } }

    if (res.status === 401 || res.status === 403) throw new Msg91Error('MSG91 rejected credentials', { category: 'auth', status: res.status });
    if (res.status === 429) {
      const e = new Msg91Error('MSG91 rate limit', { category: 'rate_limit', status: 429, retryable: true });
      const ra = Number(res.headers?.get?.('retry-after'));
      if (ra > 0) e.retryAfterMs = Math.min(ra * 1000, 10000);
      throw e;
    }
    if (res.status >= 500) throw new Msg91Error('MSG91 server error', { category: 'provider_unavailable', status: res.status, retryable: true });
    if (res.status >= 400) throw new Msg91Error('MSG91 rejected the request', { category: 'invalid_request', status: res.status, providerCode: json?.errors ?? json?.code ?? null });

    if (json === null || typeof json !== 'object') {
      throw new Msg91Error('MSG91 returned an unparseable response', { category: 'invalid_response', status: res.status });
    }
    if (json.hasError === true || String(json.status).toLowerCase() === 'fail' || String(json.type).toLowerCase() === 'error') {
      throw new Msg91Error('MSG91 reported a failure', { category: 'invalid_request', status: res.status, providerCode: json.errors ?? json.message ?? null });
    }
    return json;
  }
}

/** Best-effort extraction of the provider message id from MSG91's response. Returns null if absent (we then never claim an id). */
export function extractMessageId(resp) {
  const c = [resp?.message_uuid, resp?.data?.message_uuid, resp?.uuid, resp?.data?.uuid, resp?.request_id, resp?.data?.request_id, resp?.data?.id];
  return c.find((v) => typeof v === 'string' && v) || null;
}
