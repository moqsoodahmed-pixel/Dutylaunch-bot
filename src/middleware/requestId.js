import { newId } from '../utils/ids.js';

/** Assigns a request ID (accepts a sane inbound X-Request-Id) and a child logger. */
export function requestId(logger) {
  return (req, res, next) => {
    const inbound = String(req.headers['x-request-id'] || '');
    req.id = /^[A-Za-z0-9._-]{8,64}$/.test(inbound) ? inbound : newId();
    res.setHeader('X-Request-Id', req.id);
    req.log = logger.child({ requestId: req.id });
    next();
  };
}
