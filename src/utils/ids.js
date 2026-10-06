import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alikes
export function shortCode(len = 8) {
  const bytes = crypto.randomBytes(len);
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}
export const newId = () => crypto.randomUUID();
export const ticketId = () => `DL-${shortCode(8)}`;
export const leadId = () => `LD-${shortCode(8)}`;

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
