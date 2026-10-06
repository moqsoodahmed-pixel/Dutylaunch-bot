export const notFound = (req, res) => res.status(404).json({ error: 'not_found' });

/** Central error handler. Never leaks stack traces or internals to clients. */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const log = req.log || console;
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
  const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status >= 500) log.error?.({ action: 'unhandled_error', errorCategory: err?.name, msg: err?.message }, 'request failed');
  res.status(status).json({ error: status === 500 ? 'internal_error' : (err.message || 'bad_request') });
}

/** Wraps async route handlers so rejections reach the error handler. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
