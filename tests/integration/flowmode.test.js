import '../env.js';
process.env.MSG91_SERVICE_FLOW_ID = 'FLOW_TEST_123';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from '../helpers.js';
import { Conversation, Lead } from '../../src/models/index.js';

let h;
before(async () => { h = await startHarness(); });
after(async () => { await h.stop(); });

const openSelector = async (u) => { await u.say('menu'); await u.tap('menu_select_services'); };

test('flow mode: the selector is a WhatsApp Flow with stable IDs and a CheckboxGroup data source', async () => {
  const u = h.user('919600000001');
  await openSelector(u);
  const m = u.last();
  assert.equal(m.kind, 'flow');
  assert.equal(m.spec.flowId, 'FLOW_TEST_123');
  assert.equal(m.spec.header, 'What can we help you with?');
  assert.equal(m.spec.body, "Select all the services you're interested in.");
  assert.deepEqual(m.spec.data.services.map((s) => s.id), ['ai_resume_builder', 'linkedin_optimization', 'cover_letter_generator', 'interview_preparation', 'jobs_career_guidance']);
  assert.ok(!m.spec.data.services.some((s) => ['plans_pricing', 'existing_order_payment', 'human_support', 'partnership'].includes(s.id)), 'transactional intents are not in the multi-select');
});

test('flow mode: one Flow submission with 3 services => one conversation, one lead, IDs stored', async () => {
  const u = h.user('919600000002');
  await openSelector(u);
  const token = (await u.conv()).pendingFlowToken;
  assert.ok(token);
  await u.flow({ flow_token: token, services: ['ai_resume_builder', 'linkedin_optimization', 'cover_letter_generator'] });
  assert.ok(await u.completeQuestions());
  await u.tap('confirm_submit');
  assert.equal(await Conversation.countDocuments({ whatsappNumber: u.number }), 1);
  const leads = await Lead.find({ conversationId: (await u.conv()).conversationId }).lean();
  assert.equal(leads.length, 1);
  assert.deepEqual(leads[0].selectedServices, ['ai_resume_builder', 'linkedin_optimization', 'cover_letter_generator']);
});

test('flow mode: empty selection re-shows the Flow; unknown/forged IDs are dropped', async () => {
  const u = h.user('919600000003');
  await openSelector(u);
  let token = (await u.conv()).pendingFlowToken;
  await u.flow({ flow_token: token, services: [] });
  assert.match(u.allText(), /at least one service/);
  assert.equal(u.last().kind, 'flow');
  token = (await u.conv()).pendingFlowToken;
  await u.flow({ flow_token: token, services: ['human_support', 'drop_table', 'linkedin_optimization'] });
  assert.deepEqual((await u.conv()).selectedServices, ['linkedin_optimization']);
});

test('flow mode: stale or forged flow_token is rejected and a fresh Flow is sent', async () => {
  const u = h.user('919600000004');
  await openSelector(u);
  await u.flow({ flow_token: 'forged-token', services: ['ai_resume_builder'] });
  assert.match(u.allText(), /expired/);
  assert.equal(u.last().kind, 'flow');
  assert.deepEqual((await u.conv()).selectedServices, []);
});

test('flow mode: malformed Flow response does not crash the conversation', async () => {
  const u = h.user('919600000005');
  await openSelector(u);
  await u.raw({ type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: { response_json: '{broken' } } });
  assert.ok(u.last());
  assert.equal((await u.conv()).status, 'active');
});

test('flow mode: if MSG91 rejects the Flow, the user automatically gets the native list multi-select (no typing)', async () => {
  const u = h.user('919600000006');
  h.wa.flowRejected = true;
  await openSelector(u);
  h.wa.flowRejected = false;
  assert.equal(u.last().kind, 'list');
  assert.ok(u.rowIds().includes('svc:ai_resume_builder'));
  assert.ok(u.rowIds().includes('svc_continue'));
  assert.equal((await u.conv()).multiselectMode, 'list_loop');
  await u.tap('svc:ai_resume_builder'); await u.tap('svc:interview_preparation'); await u.tap('svc_continue');
  assert.deepEqual((await u.conv()).selectedServices, ['ai_resume_builder', 'interview_preparation']);
});
