import { sha256 } from '../../utils/phone.js';
import { cleanText } from '../../utils/sanitize.js';
import { parseFlowResponse } from './msg91.flow.js';

/**
 * Normalises inbound webhooks into a provider-neutral shape.
 *
 * Two shapes are supported because MSG91 can relay either its own envelope
 * ({customerNumber, customerName, contentType, text, uuid, contents}) or the raw Meta Cloud format
 * ({entry[].changes[].value.messages/statuses}). The exact MSG91 envelope for YOUR account must be
 * confirmed from a real captured webhook (see docs/DEPLOYMENT.md "Capture a real payload").
 *
 * Output event:
 *  { kind:'message', eventId, messageId, from, name, timestamp, type:'text'|'button'|'list'|'flow'|'other',
 *    text, replyId, replyTitle, flowResponse, referral }
 *  { kind:'status', eventId, messageId, status, errorCode, timestamp, recipient }
 */
export function normalizeInbound(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('payload must be a JSON object');
  const events = [];

  // --- Meta Cloud style ---
  const metaValues = [];
  if (Array.isArray(body.entry)) {
    for (const e of body.entry) for (const c of e?.changes || []) if (c?.value) metaValues.push(c.value);
  } else if (Array.isArray(body.messages) || Array.isArray(body.statuses)) {
    metaValues.push(body);
  }
  for (const v of metaValues) {
    const nameByWaId = new Map((v.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
    for (const m of v.messages || []) events.push(fromMetaMessage(m, nameByWaId.get(m.from)));
    for (const s of v.statuses || []) events.push(fromMetaStatus(s));
  }
  if (events.length) return events.filter(Boolean);

  // --- MSG91 envelope ---
  if (body.customerNumber || body.contentType || body.sender) {
    const ev = fromMsg91Envelope(body);
    if (ev) return [ev];
  }
  return [];
}

function fromMetaMessage(m, name) {
  if (!m || !m.from) return null;
  const base = { kind: 'message', messageId: m.id || null, from: String(m.from), name: cleanText(name, 80) || null, timestamp: toDate(m.timestamp), referral: m.referral || null };
  const ev = { ...base, ...classify(m) };
  ev.eventId = m.id || `h_${sha256(m).slice(0, 32)}`;
  return ev;
}

function fromMetaStatus(s) {
  if (!s || !s.id) return null;
  return {
    kind: 'status', messageId: s.id, recipient: s.recipient_id ? String(s.recipient_id) : null,
    status: String(s.status || '').toLowerCase(), errorCode: s.errors?.[0]?.code != null ? String(s.errors[0].code) : null,
    timestamp: toDate(s.timestamp), eventId: `st_${s.id}_${String(s.status || '').toLowerCase()}`
  };
}

function fromMsg91Envelope(b) {
  const from = b.customerNumber || b.sender || b.from;
  if (!from) return null;
  let contents = b.contents ?? b.content ?? null;
  if (typeof contents === 'string') { try { contents = JSON.parse(contents); } catch { /* keep string */ } }
  const probe = { ...(contents && typeof contents === 'object' ? contents : {}), ...(b.interactive ? { interactive: b.interactive } : {}) };
  const kind = String(b.contentType || b.type || '').toLowerCase();
  let c = classify({ type: kind || 'text', text: { body: b.text }, ...probe });
  if (c.type === 'text' && !c.text) c = { type: 'text', text: cleanText(b.text, 1000) };
  const messageId = b.uuid || b.messageId || b.message_id || b.id || null;
  return {
    kind: 'message', messageId, from: String(from), name: cleanText(b.customerName, 80) || null,
    timestamp: toDate(b.ts || b.timestamp), referral: b.referral || null, ...c,
    eventId: messageId ? String(messageId) : `h_${sha256(b).slice(0, 32)}`
  };
}

/** Finds the user's action inside a Meta-style message object. */
function classify(m) {
  const i = m.interactive;
  if (i?.type === 'button_reply' || i?.button_reply) {
    const r = i.button_reply; return { type: 'button', replyId: String(r.id), replyTitle: cleanText(r.title, 80) };
  }
  if (i?.type === 'list_reply' || i?.list_reply) {
    const r = i.list_reply; return { type: 'list', replyId: String(r.id), replyTitle: cleanText(r.title, 80) };
  }
  if (i?.type === 'nfm_reply' || i?.nfm_reply) {
    const flowResponse = parseFlowResponse(i.nfm_reply?.response_json);
    return { type: 'flow', flowResponse };
  }
  if (m.type === 'button' && m.button) {
    return { type: 'button', replyId: String(m.button.payload || m.button.text || ''), replyTitle: cleanText(m.button.text, 80) };
  }
  if (m.type === 'text' || typeof m.text === 'string' || m.text?.body !== undefined) {
    const t = typeof m.text === 'string' ? m.text : m.text?.body;
    return { type: 'text', text: cleanText(t, 1000) };
  }
  return { type: 'other', text: '' };
}

function toDate(ts) {
  if (!ts) return new Date();
  const n = Number(ts);
  if (Number.isFinite(n)) return new Date(n < 1e12 ? n * 1000 : n);
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}
