import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, HEADERS, sign } from '../helpers.js';
import { Conversation, Lead, Contact, WebhookEvent, MessageLog, AnalyticsEvent, SupportTicket } from '../../src/models/index.js';

let h;
before(async () => { h = await startHarness(); });
after(async () => { mock.restoreAll(); await h.stop(); });

test('20. duplicate webhook delivery is processed once (no duplicate reply, conversation, contact)', async () => {
  const u = h.user('919700000001');
  const r1 = await u.say('hello');
  const sent = u.out().length;
  const dup = await h.post('/webhooks/whatsapp', h.metaMessage(u.number, { id: r1.id, type: 'text', text: { body: 'hello' } }));
  await h.webhook.drain();
  assert.equal(dup.status, 200);
  const body = await dup.json();
  assert.equal(body.duplicates, 1);
  assert.equal(body.accepted, 0);
  assert.equal(u.out().length, sent);
  assert.equal(await Conversation.countDocuments({ whatsappNumber: u.number }), 1);
  assert.equal(await WebhookEvent.countDocuments({ providerEventId: r1.id }), 1);
});

test('20b. same event delivered twice CONCURRENTLY is still processed once', async () => {
  const u = h.user('919700000002');
  const payload = h.metaMessage(u.number, { id: 'wamid.same.1', type: 'text', text: { body: 'hi' } });
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => h.post('/webhooks/whatsapp', payload)));
  await h.webhook.drain();
  assert.deepEqual([a.status, b.status, c.status], [200, 200, 200]);
  assert.equal(u.out().length, 1);
  assert.equal(await Conversation.countDocuments({ whatsappNumber: u.number }), 1);
});

test('21. MSG91 failure: state is saved, nothing is lost, undelivered prompt is resent when MSG91 recovers', async () => {
  const u = h.user('919700000003');
  h.wa.failAlways = true;
  const r = await u.say('hello');
  assert.equal(r.res.status, 200);                      // webhook still acknowledged
  assert.equal(u.out().length, 0);
  const c = await u.conv();
  assert.ok(c, 'conversation persisted even though sending failed');
  assert.ok(c.pendingPrompts.length >= 1);
  assert.ok(await AnalyticsEvent.findOne({ type: 'delivery_failed', conversationId: c.conversationId }));
  assert.ok(await MessageLog.findOne({ conversationId: c.conversationId, status: 'failed' }));
  h.wa.failAlways = false;
  const resent = await h.engine.resendPending();
  assert.equal(resent, 1);
  assert.equal(u.out().length, 1);
  assert.equal((await u.conv()).pendingPrompts.length, 0);
  assert.equal(await Conversation.countDocuments({ whatsappNumber: u.number }), 1);
});

test('21b. MSG91 failure while submitting never blocks saving the lead', async () => {
  const u = h.user('919700000004');
  await u.say('menu'); await u.tap('menu_select_services'); await u.tap('svc:linkedin_optimization'); await u.tap('svc_continue');
  assert.ok(await u.completeQuestions());
  h.wa.failAlways = true;
  await u.tap('confirm_submit');
  h.wa.failAlways = false;
  assert.equal(await Lead.countDocuments({ selectedServices: 'linkedin_optimization' }), 1);
});

test('22. MongoDB unavailable at the idempotency store => 503 so MSG91 retries; nothing is processed', async () => {
  const u = h.user('919700000005');
  const m = mock.method(WebhookEvent, 'create', async () => { throw new Error('connection refused'); });
  const res = await h.post('/webhooks/whatsapp', h.metaMessage(u.number, { id: 'wamid.db.down', type: 'text', text: { body: 'hi' } }));
  m.mock.restore();
  assert.equal(res.status, 503);
  assert.equal(u.out().length, 0);
  assert.equal(await WebhookEvent.countDocuments({ providerEventId: 'wamid.db.down' }), 0);
  // MSG91 retries the same event; it is then processed exactly once
  const retry = await h.post('/webhooks/whatsapp', h.metaMessage(u.number, { id: 'wamid.db.down', type: 'text', text: { body: 'hi' } }));
  await h.webhook.drain();
  assert.equal(retry.status, 200);
  assert.equal(u.out().length, 1);
});

test('22b. MongoDB fails while processing: event is marked failed, then the retry job completes it once', async () => {
  const u = h.user('919700000006');
  const m = mock.method(Conversation.prototype, 'save', async () => { throw new Error('write failed'); });
  const res = await h.post('/webhooks/whatsapp', h.metaMessage(u.number, { id: 'wamid.proc.fail', type: 'text', text: { body: 'hi' } }));
  await h.webhook.drain();
  m.mock.restore();
  assert.equal(res.status, 200);
  const ev = await WebhookEvent.findOne({ providerEventId: 'wamid.proc.fail' }).lean();
  assert.equal(ev.processed, false);
  assert.ok(ev.error);
  await WebhookEvent.updateOne({ providerEventId: 'wamid.proc.fail' }, { $set: { lockedUntil: new Date(Date.now() - 1000) } });
  const n = await h.webhook.retryStalled();
  assert.equal(n, 1);
  const after = await WebhookEvent.findOne({ providerEventId: 'wamid.proc.fail' }).lean();
  assert.equal(after.processed, true);
  assert.equal(await Conversation.countDocuments({ whatsappNumber: u.number }), 1);
  assert.equal(u.out().length, 1);
});

test('22c. a lead-write failure is never reported to the user as saved', async () => {
  const u = h.user('919700000007');
  await u.say('menu'); await u.tap('menu_select_services'); await u.tap('svc:cover_letter_generator'); await u.tap('svc_continue');
  assert.ok(await u.completeQuestions());
  const before = u.out().length;
  const m = mock.method(Lead, 'create', async () => { throw new Error('db down'); });
  await u.tap('confirm_submit');
  m.mock.restore();
  const newText = u.out().slice(before).map((x) => x.spec.body || '').join('\n');
  assert.match(newText, /couldn't save your request[^.]*nothing has been submitted/i);
  assert.ok(!/Reference: LD-|request has been saved/i.test(newText), `unexpected success claim: ${newText}`);
  assert.equal(await Lead.countDocuments({ selectedServices: 'cover_letter_generator' }), 0);
});

test('23. invalid payloads are rejected or ignored safely', async () => {
  const bad = await fetch(h.base + '/webhooks/whatsapp', { method: 'POST', headers: HEADERS, body: '{not json' });
  assert.equal(bad.status, 400);
  const arr = await h.post('/webhooks/whatsapp', [1, 2, 3]);
  assert.equal(arr.status, 400);
  const empty = await h.post('/webhooks/whatsapp', { hello: 'world' });
  assert.equal(empty.status, 200);
  assert.equal((await empty.json()).received, 0);
  const noFrom = await h.post('/webhooks/whatsapp', { entry: [{ changes: [{ value: { messages: [{ id: 'x', type: 'text', text: { body: 'hi' } }] } }] }] });
  assert.equal(noFrom.status, 200);
  const huge = await fetch(h.base + '/webhooks/whatsapp', { method: 'POST', headers: HEADERS, body: JSON.stringify({ a: 'x'.repeat(300000) }) });
  assert.equal(huge.status, 413);
});

test('23b. webhook authentication: missing/wrong secret is rejected', async () => {
  const p = h.metaMessage('919700000008', { id: 'wamid.auth.1', type: 'text', text: { body: 'hi' } });
  const none = await fetch(h.base + '/webhooks/whatsapp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p) });
  const wrong = await h.post('/webhooks/whatsapp', p, { 'content-type': 'application/json', 'x-webhook-secret': 'nope' });
  const viaQuery = await fetch(h.base + '/webhooks/whatsapp?secret=whsec_test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p) });
  await h.webhook.drain();
  assert.equal(none.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(viaQuery.status, 200);
});

test('23c. optional HMAC signature is enforced when configured', async () => {
  process.env.MSG91_WEBHOOK_HMAC_SECRET = 'hmac_secret';
  try {
    const raw = JSON.stringify(h.metaMessage('919700000009', { id: 'wamid.hmac.1', type: 'text', text: { body: 'hi' } }));
    const unsigned = await h.post('/webhooks/whatsapp', null, HEADERS, raw);
    const signed = await h.post('/webhooks/whatsapp', null, { ...HEADERS, 'x-signature': sign('hmac_secret', raw) }, raw);
    const tampered = await h.post('/webhooks/whatsapp', null, { ...HEADERS, 'x-signature': sign('hmac_secret', raw + ' ') }, raw);
    await h.webhook.drain();
    assert.equal(unsigned.status, 401);
    assert.equal(signed.status, 200);
    assert.equal(tampered.status, 401);
  } finally { delete process.env.MSG91_WEBHOOK_HMAC_SECRET; }
});

test('24. expired session starts a fresh conversation (welcome back) without losing the contact', async () => {
  const u = h.user('919700000010');
  await u.say('hello'); await u.tap('welcome_other'); await u.tap('menu_select_services'); await u.tap('svc:ai_resume_builder');
  const first = await u.conv();
  await Conversation.updateOne({ conversationId: first.conversationId }, { $set: { expiresAt: new Date(Date.now() - 60000) } });
  await u.say('hi');                                   // arrives before the sweeper runs
  const second = await u.conv();
  assert.notEqual(second.conversationId, first.conversationId);
  assert.deepEqual(second.selectedServices, []);
  assert.match(u.allText(), /Welcome back/);
  assert.equal(await Contact.countDocuments({ normalizedWhatsappNumber: u.number }), 1);
  const old = await Conversation.findOne({ conversationId: first.conversationId }).lean();
  assert.ok(['abandoned', 'completed'].includes(old.status));
});

test('25. concurrent events from ONE user are serialised (no lost toggles, one conversation)', async () => {
  const u = h.user('919700000011');
  await u.say('menu'); await u.tap('menu_select_services');
  const ids = ['ai_resume_builder', 'linkedin_optimization', 'cover_letter_generator', 'interview_preparation'];
  await Promise.all(ids.map((id) => u.tap(`svc:${id}`)));
  const c = await u.conv();
  assert.deepEqual([...c.selectedServices].sort(), [...ids].sort());
  assert.equal(await Conversation.countDocuments({ whatsappNumber: u.number }), 1);
});

test('25b. concurrent confirm taps produce exactly one lead and one ticket-free conversation', async () => {
  const u = h.user('919700000012');
  await u.say('menu'); await u.tap('menu_select_services');
  for (const id of ['ai_resume_builder', 'linkedin_optimization', 'cover_letter_generator']) await u.tap(`svc:${id}`);
  await u.tap('svc_continue');
  assert.ok(await u.completeQuestions());
  await Promise.all([u.tap('confirm_submit'), u.tap('confirm_submit'), u.tap('confirm_submit')]);
  const contact = await Contact.findOne({ normalizedWhatsappNumber: u.number }).lean();
  const leads = await Lead.find({ contactId: contact.contactId }).lean();
  assert.equal(leads.length, 1);
  assert.deepEqual(leads[0].selectedServices, ['ai_resume_builder', 'linkedin_optimization', 'cover_letter_generator']);
  assert.equal(await Conversation.countDocuments({ whatsappNumber: u.number }), 1);
});

test('25c. concurrent events from MANY users do not leak state between them', async () => {
  const users = Array.from({ length: 8 }, (_, i) => h.user(`9197000002${String(i).padStart(2, '0')}`));
  await Promise.all(users.map((u) => u.say('menu')));
  await Promise.all(users.map((u) => u.tap('menu_select_services')));
  const svc = ['ai_resume_builder', 'linkedin_optimization', 'cover_letter_generator', 'interview_preparation'];
  await Promise.all(users.map((u, i) => u.tap(`svc:${svc[i % 4]}`)));
  for (const [i, u] of users.entries()) assert.deepEqual((await u.conv()).selectedServices, [svc[i % 4]]);
  assert.equal(new Set((await Promise.all(users.map((u) => u.conv()))).map((c) => c.conversationId)).size, users.length);
});

test('delivery status webhooks update the message log and count failures', async () => {
  const u = h.user('919700000013');
  await u.say('hello');
  const row = await MessageLog.findOne({ providerMessageId: /wamid\.out/, contactId: (await Contact.findOne({ normalizedWhatsappNumber: u.number })).contactId }).lean();
  const statusPayload = (status, extra = {}) => ({ entry: [{ changes: [{ value: { statuses: [{ id: row.providerMessageId, status, recipient_id: u.number, timestamp: String(Math.floor(Date.now() / 1000)), ...extra }] } }] }] });
  await h.post('/webhooks/whatsapp', statusPayload('delivered')); await h.webhook.drain();
  assert.equal((await MessageLog.findOne({ providerMessageId: row.providerMessageId }).lean()).status, 'delivered');
  await h.post('/webhooks/whatsapp', statusPayload('sent')); await h.webhook.drain();
  assert.equal((await MessageLog.findOne({ providerMessageId: row.providerMessageId }).lean()).status, 'delivered', 'status must not go backwards');
  await h.post('/webhooks/whatsapp', statusPayload('failed', { errors: [{ code: 131026 }] })); await h.webhook.drain();
  assert.equal((await MessageLog.findOne({ providerMessageId: row.providerMessageId }).lean()).status, 'failed');
  assert.equal(await AnalyticsEvent.countDocuments({ type: 'delivery_failed', meta: { code: '131026', via: 'status_webhook' } }) >= 1, true);
});

test('unsupported message types (image/audio) get the fallback instead of breaking the flow', async () => {
  const u = h.user('919700000014');
  await u.say('hello');
  await u.raw({ type: 'image', image: { id: 'media1' } });
  assert.ok(u.out().length >= 2);
  assert.ok(u.last().kind === 'buttons' || u.last().kind === 'list');
});

test('SUPPORT typed command opens the support menu; HUMAN creates a ticket routed to a queue', async () => {
  const u = h.user('919700000015');
  await u.say('hello'); await u.say('support');
  assert.equal((await u.conv()).currentState, 'SUPPORT_MENU');
  await u.say('human'); await u.tap('ho:career_services');
  const t = await SupportTicket.findOne({ contactId: (await Contact.findOne({ normalizedWhatsappNumber: u.number })).contactId }).lean();
  assert.ok(t.ticketId.startsWith('DL-'));
  assert.ok(t.assignedQueue);
});
