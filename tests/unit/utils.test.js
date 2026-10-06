import '../env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, maskNumber, hashNumber } from '../../src/utils/phone.js';
import { cleanText, isEmail, normalizeUrl, isLinkedInUrl, containsSensitive } from '../../src/utils/sanitize.js';
import { parseCommand } from '../../src/services/conversation/commands.js';
import { canSend, inWindow } from '../../src/services/messaging/policy.js';
import { KeyedQueue } from '../../src/utils/keyedQueue.js';
import { SERVICE_CATALOG, CAREER_TOOL_IDS, MULTI_SELECTABLE_CATEGORIES } from '../../src/config/services.js';
import { queueFor } from '../../src/config/queues.js';

test('phone normalisation', () => {
  assert.equal(normalizePhone('+91 98765-43210'), '919876543210');
  assert.equal(normalizePhone('9876543210'), '919876543210');
  assert.equal(normalizePhone('00447911123456'), '447911123456');
  assert.equal(normalizePhone('abc'), null);
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone('123'), null);
  assert.equal(maskNumber('919876543210'), '********3210');
  assert.notEqual(hashNumber('919876543210'), '919876543210');
});

test('sanitisation and validation', () => {
  assert.equal(cleanText('  hi\u0000 there  ', 50), 'hi there');
  assert.equal(cleanText('x'.repeat(50), 10).length, 10);
  assert.ok(isEmail('a@b.co')); assert.ok(!isEmail('a@b')); assert.ok(!isEmail('no spaces@x.com'));
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
  assert.match(normalizeUrl('example.com/x'), /^https:\/\/example\.com/);
  assert.ok(isLinkedInUrl('https://www.linkedin.com/in/x'));
  assert.ok(!isLinkedInUrl('https://linkedin.com.evil.io/in/x'));
});

test('sensitive-data detection (OTP / PIN / CVV / password / card)', () => {
  assert.ok(containsSensitive('my otp is 123456'));
  assert.ok(containsSensitive('CVV 123'));
  assert.ok(containsSensitive('password: hunter2'));
  assert.ok(containsSensitive('card 4111 1111 1111 1111'));
  assert.ok(!containsSensitive('I paid on 12 March for order 123456'));
  assert.ok(!containsSensitive('Software Engineer in Bengaluru'));
});

test('typed commands are whole-message only; button ids map to commands', () => {
  const t = (text) => parseCommand({ type: 'text', text });
  assert.equal(t('menu'), 'MENU'); assert.equal(t('  Back '), 'BACK'); assert.equal(t('SUPPORT'), 'SUPPORT');
  assert.equal(t('human'), 'HUMAN'); assert.equal(t('stop'), 'STOP'); assert.equal(t('Start Over'), 'START_OVER');
  assert.equal(t('please go back to the menu'), null);
  assert.equal(t('my role is back end developer'), null);
  assert.equal(parseCommand({ type: 'button', replyId: 'cmd_back' }), 'BACK');
  assert.equal(parseCommand({ type: 'list', replyId: 'cmd_human' }), 'HUMAN');
  assert.equal(parseCommand({ type: 'list', replyId: 'svc:ai_resume_builder' }), null);
});

test('WhatsApp policy gate: 24h window, templates, marketing consent', () => {
  const now = new Date('2026-10-01T10:00:00Z');
  const fresh = { lastInboundAt: new Date('2026-10-01T09:00:00Z') };
  const stale = { lastInboundAt: new Date('2026-09-29T09:00:00Z') };
  assert.ok(inWindow(fresh, now)); assert.ok(!inWindow(stale, now)); assert.ok(!inWindow({}, now));
  assert.ok(canSend({ contact: fresh, kind: 'freeform', now }).allowed);
  assert.equal(canSend({ contact: stale, kind: 'freeform', now }).reason, 'outside_customer_service_window');
  assert.ok(canSend({ contact: stale, kind: 'template', now }).allowed);
  assert.equal(canSend({ contact: fresh, kind: 'template', purpose: 'marketing', now }).reason, 'no_marketing_consent');
  const optedIn = { ...fresh, marketingOptIn: true, consentTimestamp: new Date('2026-09-30T00:00:00Z') };
  assert.ok(canSend({ contact: optedIn, kind: 'template', purpose: 'marketing', now }).allowed);
  const optedOut = { ...optedIn, optOutTimestamp: new Date('2026-10-01T09:30:00Z') };
  assert.equal(canSend({ contact: optedOut, kind: 'template', purpose: 'marketing', now }).reason, 'opted_out');
  assert.equal(canSend({ contact: null, kind: 'template' }).allowed, false);
});

test('KeyedQueue serialises per key but runs different keys in parallel', async () => {
  const q = new KeyedQueue(); const order = [];
  const slow = (k, n, ms) => q.run(k, async () => { order.push(`${k}${n}:start`); await new Promise((r) => setTimeout(r, ms)); order.push(`${k}${n}:end`); });
  await Promise.all([slow('a', 1, 30), slow('a', 2, 1), slow('b', 1, 5)]);
  assert.ok(order.indexOf('a1:end') < order.indexOf('a2:start'));
  assert.ok(order.indexOf('b1:start') < order.indexOf('a1:end'));
});

test('service catalogue: 9 approved services, stable IDs, only career tools multi-selectable, nothing invented', () => {
  assert.equal(SERVICE_CATALOG.length, 9);
  assert.deepEqual(CAREER_TOOL_IDS, ['ai_resume_builder', 'linkedin_optimization', 'cover_letter_generator', 'interview_preparation', 'jobs_career_guidance']);
  assert.equal(MULTI_SELECTABLE_CATEGORIES.length, 1);
  for (const s of SERVICE_CATALOG) {
    assert.match(s.id, /^[a-z_]+$/);
    assert.equal(s.url, null, `${s.id} must not ship with an invented URL`);
    assert.ok(!s.pricing?.approved, `${s.id} must not ship with approved pricing`);
    assert.ok(s.pricing?.amount == null);
  }
});

test('ticket routing maps categories to queues', () => {
  for (const c of ['order_payment', 'payment_refund', 'account_technical', 'career_services', 'business_partnership', 'other', 'complaint']) {
    assert.ok(queueFor(c).queue, c);
  }
  assert.ok(queueFor('totally_unknown').queue);
});
