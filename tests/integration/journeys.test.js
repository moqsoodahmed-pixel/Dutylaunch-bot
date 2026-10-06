import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from '../helpers.js';
import { Conversation, Lead, Contact, SupportTicket, AnalyticsEvent, WebhookEvent, Consent } from '../../src/models/index.js';
import { updateService } from '../../src/services/catalog/catalog.service.js';

let h;
before(async () => { h = await startHarness(); });
after(async () => { await h.stop(); });

const pickServices = async (u, ids) => {
  await u.say('menu');
  await u.tap('menu_select_services');
  for (const id of ids) await u.tap(`svc:${id}`);
  await u.tap('svc_continue');
};
const submitCareer = async (u, ids, answers) => {
  await pickServices(u, ids);
  assert.ok(await u.completeQuestions(answers), 'reached confirmation');
  await u.tap('confirm_submit');
};

test('1. new user gets the approved welcome with three buttons', async () => {
  const u = h.user('919800000001', 'Ravi Kumar');
  await u.say('hello');
  assert.equal(u.last().kind, 'buttons');
  assert.deepEqual(u.last().spec.buttons.map((b) => b.title), ['Build My Resume', 'Jobs & Career Growth', 'Services & Support']);
  assert.match(u.lastText(), /Hi Ravi/);
  assert.equal(await Contact.countDocuments({ normalizedWhatsappNumber: '919800000001' }), 1);
});

test('2. returning user is recognised and keeps one contact', async () => {
  const u = h.user('919800000002');
  await submitCareer(u, ['linkedin_optimization'], {});
  const before = await Conversation.countDocuments({ whatsappNumber: u.number });
  await Conversation.updateMany({ whatsappNumber: u.number }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  await h.engine.expireStale();
  await u.say('hi again');
  assert.match(u.allText(), /Welcome back/);
  assert.equal(await Contact.countDocuments({ normalizedWhatsappNumber: u.number }), 1);
  assert.ok((await Conversation.countDocuments({ whatsappNumber: u.number })) >= before);
});

test('3. single service selection creates a lead with that one service ID', async () => {
  const u = h.user('919800000003');
  await submitCareer(u, ['interview_preparation']);
  const lead = await Lead.findOne({ conversationId: (await u.conv()).conversationId }).lean();
  assert.deepEqual(lead.selectedServices, ['interview_preparation']);
});

test('4. selecting then unselecting toggles; ticks are shown', async () => {
  const u = h.user('919800000004');
  await u.say('menu'); await u.tap('menu_select_services');
  await u.tap('svc:ai_resume_builder'); await u.tap('svc:ai_resume_builder');
  assert.ok(u.last().spec.sections[0].rows.every((r) => r.title.startsWith('☐')));
  assert.deepEqual((await u.conv()).selectedServices, []);
});

test('5. empty selection is refused and the selector is shown again', async () => {
  const u = h.user('919800000005');
  await u.say('menu'); await u.tap('menu_select_services'); await u.tap('svc_continue');
  assert.match(u.allText(), /at least one service/);
  assert.equal(u.last().kind, 'list');
  assert.equal((await u.conv()).currentState, 'SERVICE_SELECTION');
});

test('6. resume flow: segment, role, experience, next step captured; only live URL is shared', async () => {
  const u = h.user('919800000006');
  await submitCareer(u, ['ai_resume_builder'], { targetRole: 'Data Analyst' });
  const lead = await Lead.findOne({ contactId: (await Contact.findOne({ normalizedWhatsappNumber: u.number })).contactId }).lean();
  assert.equal(lead.targetRole, 'Data Analyst');
  assert.ok(lead.details.resumeSegment);
  assert.ok(!/https?:\/\//.test(u.allText().replace(/linkedin\.com/g, '')), 'no invented URLs when the service is not live');
});

test('6b. resume flow shares the URL only after DutyLaunch configures it and marks it live', async () => {
  await updateService('ai_resume_builder', { live: true, url: 'https://example.com/resume-builder' });
  const u = h.user('919800000016');
  await submitCareer(u, ['ai_resume_builder']);
  assert.match(u.allText(), /https:\/\/example\.com\/resume-builder/);
  await updateService('ai_resume_builder', { live: false, url: null });
});

test('7. LinkedIn flow never asks for credentials and rejects non-LinkedIn URLs', async () => {
  const u = h.user('919800000007');
  await pickServices(u, ['linkedin_optimization']);
  assert.ok(await u.completeQuestions({}, { stopAt: 'linkedinProfileUrl' }));
  assert.ok(u.lastText().toLowerCase().includes('never share your linkedin password'));
  await u.say('https://evil.example.com/me');
  const c = await u.conv();
  assert.ok(!c.answers.linkedinProfileUrl, 'non-LinkedIn URL must not be stored');
  assert.match(u.lastText(), /linkedin/i);
  await u.say('https://www.linkedin.com/in/asha-rao');
  assert.match(JSON.stringify((await u.conv()).answers), /linkedin\.com\/in\/asha-rao/);
});

test('8. cover letter flow captures company and job-description availability', async () => {
  const u = h.user('919800000008');
  await submitCareer(u, ['cover_letter_generator'], { companyName: 'Acme' });
  const lead = await Lead.findOne({ selectedServices: 'cover_letter_generator' }).lean();
  assert.equal(lead.details.companyName, 'Acme');
  assert.ok(lead.details.jobDescriptionAvailable);
});

test('9. interview flow: date is optional (skip works)', async () => {
  const u = h.user('919800000009');
  await submitCareer(u, ['interview_preparation']);
  const lead = await Lead.findOne({ selectedServices: 'interview_preparation' }).lean();
  assert.ok(lead.details.interviewRound);
  assert.ok(lead.details.interviewDate === undefined || lead.details.interviewDate === null);
});

test('10. jobs flow: no guarantees are made in any message', async () => {
  const u = h.user('919800000010');
  await submitCareer(u, ['jobs_career_guidance']);
  const lead = await Lead.findOne({ selectedServices: 'jobs_career_guidance' }).lean();
  assert.equal(lead.preferredLocation, 'Bengaluru');
  assert.ok(!/guarantee(d)? (a )?(job|placement|interview)/i.test(u.allText()));
});

test('11. pricing: unapproved pricing is never invented; approved pricing is shown from configuration', async () => {
  const u = h.user('919800000011');
  await u.say('menu'); await u.tap('menu_pricing');
  await u.tap('price_ai_resume_builder');
  assert.match(u.allText(), /isn't published in this chat yet/);
  assert.ok(!/(₹|Rs\.?|INR|\$)\s?\d/.test(u.allText()));
  await updateService('ai_resume_builder', { pricing: { approved: true, amount: 499, currency: 'INR', taxes: 'incl. GST', inclusions: ['1 resume'], checkoutUrl: 'https://example.com/checkout', terms: 'See website' } });
  await u.say('menu'); await u.tap('menu_pricing'); await u.tap('price_ai_resume_builder');
  assert.match(u.allText(), /INR 499/);
  assert.match(u.allText(), /https:\/\/example\.com\/checkout/);
  await updateService('ai_resume_builder', { pricing: { approved: false, amount: null, checkoutUrl: null } });
});

test('12. existing order: ticket created, status verified server-side (phone must match)', async () => {
  const { Order } = await import('../../src/models/index.js');
  await Order.create({ orderId: 'ORD-1001', customerPhone: '919800000012', paymentStatus: 'paid', status: 'created', serviceId: 'ai_resume_builder' });
  const u = h.user('919800000012');
  await u.say('menu'); await u.tap('menu_order'); await u.tap('order_issue:payment_success_not_activated');
  assert.ok(await u.completeQuestions({ orderId: 'ORD-1001' }));
  await u.confirm();
  const t = await SupportTicket.findOne({ orderId: 'ORD-1001' }).lean();
  assert.ok(t);
  assert.equal(t.category, 'order_payment');
  assert.match(u.allText(), new RegExp(t.ticketId));
});

test('12b. order belonging to another number is never disclosed', async () => {
  const { Order } = await import('../../src/models/index.js');
  await Order.create({ orderId: 'ORD-SECRET', customerPhone: '919811111111', paymentStatus: 'paid' });
  const u = h.user('919800000112');
  await u.say('menu'); await u.tap('menu_order'); await u.tap('order_issue:payment_failed_pending');
  await u.completeQuestions({ orderId: 'ORD-SECRET' });
  assert.ok(!/ORD-SECRET.{0,80}paid/i.test(u.allText()));
});

test('13. payment issue routes to the finance/support queue', async () => {
  const u = h.user('919800000013');
  await u.say('menu'); await u.tap('menu_order'); await u.tap('order_issue:payment_failed_pending');
  await u.completeQuestions({ orderId: 'ORD-NOPE' }); await u.confirm();
  const t = await SupportTicket.findOne({ contactId: (await Contact.findOne({ normalizedWhatsappNumber: u.number })).contactId }).lean();
  assert.equal(t.category, 'order_payment');
  assert.ok(t.assignedQueue);
});

test('14. refund request creates a payment_refund ticket and never asks for card data', async () => {
  const u = h.user('919800000014');
  await u.say('menu'); await u.tap('menu_order'); await u.tap('order_issue:refund_request');
  await u.completeQuestions({}); await u.confirm();
  assert.match(u.allText(), /don't share passwords, OTPs, PINs/i);
  assert.ok(!/(enter|send|share|provide) (your|the) (otp|cvv|pin|card number)/i.test(u.allText().replace(/please don't share[^.]*\./gi, '')));
  const t = await SupportTicket.findOne({ category: 'payment_refund', contactId: (await Contact.findOne({ normalizedWhatsappNumber: u.number })).contactId }).lean();
  assert.ok(t);
});

test('14b. sensitive data typed into a free-text answer is rejected, not stored', async () => {
  const u = h.user('919800000114');
  await u.say('menu'); await u.tap('menu_order'); await u.tap('order_issue:other_issue');
  await u.say('ORD-5'); await u.say('asha@example.com');
  await u.say('my OTP is 482913 and card 4111 1111 1111 1111');
  const c = await u.conv();
  assert.ok(!JSON.stringify(c.answers).includes('4111'));
  assert.ok(!JSON.stringify(c.answers).includes('482913'));
});

test('15. human handoff: ticket, queue, bot paused, resumes after release', async () => {
  const u = h.user('919800000015');
  await u.say('hello');
  await u.say('human');
  await u.tap('ho:payment_refund');
  const c = await u.conv();
  assert.equal(c.status, 'human_handoff');
  const t = await SupportTicket.findOne({ conversationId: c.conversationId }).lean();
  assert.ok(t && t.assignedQueue);
  const sentBefore = u.out().length;
  await u.say('are you there?');
  await u.say('hello??');
  assert.equal(u.out().length, sentBefore, 'bot must stay silent while a human has the chat');
  const res = await fetch(`${h.base}/handoff/${t.ticketId}/release`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'internal_test_key' }, body: '{}' });
  assert.equal(res.status, 200);
  assert.ok(u.out().length > sentBefore, 'user told the bot is back');
  await u.say('menu');
  assert.equal((await u.conv()).status, 'active');
});

test('15b. STOP is honoured even during a human handoff', async () => {
  const u = h.user('919800000115');
  await u.say('hello'); await u.say('human'); await u.tap('ho:other');
  await u.say('STOP');
  const contact = await Contact.findOne({ normalizedWhatsappNumber: u.number }).lean();
  assert.ok(contact.optOutTimestamp);
});

test('16. BACK returns to the previous question and keeps earlier answers', async () => {
  const u = h.user('919800000017');
  await pickServices(u, ['ai_resume_builder']);
  await u.tap(u.rowIds().find((x) => x.startsWith('q:')));
  await u.say('Product Manager');
  const answered = (await u.conv()).answers;
  await u.say('back');
  const c = await u.conv();
  assert.equal(c.answers.resumeSegment, answered.resumeSegment);
  assert.equal(c.currentState, 'SERVICE_DETAILS');
});

test('16b. BACK at the main menu never corrupts the session', async () => {
  const u = h.user('919800000018');
  await u.say('hi'); await u.say('back'); await u.say('back');
  assert.ok(['MAIN_MENU', 'WELCOME'].includes((await u.conv()).currentState));
  assert.ok(u.out().length >= 2);
});

test('17. MENU returns to the menu without deleting contact or lead', async () => {
  const u = h.user('919800000019');
  await submitCareer(u, ['linkedin_optimization']);
  const leads = await Lead.countDocuments({});
  await u.say('MENU');
  assert.equal((await u.conv()).currentState, 'MAIN_MENU');
  assert.equal(await Lead.countDocuments({}), leads);
  assert.equal(await Contact.countDocuments({ normalizedWhatsappNumber: u.number }), 1);
});

test('18. START OVER clears selections, keeps contact and history, creates a fresh conversation', async () => {
  const u = h.user('919800000020');
  await u.say('menu'); await u.tap('menu_select_services'); await u.tap('svc:ai_resume_builder');
  const first = await u.conv();
  await u.say('start over');
  assert.match(u.lastText() || u.allText(), /Start over|start/i);
  await u.tap('confirm_start_over');
  const now = await u.conv();
  assert.notEqual(now.conversationId, first.conversationId);
  assert.deepEqual(now.selectedServices, []);
  const old = await Conversation.findOne({ conversationId: first.conversationId }).lean();
  assert.ok(['abandoned', 'completed'].includes(old.status));
  assert.equal(await Contact.countDocuments({ normalizedWhatsappNumber: u.number }), 1);
});

test('19. STOP records opt-out, confirms, and suppresses marketing sends', async () => {
  const u = h.user('919800000021');
  await u.say('hello'); await u.say('STOP');
  assert.match(u.lastText(), /unsubscribed/i);
  const c = await Contact.findOne({ normalizedWhatsappNumber: u.number }).lean();
  assert.ok(c.optOutTimestamp);
  assert.equal(c.marketingOptIn, false);
  assert.ok(await Consent.findOne({ contactId: c.contactId, action: 'opt_out' }));
  const r = await fetch(`${h.base}/messages/send`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'internal_test_key' }, body: JSON.stringify({ whatsappNumber: u.number, type: 'text', text: 'Big sale', purpose: 'marketing' }) });
  assert.equal(r.status, 422);
  assert.ok(await AnalyticsEvent.findOne({ type: 'opt_out', contactId: c.contactId }));
});

test('fallback: unexpected text re-shows options; repeated invalid input offers a human', async () => {
  const u = h.user('919800000022');
  await u.say('hello'); await u.tap('welcome_other');
  await u.say('blah'); assert.ok(u.last().kind === 'list' || u.last().kind === 'buttons');
  await u.say('blah2'); await u.say('blah3'); await u.say('blah4');
  assert.ok(u.rowIds().includes('cmd_human'));
  assert.ok(await AnalyticsEvent.findOne({ type: 'fallback' }));
});

test('partnership enquiry creates exactly one partnership lead', async () => {
  const u = h.user('919800000023');
  await u.say('menu'); await u.tap('menu_partnership'); await u.tap('pt:company_hiring');
  assert.ok(await u.completeQuestions()); await u.confirm();
  const leads = await Lead.find({ intent: 'partnership' }).lean();
  assert.equal(leads.length, 1);
  assert.equal(leads[0].customerType, 'employer');
});
