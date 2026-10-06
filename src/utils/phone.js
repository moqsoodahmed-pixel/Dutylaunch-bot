import crypto from 'node:crypto';

/** Normalise to digits-only international format (no '+'). 10-digit numbers get the default country code. */
export function normalizePhone(raw, defaultCountryCode = '91') {
  if (raw === null || raw === undefined) return null;
  let d = String(raw).replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10) d = defaultCountryCode + d;
  if (d.length < 8 || d.length > 15) return null;
  return d;
}

export const maskNumber = (n) => (n ? `${'*'.repeat(Math.max(0, String(n).length - 4))}${String(n).slice(-4)}` : '');
export const sha256 = (v) => crypto.createHash('sha256').update(typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v)).digest('hex');
export const hashNumber = (n) => sha256(String(n)).slice(0, 16);
