/** Coerce to a bounded, control-character-free string. Objects/arrays are rejected (blocks NoSQL operator injection). */
export function cleanText(v, max = 500) {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  // eslint-disable-next-line no-control-regex
  return String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, max);
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:]+@[^\s@<>()[\]\\,;:]+\.[A-Za-z]{2,}$/;
export const isEmail = (v) => typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v);

const FREE_DOMAINS = new Set(['gmail.com', 'yahoo.com', 'yahoo.in', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'rediffmail.com', 'proton.me', 'protonmail.com']);
export const isFreeEmailDomain = (email) => FREE_DOMAINS.has(String(email).split('@')[1]?.toLowerCase());

/** Accepts http(s) URLs (adds https:// to bare domains). Returns normalised URL or null. */
export function normalizeUrl(v) {
  const t = cleanText(v, 300);
  if (!t || /\s/.test(t)) return null;
  const candidate = /^https?:\/\//i.test(t) ? t : `https://${t}`;
  try {
    const u = new URL(candidate);
    if (!['http:', 'https:'].includes(u.protocol) || !u.hostname.includes('.')) return null;
    return u.toString();
  } catch { return null; }
}

export const isLinkedInUrl = (u) => { try { return /(^|\.)linkedin\.com$/i.test(new URL(u).hostname); } catch { return false; } };

/** Parses DD/MM/YYYY, DD-MM-YYYY or YYYY-MM-DD. Returns ISO date (YYYY-MM-DD) or null. */
export function parseDate(v) {
  const t = cleanText(v, 30);
  let y, m, d;
  let x;
  if ((x = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) [, y, m, d] = x;
  else if ((x = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/))) [, d, m, y] = x;
  else return null;
  const dt = new Date(Date.UTC(+y, +m - 1, +d));
  if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +m - 1 || dt.getUTCDate() !== +d) return null;
  return dt.toISOString().slice(0, 10);
}

function luhn(num) {
  let sum = 0, alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let n = +num[i];
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}

/** Detects secrets users must never send (OTP/PIN/CVV/passwords/card numbers). Such text is never stored. */
export function containsSensitive(text) {
  const t = String(text || '');
  if (/\b(otp|cvv|cvc|pin)\b\D{0,12}\d{3,8}/i.test(t)) return true;
  if (/\b(password|passcode|passwd)\s*(is|:|=)\s*\S+/i.test(t)) return true;
  const digits = t.replace(/[\s-]/g, '');
  const m = digits.match(/\d{13,19}/);
  return Boolean(m && luhn(m[0]));
}
