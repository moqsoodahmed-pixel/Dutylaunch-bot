import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from '../helpers.js';
import { Conversation, Lead, Contact } from '../../src/models/index.js';

let h;
before(async () => { h = await startHarness(); });
after(async () => { await h.stop(); });

test('multi-select (native list toggles): Resume + LinkedIn + Cover Letter => ONE conversation, ONE lead', async () => {
  const u = h.user('919876500001');
  await u.say('hi');
  assert.match(u.lastText(), /DutyLaunch/);
  await u.tap('welcome_other');
  assert.ok(u.rowIds().includes('menu_select_services'));
  await u.tap('menu_select_services');
  assert.equal(u.last().kind, 'list');
  assert.ok(u.rowIds().includes('svc:ai_resume_builder'));

  for (const id of ['ai_resume_builder', 'linkedin_optimization', 'cover_letter_generator']) await u.tap(`svc:${id}`);
  const titles = u.last().spec.sections[0].rows.map((r) => r.title);
  assert.ok(titles[0].startsWith('☑') && titles[1].startsWith('☑') && titles[2].startsWith('☑') && titles[3].startsWith('☐'));
  await u.tap('svc_continue');

  assert.ok(await u.completeQuestions());
  await u.tap('confirm_submit');

  assert.equal(await Conversation.countDocuments({ whatsappNumber: u.number }), 1);
  const leads = await Lead.find({}).lean();
  assert.equal(leads.length, 1);
  assert.deepEqual(leads[0].selectedServices, ['ai_resume_builder', 'linkedin_optimization', 'cover_letter_generator']);
  assert.deepEqual(leads[0].serviceInterest, leads[0].selectedServices);
  assert.equal(leads[0].targetRole, 'Software Engineer');
  assert.equal(await Contact.countDocuments({}), 1);
  // "target role" asked exactly once across three services
  const asked = u.out().filter((m) => /job role are you targeting/.test(m.spec.body || '')).length;
  assert.equal(asked, 1);
});
