import '../env.js';
process.env.TEMPLATE_ENQUIRY_FOLLOWUP = 'enquiry_followup';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from '../helpers.js';
import { runFollowUps } from '../../src/jobs/followUp.js';
import { Lead, Contact, Order } from '../../src/models/index.js';

let h;
before(async () => { h = await startHarness(); });
after(async () => { delete process.env.FOLLOWUP_DELAY_HOURS; await h.stop(); });

const mkLead = async (number, { optIn = false, optOut = false } = {}) => {
  const u = h.user(number);
  await u.say('menu'); await u.tap('menu_select_services'); await u.tap('svc:ai_resume_builder'); await u.tap('svc_continue');
  await u.completeQuestions({ /* marketingConsent defaults to first option = yes */ });
  await u.confirm();
  const contact = await Contact.findOne({ normalizedWhatsappNumber: number });
  if (optIn !== undefined) await Contact.updateOne({ _id: contact._id }, { $set: { marketingOptIn: optIn, consentTimestamp: optIn ? new Date() : undefined, ...(optOut ? { optOutTimestamp: new Date() } : {}) } });
  await Lead.collection.updateMany({ contactId: contact.contactId }, { $set: { createdAt: new Date(Date.now() - 48 * 3600000) } });   // createdAt is immutable in Mongoose
  return contact;
};
const run = () => runFollowUps({ messenger: h.container.messenger, analytics: h.container.analytics });

test('follow-up is disabled unless a cadence is configured (nothing invented)', async () => {
  const c = await mkLead('919500000001', { optIn: true });
  delete process.env.FOLLOWUP_DELAY_HOURS;
  assert.equal((await run()).disabled, true);
  assert.equal(h.wa.sent.filter((m) => m.kind === 'template').length, 0);
  await Lead.updateMany({ contactId: c.contactId }, { $set: { followUpState: 'skipped' } });   // keep this lead out of the next test
});

test('follow-up: one template to opted-in contacts only; skipped for no-consent, opted-out and paid; never repeated', async () => {
  const yes = await mkLead('919500000002', { optIn: true });
  const no = await mkLead('919500000003', { optIn: false });
  const out = await mkLead('919500000004', { optIn: true, optOut: true });
  const paid = await mkLead('919500000005', { optIn: true });
  await Order.create({ orderId: 'ORD-FU', customerPhone: paid.normalizedWhatsappNumber, paymentStatus: 'paid' });
  process.env.FOLLOWUP_DELAY_HOURS = '24';
  const before = h.wa.sent.filter((m) => m.kind === 'template').length;
  const r = await run();
  const templates = h.wa.sent.filter((m) => m.kind === 'template').slice(before);
  assert.equal(r.sent, 1);
  assert.equal(templates.length, 1);
  assert.equal(templates[0].to, yes.normalizedWhatsappNumber);
  assert.equal(templates[0].spec.name, 'enquiry_followup');
  assert.deepEqual(templates[0].spec.variables, ['Asha', 'AI Resume Builder']);
  const reasons = Object.fromEntries((await Lead.find({ contactId: { $in: [no.contactId, out.contactId, paid.contactId] } }).lean()).map((l) => [l.contactId, l.followUpReason]));
  assert.equal(reasons[no.contactId], 'no_marketing_consent');
  assert.equal(reasons[out.contactId], 'no_marketing_consent');
  assert.equal(reasons[paid.contactId], 'already_paid');
  const again = await run();
  assert.equal(again.sent, 0, 'a lead is followed up at most once');
});
