import './env.js';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { createApp } from '../src/app.js';
import { buildContainer } from '../src/container.js';
import { seedServices } from '../src/services/catalog/catalog.service.js';
import { QUESTIONS } from '../src/services/conversation/questions.js';
import { Conversation } from '../src/models/index.js';
import '../src/models/index.js';
import { Msg91Error } from '../src/services/msg91/msg91.client.js';

export const HEADERS = { 'content-type': 'application/json', 'x-webhook-secret': 'whsec_test' };
export const API = { 'content-type': 'application/json', 'x-api-key': 'internal_test_key' };
export const sign = (secret, raw) => crypto.createHmac('sha256', secret).update(raw).digest('hex');

/** Records every outbound message; can be told to fail. */
export function fakeWhatsApp() {
  const wa = { sent: [], failNext: 0, failAlways: false, flowRejected: false, seq: 0 };
  const rec = (kind) => async (to, spec) => {
    if (wa.failAlways || wa.failNext > 0) {
      if (wa.failNext > 0) wa.failNext -= 1;
      throw new Msg91Error('provider down', { category: 'provider_unavailable', status: 503, retryable: true });
    }
    if (kind === 'flow' && wa.flowRejected) throw new Msg91Error('flow not supported', { category: 'invalid_request', status: 400 });
    wa.seq += 1;
    wa.sent.push({ to: String(to), kind, spec });
    return { providerMessageId: `wamid.out.${wa.seq}` };
  };
  Object.assign(wa, {
    sendText: async (to, body) => rec('text')(to, { kind: 'text', body }),
    sendInteractiveButtons: rec('buttons'),
    sendInteractiveList: rec('list'),
    sendFlow: rec('flow'),
    sendTemplate: rec('template'),
    getTemplates: async () => ({})
  });
  return wa;
}

let dbCounter = 0;
export async function startHarness() {
  const dbName = `dl_test_${process.pid}_${Date.now()}_${dbCounter++}`;
  await mongoose.connect(`mongodb://127.0.0.1:27017/${dbName}`, { serverSelectionTimeoutMS: 5000 });
  // FerretDB does not implement TTL indexes (real MongoDB does). Strip them for the test DB only; every
  // other index, including all unique indexes the idempotency logic depends on, is created for real.
  for (const m of Object.values(mongoose.models)) {
    m.schema._indexes = m.schema._indexes.filter(([, opts]) => !(opts && opts.expireAfterSeconds !== undefined));
  }
  await mongoose.syncIndexes();
  await seedServices();
  const wa = fakeWhatsApp();
  const container = buildContainer({ whatsapp: wa });
  const { app, webhook } = createApp({ container });
  const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let n = 0;

  const post = (path, body, headers = HEADERS, raw) => fetch(base + path, { method: 'POST', headers, body: raw ?? JSON.stringify(body) });
  const metaMessage = (from, message, name = 'Asha Rao') => ({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name } }], messages: [{ from, timestamp: String(Math.floor(Date.now() / 1000)), ...message }] } }] }]
  });

  function user(number, name) {
    const send = async (message, id = `wamid.in.${++n}.${crypto.randomBytes(3).toString('hex')}`) => {
      const res = await post('/webhooks/whatsapp', metaMessage(number, { id, ...message }, name));
      await webhook.drain();
      return { res, id };
    };
    const u = {
      number,
      say: (body) => send({ type: 'text', text: { body } }),
      tap: (id, title = id) => send({ type: 'interactive', interactive: { type: id.startsWith('menu_') || id.startsWith('svc') || id.startsWith('q:') || id.startsWith('cmd_') ? 'list_reply' : 'button_reply', list_reply: { id, title }, button_reply: { id, title } } }),
      flow: (payload) => send({ type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', response_json: JSON.stringify(payload) } } }),
      raw: send,
      out: () => wa.sent.filter((m) => m.to === number),
      last: () => wa.sent.filter((m) => m.to === number).at(-1),
      lastText: () => { const l = wa.sent.filter((m) => m.to === number).at(-1); return l ? (l.spec.body || '') : ''; },
      allText: () => wa.sent.filter((m) => m.to === number).map((m) => m.spec.body || '').join('\n'),
      conv: () => Conversation.findOne({ whatsappNumber: number }).sort({ createdAt: -1 }).lean(),
      rowIds: () => {
        const l = u.last();
        if (!l) return [];
        if (l.kind === 'list') return l.spec.sections.flatMap((s) => s.rows.map((r) => r.id));
        if (l.kind === 'buttons') return l.spec.buttons.map((b) => b.id);
        return [];
      }
    };
    /** Drives the question flow to the confirmation screen using plausible answers; returns when submitted. */
    u.completeQuestions = async (answers = {}, { stopAt } = {}) => {
      for (let i = 0; i < 40; i += 1) {
        const l = u.last();
        const ids = u.rowIds();
        if (ids.includes('confirm_submit')) return true;
        if (!ids.some((x) => x.startsWith('q:')) && stopAt && QUESTIONS[stopAt]?.prompt === l?.spec?.body) return true;
        if (/What would you like to do next\?/.test(l?.spec?.body || '')) return true;   // order / partnership flows submit directly
        const opt = ids.find((x) => x.startsWith('q:'));
        if (opt) { await u.tap(opt); continue; }
        const qid = Object.keys(QUESTIONS).find((k) => QUESTIONS[k].prompt === l?.spec?.body);
        if (!qid) return false;
        if (answers[qid] !== undefined) await u.say(answers[qid]);
        else if (ids.includes('skip')) await u.tap('skip');
        else await u.say(DEFAULT_TEXT[qid] || 'Sample answer');
      }
      return false;
    };
    u.confirm = async () => { if (u.rowIds().includes('confirm_submit')) await u.tap('confirm_submit'); };
    return u;
  }

  async function stop() {
    await webhook.drain();
    await new Promise((r) => server.close(r));
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect();
  }
  return { app, container, wa, webhook, base, post, user, stop, metaMessage, engine: container.engine };
}

const DEFAULT_TEXT = {
  targetRole: 'Software Engineer', preferredLocation: 'Bengaluru', contactName: 'Asha Rao', email: 'asha@example.com',
  orderId: 'ORD-1001', orderContact: 'asha@example.com', orderDescription: 'Paid yesterday but the tool is still locked',
  orgName: 'Acme Corp', workEmail: 'hr@acme-corp.com', requirement: 'We want to hire about twenty freshers a year'
};
