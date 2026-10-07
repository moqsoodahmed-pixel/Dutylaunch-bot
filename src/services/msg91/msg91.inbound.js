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

/**
 * MSG91 "Custom Webhook" sends a flat JSON object built from a template like
 *   { "customerNumber": "{{customerNumber}}", "contentType": "{{contentType}}",
 *     "text": "{{text}}", "interactive": "{{interactive}}", "button": "{{button}}", ... }
 * Because every value sits inside quotes, nested objects (interactive, button,
 * messages) arrive as JSON *strings*, and fields that don't apply arrive as ""
 * or as the literal placeholder "{{field}}". Verified against live MSG91 traffic.
 */
function blank(v) {
  if (v === undefined || v === null) return true;
  if (typeof v !== 'string') return false;
  const t = v.trim();
  return t === '' || t === 'null' || t === 'undefined' || /^\{\{.*\}\}$/.test(t);
}

/** Returns an object for JSON strings, the value itself otherwise, null for blanks. */
function parseMaybeJson(v) {
  if (blank(v)) return null;
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!/^[\[{]/.test(t)) return t;
  try { return JSON.parse(t); } catch { return t; }
}

function fromMsg91Envelope(b) {
  const from = [b.customerNumber, b.sender, b.from].find((v) => !blank(v));
  if (!from) return null;

  // MSG91 may also forward the raw Meta message(s) in "messages"
  let raw = parseMaybeJson(b.messages);
  if (Array.isArray(raw)) raw = raw[0];
  if (!raw || typeof raw !== 'object') raw = null;

  let contents = parseMaybeJson(b.contents ?? b.content);
  const interactive = parseMaybeJson(b.interactive) ?? raw?.interactive ?? null;
  const button = parseMaybeJson(b.button) ?? raw?.button ?? null;
  const textValue = blank(b.text) ? (raw?.text?.body ?? '') : parseMaybeJson(b.text);
  const textBody = typeof textValue === 'object' && textValue !== null ? (textValue.body ?? '') : textValue;

  const probe = {
    ...(contents && typeof contents === 'object' ? contents : {}),
    ...(interactive && typeof interactive === 'object' ? { interactive } : {}),
    ...(button && typeof button === 'object' ? { button } : {})
  };
  const kind = String((!blank(b.contentType) && b.contentType) || (!blank(b.type) && b.type) || raw?.type || 'text').toLowerCase();

  let c = classify({ type: kind, text: { body: textBody }, ...probe });
  // Quick-reply button sent only as a title string
  if (c.type !== 'button' && kind === 'button' && typeof button === 'string') {
    c = { type: 'button', replyId: button, replyTitle: cleanText(button, 80) };
  }
  if (c.type === 'text' && !c.text) c = { type: 'text', text: cleanText(textBody, 1000) };

  const messageId = [b.uuid, b.messageId, b.message_id, b.id, raw?.id].find((v) => !blank(v)) || null;
  return {
    kind: 'message', messageId, from: String(from).replace(/\D/g, ''),
    name: blank(b.customerName) ? null : (cleanText(b.customerName, 80) || null),
    timestamp: toDate(blank(b.ts) ? (blank(b.timestamp) ? null : b.timestamp) : b.ts),
    referral: b.referral || null, ...c,
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