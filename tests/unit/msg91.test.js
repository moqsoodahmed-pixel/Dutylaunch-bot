import '../env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Msg91Client, Msg91Error, extractMessageId } from '../../src/services/msg91/msg91.client.js';
import { createWhatsApp } from '../../src/services/msg91/msg91.whatsapp.js';
import { buildButtons, buildList, LIMITS } from '../../src/services/msg91/msg91.interactive.js';
import { buildFlow, parseFlowResponse } from '../../src/services/msg91/msg91.flow.js';
import { buildTemplatePayload } from '../../src/services/msg91/msg91.templates.js';
import { normalizeInbound } from '../../src/services/msg91/msg91.inbound.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const resp = (status, body, headers = {}) => ({ status, ok: status < 400, headers: { get: (k) => headers[k.toLowerCase()] }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const mk = (fetchImpl, extra = {}) => new Msg91Client({ authKey: 'SECRET_KEY_123', integratedNumber: '910000000000', fetchImpl, sleep: async () => {}, logger: silent, maxRetries: 2, ...extra });

test('client sends authkey header, never in the URL or body; returns parsed JSON', async () => {
  let seen;
  const c = mk(async (url, init) => { seen = { url: String(url), init }; return resp(200, { status: 'success', message_uuid: 'u1' }); });
  const r = await c.request({ path: '/api/v5/whatsapp/whatsapp-outbound-message/', body: { a: 1 } });
  assert.equal(r.message_uuid, 'u1');
  assert.equal(seen.init.headers.authkey, 'SECRET_KEY_123');
  assert.ok(!seen.url.includes('SECRET_KEY_123'));
  assert.ok(!seen.init.body.includes('SECRET_KEY_123'));
});

test('client retries 5xx and 429 (honouring Retry-After), then succeeds', async () => {
  const calls = []; const waits = [];
  const seq = [resp(503, {}), resp(429, {}, { 'retry-after': '2' }), resp(200, { status: 'success', uuid: 'ok' })];
  const c = mk(async () => { calls.push(1); return seq.shift(); }, { sleep: async (ms) => { waits.push(ms); } });
  const r = await c.request({ path: '/x', body: {} });
  assert.equal(r.uuid, 'ok'); assert.equal(calls.length, 3); assert.equal(waits[1], 2000);
});

test('client gives up after max retries with a categorised, retryable error', async () => {
  let n = 0;
  const c = mk(async () => { n += 1; return resp(502, {}); });
  await assert.rejects(c.request({ path: '/x', body: {} }), (e) => e instanceof Msg91Error && e.category === 'provider_unavailable' && e.retryable === true);
  assert.equal(n, 3);
});

test('client does not retry auth / invalid-request errors', async () => {
  let n = 0;
  const c = mk(async () => { n += 1; return resp(401, {}); });
  await assert.rejects(c.request({ path: '/x', body: {} }), (e) => e.category === 'auth' && !e.retryable);
  assert.equal(n, 1);
  n = 0;
  const c2 = mk(async () => { n += 1; return resp(400, { errors: 'bad' }); });
  await assert.rejects(c2.request({ path: '/x', body: {} }), (e) => e.category === 'invalid_request');
  assert.equal(n, 1);
});

test('client treats HTTP 200 with {status:"fail"} / non-JSON as failures', async () => {
  await assert.rejects(mk(async () => resp(200, { status: 'fail', message: 'x' })).request({ path: '/x', body: {} }), (e) => e.category === 'invalid_request');
  await assert.rejects(mk(async () => resp(200, '<html>oops</html>')).request({ path: '/x', body: {} }), (e) => e.category === 'invalid_response');
});

test('client times out and classifies network errors', async () => {
  const hang = (_u, init) => new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  await assert.rejects(mk(hang, { timeoutMs: 20, maxRetries: 0 }).request({ path: '/x', body: {} }), (e) => e.category === 'timeout');
  await assert.rejects(mk(async () => { throw new TypeError('fetch failed'); }, { maxRetries: 0 }).request({ path: '/x', body: {} }), (e) => e.category === 'provider_unavailable');
});

test('client refuses to run without credentials', async () => {
  const c = new Msg91Client({ authKey: '', integratedNumber: '', fetchImpl: async () => resp(200, {}), logger: silent });
  await assert.rejects(c.request({ path: '/x' }), (e) => e.category === 'config');
});

test('client logs never contain the auth key', async () => {
  const lines = [];
  const logger = { debug: (o) => lines.push(JSON.stringify(o)), info: (o) => lines.push(JSON.stringify(o)), warn: (o) => lines.push(JSON.stringify(o)), error: (o) => lines.push(JSON.stringify(o)) };
  await assert.rejects(mk(async () => resp(500, {}), { logger, maxRetries: 1 }).request({ path: '/x', body: {} }));
  assert.ok(lines.length > 0);
  assert.ok(!lines.join('').includes('SECRET_KEY_123'));
});

test('whatsapp layer: text uses documented query params; interactive uses JSON body', async () => {
  const seen = [];
  const c = mk(async (url, init) => { seen.push({ url: new URL(String(url)), body: init.body ? JSON.parse(init.body) : null }); return resp(200, { status: 'success', message_uuid: 'm1' }); });
  const wa = createWhatsApp(c);
  const t = await wa.sendText('919876543210', 'Hello');
  assert.equal(t.providerMessageId, 'm1');
  assert.equal(seen[0].url.pathname, '/api/v5/whatsapp/whatsapp-outbound-message/');
  assert.equal(seen[0].url.searchParams.get('recipient_number'), '919876543210');
  assert.equal(seen[0].url.searchParams.get('content_type'), 'text');
  await wa.sendInteractiveButtons('919876543210', { body: 'Pick', buttons: [{ id: 'a', title: 'A' }] });
  assert.equal(seen[1].body.content_type, 'interactive');
  assert.equal(seen[1].body.interactive.type, 'button');
  await wa.sendFlow('919876543210', { body: 'b', flowId: 'F1', token: 't', screen: 'S', data: {} });
  assert.equal(seen[2].body.interactive.type, 'flow');
  assert.equal(seen[2].body.interactive.action.parameters.flow_id, 'F1');
});

test('interactive builders enforce and clip WhatsApp limits', () => {
  const b = buildButtons({ body: 'x'.repeat(2000), buttons: [{ id: 'a', title: 'T'.repeat(40) }] });
  assert.ok([...b.body.text].length <= LIMITS.body);
  assert.ok([...b.action.buttons[0].reply.title].length <= LIMITS.buttonTitle);
  assert.throws(() => buildButtons({ body: 'x', buttons: [] }));
  assert.throws(() => buildButtons({ body: 'x', buttons: Array.from({ length: 4 }, (_, i) => ({ id: `${i}`, title: 'x' })) }));
  assert.throws(() => buildList({ body: 'x', sections: [{ rows: Array.from({ length: 11 }, (_, i) => ({ id: `${i}`, title: 'x' })) }] }));
  const l = buildList({ body: 'x', sections: [{ title: 'S', rows: [{ id: 'r', title: 'R'.repeat(50), description: 'D'.repeat(200) }] }] });
  assert.ok([...l.action.sections[0].rows[0].title].length <= LIMITS.rowTitle);
  assert.ok([...l.action.sections[0].rows[0].description].length <= LIMITS.rowDescription);
});

test('flow builder and response parser', () => {
  assert.throws(() => buildFlow({ body: 'x', token: 't' }), /flowId/);
  assert.throws(() => buildFlow({ body: 'x', flowId: 'F' }), /token/);
  const f = buildFlow({ body: 'b', flowId: 'F', token: 'tok', screen: 'SERVICE_SELECTION', data: { services: [] }, draft: true });
  assert.equal(f.action.parameters.mode, 'draft');
  assert.equal(f.action.parameters.flow_action_payload.screen, 'SERVICE_SELECTION');
  assert.deepEqual(parseFlowResponse('{"services":["a","b"],"flow_token":"t"}'), { services: ['a', 'b'], flow_token: 't' });
  assert.equal(parseFlowResponse('{bad'), null);
  assert.equal(parseFlowResponse('[1]'), null);
});

test('template payload uses positional body variables', () => {
  const p = buildTemplatePayload({ integratedNumber: '91000', to: '919876543210', name: 'ticket_ack', languageCode: 'en', namespace: 'ns', variables: ['Asha', 'DL-1'] });
  const t = p.payload.template;
  assert.equal(t.name, 'ticket_ack'); assert.equal(t.namespace, 'ns');
  assert.equal(t.to_and_components[0].components.body_2.value, 'DL-1');
});

test('extractMessageId handles the documented and alternative shapes', () => {
  assert.equal(extractMessageId({ message_uuid: 'a' }), 'a');
  assert.equal(extractMessageId({ data: { uuid: 'b' } }), 'b');
  assert.equal(extractMessageId({}), null);
});

test('inbound: Meta Cloud shape (text, button, list, flow reply, status)', () => {
  const wrap = (value) => ({ entry: [{ changes: [{ value }] }] });
  const base = { contacts: [{ wa_id: '919876543210', profile: { name: 'Asha' } }] };
  const [text] = normalizeInbound(wrap({ ...base, messages: [{ from: '919876543210', id: 'w1', timestamp: '1790000000', type: 'text', text: { body: ' hello ' } }] }));
  assert.equal(text.type, 'text'); assert.equal(text.text, 'hello'); assert.equal(text.name, 'Asha'); assert.equal(text.eventId, 'w1');
  const [btn] = normalizeInbound(wrap({ messages: [{ from: '91', id: 'w2', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'welcome_resume', title: 'Build My Resume' } } }] }));
  assert.equal(btn.type, 'button'); assert.equal(btn.replyId, 'welcome_resume');
  const [lst] = normalizeInbound(wrap({ messages: [{ from: '91', id: 'w3', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'svc:x', title: 'X' } } }] }));
  assert.equal(lst.type, 'list'); assert.equal(lst.replyId, 'svc:x');
  const [flow] = normalizeInbound(wrap({ messages: [{ from: '91', id: 'w4', type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: { response_json: '{"services":["a"],"flow_token":"t"}' } } }] }));
  assert.equal(flow.type, 'flow'); assert.deepEqual(flow.flowResponse.services, ['a']);
  const [st] = normalizeInbound(wrap({ statuses: [{ id: 'wamid.1', status: 'FAILED', recipient_id: '91', errors: [{ code: 131026 }] }] }));
  assert.equal(st.kind, 'status'); assert.equal(st.status, 'failed'); assert.equal(st.errorCode, '131026');
});

test('inbound: assumed MSG91 envelope, and rejection of non-objects', () => {
  const [m] = normalizeInbound({ customerNumber: '919876543210', customerName: 'Asha', contentType: 'text', text: 'hi', uuid: 'u-1' });
  assert.equal(m.from, '919876543210'); assert.equal(m.text, 'hi'); assert.equal(m.eventId, 'u-1');
  assert.deepEqual(normalizeInbound({}), []);
  assert.throws(() => normalizeInbound(null)); assert.throws(() => normalizeInbound([])); assert.throws(() => normalizeInbound('x'));
});

test('inbound: events without an id still get a deterministic idempotency key', () => {
  const p = { customerNumber: '919876543210', contentType: 'text', text: 'same' };
  assert.equal(normalizeInbound(p)[0].eventId, normalizeInbound({ ...p })[0].eventId);
});
