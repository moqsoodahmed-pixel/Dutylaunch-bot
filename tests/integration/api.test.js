import '../env.js';
process.env.TEMPLATE_PAYMENT_CONFIRMATION = 'payment_confirmation';   // confirmations must be templates (outside the 24h window)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, API, sign } from '../helpers.js';
import { Contact, Lead, Order, SupportTicket, AnalyticsEvent, MessageLog, WebhookEvent } from '../../src/models/index.js';

let h;
before(async () => { h = await startHarness(); });
after(async () => { await h.stop(); });

const api = (method, path, body, headers = API) => fetch(h.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
const payEvent = (body, secret = 'pay_test_secret') => {
  const raw = JSON.stringify(body);
  return fetch(h.base + '/events/payment', { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': sign(secret, raw) }, body: raw });
};

test('health endpoint reports db and config status without secrets', async () => {
  const r = await api('GET', '/health', undefined, {});
  const b = await r.json();
  assert.equal(r.status, 200);
  assert.equal(b.db, 'up');
  assert.ok(!JSON.stringify(b).includes('test-auth-key'));
});

test('internal endpoints require the API key', async () => {
  for (const [m, p] of [['POST', '/contacts/upsert'], ['POST', '/leads'], ['GET', '/orders/X'], ['POST', '/support/tickets'], ['POST', '/messages/send'], ['GET', '/analytics/summary'], ['PUT', '/services/ai_resume_builder']]) {
    const r = await api(m, p, m === 'GET' ? undefined : {}, { 'content-type': 'application/json' });
    assert.equal(r.status, 401, `${m} ${p}`);
  }
});

test('POST /contacts/upsert: normalises the number, never duplicates, requires a consent source', async () => {
  const a = await (await api('POST', '/contacts/upsert', { whatsappNumber: '+91 98765 43210', name: 'Meera', email: 'meera@example.com', source: 'landing', landingPage: '/resume' })).json();
  const b = await (await api('POST', '/contacts/upsert', { whatsappNumber: '919876543210', name: 'Meera S' })).json();
  assert.equal(a.contact.contactId, b.contact.contactId);
  assert.equal(a.contact.normalizedWhatsappNumber, '919876543210');
  assert.equal(await Contact.countDocuments({ normalizedWhatsappNumber: '919876543210' }), 1);
  assert.equal((await api('POST', '/contacts/upsert', { whatsappNumber: 'abc' })).status, 400);
  assert.equal((await api('POST', '/contacts/upsert', { whatsappNumber: '919876543210', marketingOptIn: true })).status, 400);
  const ok = await api('POST', '/contacts/upsert', { whatsappNumber: '919876543210', marketingOptIn: true, consentSource: 'website_form' });
  assert.equal((await ok.json()).contact.marketingOptIn, true);
});

test('POST /leads: one lead with stable IDs, repeat call updates instead of duplicating, unknown IDs rejected', async () => {
  const body = { whatsappNumber: '919876500099', name: 'Kiran', serviceInterest: ['ai_resume_builder', 'linkedin_optimization'], targetRole: 'Analyst' };
  const r1 = await api('POST', '/leads', body);
  assert.equal(r1.status, 201);
  const r2 = await api('POST', '/leads', { ...body, serviceInterest: ['cover_letter_generator'] });
  assert.equal(r2.status, 200);
  const leads = await Lead.find({}).lean();
  const mine = leads.filter((l) => l.targetRole === 'Analyst');
  assert.equal(mine.length, 1);
  assert.deepEqual([...mine[0].selectedServices].sort(), ['ai_resume_builder', 'cover_letter_generator', 'linkedin_optimization']);
  assert.equal((await api('POST', '/leads', { ...body, serviceInterest: ['made_up_service'] })).status, 400);
  assert.equal((await api('POST', '/leads', { serviceInterest: [] })).status, 400);
});

test('POST /support/tickets: creates, routes, and dedupes on dedupeKey', async () => {
  const b = { whatsappNumber: '919876500098', category: 'payment_refund', summary: 'Double charged', orderId: 'ORD-77', dedupeKey: 'k-1' };
  const r1 = await api('POST', '/support/tickets', b);
  const r2 = await api('POST', '/support/tickets', b);
  const t1 = await r1.json(); const t2 = await r2.json();
  assert.equal(r1.status, 201); assert.equal(r2.status, 200);
  assert.equal(t1.ticket.ticketId, t2.ticket.ticketId);
  assert.ok(t1.ticket.assignedQueue);
  assert.equal(await SupportTicket.countDocuments({ dedupeKey: 'k-1' }), 1);
  assert.equal((await api('POST', '/support/tickets', { whatsappNumber: '919876500098' })).status, 400);
});

test('GET /orders/:id returns backend status and hides orders belonging to another number', async () => {
  await Order.create({ orderId: 'ORD-55', customerPhone: '919876500055', paymentStatus: 'paid', status: 'paid', amount: 100, currency: 'INR' });
  assert.equal((await (await api('GET', '/orders/ORD-55')).json()).order.paymentStatus, 'paid');
  assert.equal((await api('GET', '/orders/ORD-55?phone=919876500055')).status, 200);
  assert.equal((await api('GET', '/orders/ORD-55?phone=919000000000')).status, 404);
  assert.equal((await api('GET', '/orders/NOPE')).status, 404);
});

test('POST /messages/send: policy gated (24h window, consent) and failures are never reported as sent', async () => {
  await api('POST', '/contacts/upsert', { whatsappNumber: '919876500050' });
  // no inbound yet => outside the customer-service window => free-form text is blocked
  const blocked = await api('POST', '/messages/send', { whatsappNumber: '919876500050', type: 'text', text: 'hello' });
  assert.equal(blocked.status, 422);
  // templates may be sent outside the window (service purpose)
  const tpl = await api('POST', '/messages/send', { whatsappNumber: '919876500050', type: 'template', templateName: 'ticket_ack', variables: ['A'] });
  assert.equal(tpl.status, 200);
  assert.equal(h.wa.sent.at(-1).kind, 'template');
  // marketing needs explicit opt-in
  const mk = await api('POST', '/messages/send', { whatsappNumber: '919876500050', type: 'template', templateName: 'promo', purpose: 'marketing' });
  assert.equal(mk.status, 422);
  // provider failure => 502, not "sent"
  h.wa.failAlways = true;
  const fail = await api('POST', '/messages/send', { whatsappNumber: '919876500050', type: 'template', templateName: 'ticket_ack' });
  h.wa.failAlways = false;
  assert.equal(fail.status, 502);
  assert.equal((await fail.json()).sent, false);
  assert.equal((await api('POST', '/messages/send', { whatsappNumber: '919999999999', type: 'text', text: 'x' })).status, 404);
});

test('PUT /services/:id updates config; invalid URL rejected; GET /services lists', async () => {
  const bad = await api('PUT', '/services/ai_resume_builder', { url: 'javascript:alert(1)' });
  assert.equal(bad.status, 400);
  const ok = await api('PUT', '/services/ai_resume_builder', { active: true, url: 'https://example.com/r', live: true });
  assert.equal((await ok.json()).service.live, true);
  await api('PUT', '/services/ai_resume_builder', { url: null, live: false });
  assert.equal((await api('PUT', '/services/nope', { active: true })).status, 404);
  const list = await (await api('GET', '/services')).json();
  assert.equal(list.services.length, 9);
});

test('POST /events/payment: signature required, idempotent, confirms once, cannot downgrade', async () => {
  const phone = '919876500077';
  await api('POST', '/contacts/upsert', { whatsappNumber: phone, name: 'Dev Patel' });
  const unsigned = await fetch(h.base + '/events/payment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(unsigned.status, 401);
  const wrongSig = await payEvent({ eventId: 'e0', orderId: 'ORD-P1', status: 'paid' }, 'wrong');
  assert.equal(wrongSig.status, 401);

  const ev = { eventId: 'evt-1', orderId: 'ORD-P1', status: 'paid', amount: 499, currency: 'INR', customerPhone: phone, serviceId: 'ai_resume_builder' };
  const sentBefore = h.wa.sent.length;
  const r1 = await (await payEvent(ev)).json();
  assert.equal(r1.paymentStatus, 'paid');
  assert.equal(r1.confirmation.sent, true);
  const dup = await (await payEvent(ev)).json();
  assert.equal(dup.duplicate, true);
  // a different event id for the same paid order must not send a second confirmation
  const again = await (await payEvent({ ...ev, eventId: 'evt-2' })).json();
  assert.equal(again.confirmation.sent, false);
  assert.equal(h.wa.sent.length - sentBefore, 1);
  // out-of-order "pending" after "paid" is ignored
  const late = await (await payEvent({ ...ev, eventId: 'evt-3', status: 'pending' })).json();
  assert.equal(late.paymentStatus, 'paid');
  assert.equal((await Order.findOne({ orderId: 'ORD-P1' }).lean()).paymentStatus, 'paid');
  assert.equal(await AnalyticsEvent.countDocuments({ type: 'payment_confirmed', 'meta.orderId': 'ORD-P1' }), 1);
  assert.equal(await WebhookEvent.countDocuments({ provider: 'payment', providerEventId: 'evt-1' }), 1);
  assert.equal((await payEvent({ eventId: 'x', orderId: 'o', status: 'bogus' })).status, 400);
});

test('payment confirmation send failure is not reported as sent and can be retried later', async () => {
  const phone = '919876500078';
  await api('POST', '/contacts/upsert', { whatsappNumber: phone });
  h.wa.failAlways = true;
  const r = await (await payEvent({ eventId: 'evt-f1', orderId: 'ORD-P2', status: 'paid', customerPhone: phone })).json();
  h.wa.failAlways = false;
  assert.equal(r.confirmation.sent, false);
  assert.equal((await Order.findOne({ orderId: 'ORD-P2' }).lean()).confirmationSentAt ?? null, null);
  const retry = await (await payEvent({ eventId: 'evt-f2', orderId: 'ORD-P2', status: 'paid', customerPhone: phone })).json();
  assert.equal(retry.confirmation.sent, true);
});

test('GET /analytics/summary returns queryable metrics from MongoDB', async () => {
  const u = h.user('919876500060');
  await u.say('hello'); await u.say('human'); await u.tap('ho:other'); await u.say('STOP');
  const s = await (await api('GET', '/analytics/summary')).json();
  assert.ok(s.uniqueContacts >= 1);
  assert.ok(s.counts.conversation_started >= 1);
  assert.ok(s.counts.human_handoff >= 1);
  assert.ok(s.counts.ticket_created >= 1);
  assert.ok(s.counts.opt_out >= 1);
  assert.equal(typeof s.fallbackRate, 'number');
  assert.ok(await MessageLog.countDocuments({}) > 0);
});

test('error responses never leak internals', async () => {
  const r = await fetch(h.base + '/nope');
  assert.equal(r.status, 404);
  const bad = await fetch(h.base + '/leads', { method: 'POST', headers: API, body: '{oops' });
  assert.equal(bad.status, 400);
  assert.ok(!(await bad.text()).includes('at '));
});
