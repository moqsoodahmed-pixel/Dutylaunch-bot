import { Conversation, MessageLog, SupportTicket, Contact } from '../../models/index.js';
import { getEnv } from '../../config/env.js';
import { queueFor } from '../../config/queues.js';
import * as catalog from '../catalog/catalog.service.js';
import * as contactsSvc from '../contacts/contacts.service.js';
import * as leadsSvc from '../leads/leads.service.js';
import * as ordersSvc from '../orders/orders.service.js';
import { KeyedQueue } from '../../utils/keyedQueue.js';
import { newId, shortCode } from '../../utils/ids.js';
import { containsSensitive } from '../../utils/sanitize.js';
import { hashNumber, maskNumber } from '../../utils/phone.js';
import { logger as defaultLogger } from '../../utils/logger.js';
import { S, QUESTION_STATES, NON_RETURNABLE } from './states.js';
import { parseCommand } from './commands.js';
import {
  text, buttons, list, NAV, navSection, welcomeText, welcomeBackText, welcomeSpec, mainMenuSpec, INTROS, PRICING_INTRO,
  ORDER_INTRO, PARTNERSHIP_INTRO, HANDOFF_INTRO, SECURITY_NOTE, ORDER_ISSUES, PARTNERSHIP_TYPES, HANDOFF_CATEGORIES,
  PRICING_OPTIONS, ticketAckText, formatPricing, MENU_SERVICE_ROWS
} from './prompts.js';
import {
  QUESTIONS, buildCareerQueue, buildOrderQueue, buildPartnershipQueue, seek, renderQuestion, optionTitle, optionReplyId
} from './questions.js';

const PHASE_STATE = { service: S.SERVICE_DETAILS, contact: S.CONTACT_DETAILS, order: S.ORDER_DETAILS, partnership: S.PARTNERSHIP_DETAILS };
const CATEGORY_LABEL = {
  order_payment: 'Order / payment', payment_refund: 'Payment / refund', account_technical: 'Account / technical',
  career_services: 'Career services', business_partnership: 'Business partnership', other: 'Other', complaint: 'Complaint'
};
const SUMMARY_KEYS = ['resumeSegment', 'targetRole', 'experienceLevel', 'targetIndustry', 'hasExistingResume', 'resumeNextStep', 'linkedinFocus', 'linkedinProfileUrl', 'coverLetterType', 'companyName', 'jobDescriptionAvailable', 'hasResume', 'interviewRound', 'interviewDate', 'interviewTopics', 'jobsRoute', 'preferredLocation', 'skills', 'employmentType', 'contactName', 'email', 'marketingConsent'];
const TOP_LEVEL_LEAD_KEYS = new Set(['targetRole', 'experienceLevel', 'preferredLocation', 'contactName', 'email', 'marketingConsent']);

const firstName = (c) => String(c.name || c.profileName || '').trim().split(/\s+/)[0] || '';

/**
 * Deterministic conversation engine (state machine). No AI is involved here by design:
 * every reply is either approved copy or data from configuration / the backend.
 */
export function createEngine({ messenger, support, analytics, notifier, logger = defaultLogger }) {
  const lock = new KeyedQueue();

  // ------------------------------------------------------------------ public API
  const handleInbound = (msg) => lock.run(msg.from, () => processInbound(msg));

  // ------------------------------------------------------------------ core
  async function processInbound(msg) {
    const env = getEnv();
    const now = new Date();
    const { contact } = await contactsSvc.upsertFromInbound({ number: msg.from, profileName: msg.name, referral: msg.referral, now });
    const hadPrevious = Boolean(await Conversation.exists({ contactId: contact.contactId }));
    let conv = await loadActive(contact, now);
    const isNew = !conv;
    if (isNew) conv = newConversation(contact, env, now);

    const ctx = { conv, contact, msg, input: toInput(msg), out: [], now, env, returning: hadPrevious };
    const log = logger.child({ conversationId: conv.conversationId, number: maskNumber(contact.normalizedWhatsappNumber), eventId: msg.eventId, state: conv.currentState });
    ctx.log = log;
    await logInbound(ctx);

    const outcome = await dispatch(ctx, isNew);
    conv = ctx.conv; // dispatch may swap the conversation (start over)
    if (outcome === 'paused') {
      log.info({ action: 'bot_paused_human_handoff' }, 'inbound ignored: human handoff active');
      await Conversation.updateOne({ conversationId: conv.conversationId }, { $set: { lastMessageAt: now } });
      return { paused: true };
    }

    conv.lastMessageAt = now;
    conv.expiresAt = conv.status === 'human_handoff' && conv.handoff?.expiresAt ? conv.handoff.expiresAt : new Date(now.getTime() + env.sessionTtlHours * 3600000);
    await conv.save();
    if (isNew) await analytics.track('conversation_started', { contactId: contact.contactId, conversationId: ctx.conv.conversationId, meta: { returning: hadPrevious } });
    await sendAll(ctx);
    log.info({ action: 'inbound_processed', newState: conv.currentState, prompts: ctx.out.length }, 'processed');
    return { paused: false, state: conv.currentState };
  }

  async function dispatch(ctx, isNew) {
    const { conv } = ctx;
    const cmd = parseCommand(ctx.msg);

    if (conv.status === 'human_handoff') {
      const expired = conv.handoff?.expiresAt && new Date(conv.handoff.expiresAt) < ctx.now;
      if (cmd === 'STOP') return doStop(ctx);            // opt-out is always honoured, even during handoff
      if (!expired) return 'paused';
      const tid = conv.handoff?.ticketId;
      releaseLocal(conv);
      ctx.out.push(text(`Our team hasn't been able to reply here yet, so I'm back to help.${tid ? ` Your ticket ${tid} is still open.` : ''}`));
      return enter(ctx, S.MAIN_MENU, { push: false });
    }
    if (cmd === 'STOP') return doStop(ctx);
    if (conv.status === 'opted_out') {
      conv.status = 'active';
      if (!cmd) return enter(ctx, S.MAIN_MENU, { push: false });
    }
    if (isNew && !['MENU', 'SUPPORT', 'HUMAN'].includes(cmd)) return welcome(ctx);
    if (cmd) return runCommand(cmd, ctx);
    return runState(ctx);
  }

  async function runCommand(cmd, ctx) {
    ctx.conv.invalidCount = 0;
    switch (cmd) {
      case 'MENU': return doMenu(ctx);
      case 'BACK': return doBack(ctx);
      case 'SUPPORT': return enter(ctx, S.SUPPORT_MENU);
      case 'HUMAN': return enter(ctx, S.HANDOFF_CATEGORY);
      case 'START_OVER': return doStartOver(ctx, false);
      default: return fallback(ctx);
    }
  }

  async function runState(ctx) {
    const { conv, input } = ctx;
    const st = conv.currentState;
    if (QUESTION_STATES.has(st)) return handleQuestion(ctx);
    const id = input.kind === 'choice' ? input.id : null;

    switch (st) {
      case S.WELCOME:
        if (id === 'welcome_resume') { await track(ctx, 'menu_selection', { serviceId: 'ai_resume_builder', meta: { choice: 'welcome_resume' } }); return startCareer(ctx, ['ai_resume_builder']); }
        if (id === 'welcome_jobs') { await track(ctx, 'menu_selection', { serviceId: 'jobs_career_guidance', meta: { choice: 'welcome_jobs' } }); return startCareer(ctx, ['jobs_career_guidance']); }
        if (id === 'welcome_other') { await track(ctx, 'menu_selection', { meta: { choice: 'welcome_other' } }); return enter(ctx, S.MAIN_MENU); }
        return fallback(ctx);

      case S.MAIN_MENU: {
        // Spec section 4: each career service goes straight to its own flow
        const svcRow = MENU_SERVICE_ROWS.find((r) => r.id === id);
        if (svcRow) { await track(ctx, 'menu_selection', { serviceId: svcRow.serviceId, meta: { choice: 'main_menu' } }); return startCareer(ctx, [svcRow.serviceId]); }
        if (id === 'menu_select_services') { await track(ctx, 'menu_selection', { meta: { choice: 'select_services' } }); return enter(ctx, S.SERVICE_SELECTION); }
        if (id === 'menu_pricing') { await track(ctx, 'menu_selection', { serviceId: 'plans_pricing' }); return enter(ctx, S.PRICING_MENU); }
        if (id === 'menu_order') { await track(ctx, 'menu_selection', { serviceId: 'existing_order_payment' }); return enter(ctx, S.ORDER_ISSUE_TYPE); }
        if (id === 'menu_partnership') { await track(ctx, 'menu_selection', { serviceId: 'partnership' }); return enter(ctx, S.PARTNERSHIP_TYPE); }
        return fallback(ctx);
      }

      case S.SERVICE_SELECTION: return handleServiceSelection(ctx);

      case S.PRICING_MENU: return handlePricingMenu(ctx);

      case S.PRICING_RESULT:
        if (id === 'pricing_start' && conv.answers.pricingService) return startCareer(ctx, [conv.answers.pricingService]);
        if (id === 'pricing_choose') return enter(ctx, S.SERVICE_SELECTION);
        return fallback(ctx);

      case S.ORDER_ISSUE_TYPE: {
        const issue = ORDER_ISSUES.find((o) => id === `order_issue:${o.id}`);
        if (!issue) return fallback(ctx);
        for (const k of ['orderId', 'orderContact', 'orderDescription']) delete conv.answers[k];
        setAnswer(conv, 'orderIssue', issue.id);
        conv.flow = 'order';
        conv.questionQueue = buildOrderQueue();
        goto(conv, S.ORDER_DETAILS);
        return continueFlow(ctx, 0);
      }

      case S.PARTNERSHIP_TYPE: {
        const t = PARTNERSHIP_TYPES.find((o) => id === `pt:${o.id}`);
        if (!t) return fallback(ctx);
        for (const k of ['orgName', 'workEmail', 'website', 'volume', 'requirement']) delete conv.answers[k];
        setAnswer(conv, 'partnershipType', t.id);
        conv.flow = 'partnership';
        conv.questionQueue = buildPartnershipQueue({ contact: ctx.contact });
        goto(conv, S.PARTNERSHIP_DETAILS);
        return continueFlow(ctx, 0);
      }

      case S.HANDOFF_CATEGORY: {
        const c = HANDOFF_CATEGORIES.find((o) => id === `ho:${o.id}`);
        if (!c) return fallback(ctx);
        return doHandoff(ctx, c.id);
      }

      case S.SUPPORT_MENU:
        if (id === 'support_order') return enter(ctx, S.ORDER_ISSUE_TYPE);
        return fallback(ctx);

      case S.START_OVER_CONFIRM:
        if (id === 'confirm_start_over') return doStartOver(ctx, true);
        if (id === 'keep_going') {
          const prev = [...conv.history].pop();
          conv.history = conv.history.slice(0, -1);
          conv.currentState = prev || S.MAIN_MENU;
          ctx.out.push(text('Okay, carrying on where we left off.'));
          return reRender(ctx);
        }
        return fallback(ctx);

      case S.CONFIRMATION:
        if (id === 'confirm_submit') return submitCareer(ctx);
        return fallback(ctx);

      case S.NEXT_ACTION:
        if (id === 'next_add_more') return enter(ctx, S.SERVICE_SELECTION);
        return fallback(ctx);

      default:
        // Unknown / corrupted state: never break the user's session.
        ctx.log.error({ action: 'unknown_state', state: st }, 'unknown conversation state; resetting to main menu');
        return enter(ctx, S.MAIN_MENU, { push: false });
    }
  }

  // ------------------------------------------------------------------ navigation helpers
  function goto(conv, state, push = true) {
    if (push && conv.currentState && conv.currentState !== state) conv.history = [...conv.history.slice(-19), conv.currentState];
    conv.currentState = state;
  }

  async function enter(ctx, state, opts = {}) {
    goto(ctx.conv, state, opts.push !== false);
    ctx.out.push(...(await render(ctx, state)));
  }

  const reRender = async (ctx) => { ctx.out.push(...(await render(ctx, ctx.conv.currentState))); };

  async function welcome(ctx) {
    ctx.conv.currentState = S.WELCOME;
    const name = firstName(ctx.contact);
    ctx.out.push(welcomeSpec(ctx.returning ? welcomeBackText(name) : welcomeText(name)));
  }

  async function doMenu(ctx) {
    const { conv } = ctx;
    conv.history = []; conv.flow = null; conv.questionQueue = []; conv.questionIndex = 0; conv.pendingFlowToken = undefined;
    // selectedServices and answers are deliberately preserved (spec: keep history; don't delete leads)
    return enter(ctx, S.MAIN_MENU, { push: false });
  }

  async function doBack(ctx) {
    const { conv, contact } = ctx;
    if (QUESTION_STATES.has(conv.currentState)) {
      const prev = seek(conv, contact, conv.questionIndex - 1, -1);
      if (prev >= 0) { setQuestion(ctx, prev); ctx.out.push(renderCurrent(conv)); return; }
      return backViaHistory(ctx);
    }
    if (conv.currentState === S.CONFIRMATION) {
      const last = seek(conv, contact, conv.questionQueue.length - 1, -1);
      if (last >= 0) { setQuestion(ctx, last); ctx.out.push(renderCurrent(conv)); return; }
      return backViaHistory(ctx);
    }
    if (conv.currentState === S.NEXT_ACTION) return enter(ctx, S.MAIN_MENU, { push: false });
    return backViaHistory(ctx);
  }

  async function backViaHistory(ctx) {
    const { conv } = ctx;
    const h = [...conv.history];
    while (h.length) {
      const prev = h.pop();
      if (prev && !NON_RETURNABLE.has(prev) && prev !== conv.currentState) {
        conv.history = h; conv.currentState = prev;
        ctx.out.push(...(await render(ctx, prev)));
        return;
      }
    }
    conv.history = [];
    return enter(ctx, S.MAIN_MENU, { push: false });
  }

  async function doStartOver(ctx, confirmed) {
    const { conv, contact } = ctx;
    const hasProgress = (conv.selectedServices.length || Object.keys(conv.answers || {}).length) && !conv.leadCreated;
    if (hasProgress && !confirmed) {
      goto(conv, S.START_OVER_CONFIRM);
      ctx.out.push(buttons('Start over? This will clear the services and answers you have selected so far. (Your contact details and history are kept.)', [
        { id: 'confirm_start_over', title: 'Yes, start over' }, { id: 'keep_going', title: 'Keep going' }
      ]));
      return;
    }
    conv.status = conv.leadCreated ? 'completed' : 'abandoned';
    conv.endedReason = 'start_over';
    await conv.save();
    const fresh = newConversation(contact, ctx.env, ctx.now);
    fresh.currentState = S.MAIN_MENU;
    ctx.conv = fresh;
    await analytics.track('conversation_started', { contactId: contact.contactId, conversationId: fresh.conversationId, meta: { reason: 'start_over' } });
    ctx.out.push(text("No problem — let's start fresh."), mainMenuSpec());
  }

  async function doStop(ctx) {
    const { conv, contact } = ctx;
    await contactsSvc.recordConsent(contact, { action: 'opt_out', source: 'keyword_stop', conversationId: conv.conversationId, now: ctx.now });
    await track(ctx, 'opt_out', { meta: { via: 'keyword' } });
    if (conv.status !== 'human_handoff') conv.status = 'opted_out';
    ctx.out.push(text("You've been unsubscribed from promotional messages. You'll still get replies to anything you ask us. Reply MENU whenever you'd like to continue."));
  }

  // ------------------------------------------------------------------ rendering
  async function render(ctx, state) {
    const { conv, contact } = ctx;
    switch (state) {
      case S.WELCOME: return [welcomeSpec(ctx.returning ? welcomeBackText(firstName(contact)) : welcomeText(firstName(contact)))];
      case S.MAIN_MENU: return [mainMenuSpec()];
      case S.SERVICE_SELECTION: return renderServiceSelection(ctx);
      case S.SERVICE_DETAILS: case S.CONTACT_DETAILS: case S.ORDER_DETAILS: case S.PARTNERSHIP_DETAILS: return [renderCurrent(conv)];
      case S.CONFIRMATION: return [await confirmationSpec(ctx)];
      case S.NEXT_ACTION: return [nextActionSpec(conv)];
      case S.PRICING_MENU:
        return [list(PRICING_INTRO, [{ title: 'Plans', rows: PRICING_OPTIONS.map((o) => ({ id: o.id, title: o.title, description: o.description })) }, navSection(NAV.back, NAV.menu)], { button: 'Choose' })];
      case S.ORDER_ISSUE_TYPE:
        return [list(ORDER_INTRO, [{ title: 'Issue', rows: ORDER_ISSUES.map((o) => ({ id: `order_issue:${o.id}`, title: o.title, description: o.description })) }, navSection(NAV.back, NAV.menu)], { button: 'Select issue' })];
      case S.PARTNERSHIP_TYPE:
        return [list(`${PARTNERSHIP_INTRO}\nWhat kind of partnership are you interested in?`, [{ title: 'Partnership', rows: PARTNERSHIP_TYPES.map((o) => ({ id: `pt:${o.id}`, title: o.title, description: o.description })) }, navSection(NAV.back, NAV.menu)], { button: 'Choose' })];
      case S.HANDOFF_CATEGORY:
        return [list(HANDOFF_INTRO, [{ title: 'Topic', rows: HANDOFF_CATEGORIES.map((o) => ({ id: `ho:${o.id}`, title: o.title, description: o.description })) }, navSection(NAV.back, NAV.menu)], { button: 'Choose topic' })];
      case S.SUPPORT_MENU:
        return [buttons('How can we help?', [{ id: 'support_order', title: 'Order / Payment' }, NAV.human, NAV.menu])];
      case S.START_OVER_CONFIRM:
        return [buttons('Start over? This clears your current selections.', [{ id: 'confirm_start_over', title: 'Yes, start over' }, { id: 'keep_going', title: 'Keep going' }])];
      case S.PRICING_RESULT:
        return [buttons('What would you like to do next?', [{ id: 'pricing_start', title: 'Get Started' }, NAV.menu, NAV.human])];
      case S.HANDOFF_ACTIVE: return [];
      default: return [mainMenuSpec()];
    }
  }

  const renderCurrent = (conv) => {
    const qid = conv.questionQueue[conv.questionIndex];
    return renderQuestion(QUESTIONS[qid], qid);
  };

  function setQuestion(ctx, idx) {
    const { conv } = ctx;
    conv.questionIndex = idx;
    conv.currentState = PHASE_STATE[QUESTIONS[conv.questionQueue[idx]].phase];
  }

  async function renderServiceSelection(ctx) {
    const { conv, env } = ctx;
    const services = await catalog.listSelectable();
    if (!services.length) {
      return [buttons('Our services are not available to select right now. Would you like to talk to our team?', [NAV.human, NAV.menu])];
    }
    const valid = new Set(services.map((s) => s.id));
    conv.selectedServices = conv.selectedServices.filter((id) => valid.has(id));
    const selected = new Set(conv.selectedServices);
    const mark = (s) => `${selected.has(s.id) ? '☑' : '☐'} ${s.name}`;

    const count = selected.size;
    const loopSpec = list(
      `Select all the services you're interested in. Tap a service to tick or untick it, then choose *Continue*.${count ? `\n\nSelected (${count}): ${services.filter((s) => selected.has(s.id)).map((s) => s.name).join(', ')}` : ''}`,
      [
        { title: 'Services', rows: services.map((s) => ({ id: `svc:${s.id}`, title: mark(s), description: s.description })) },
        navSection({ id: 'svc_continue', title: `➡ Continue${count ? ` (${count})` : ''}`, description: 'Go to the next step' }, NAV.back)
      ],
      { header: 'What can we help you with?', button: 'Select services' }
    );

    if (conv.multiselectMode === 'flow' && env.serviceFlowId) {
      const token = `${conv.conversationId}.${shortCode(6)}`;
      conv.pendingFlowToken = token;
      const flowSpec = {
        kind: 'flow', header: 'What can we help you with?', body: "Select all the services you're interested in.",
        flowId: env.serviceFlowId, cta: 'Choose services', token, screen: 'SERVICE_SELECTION', draft: env.flowDraftMode,
        data: { services: services.map((s) => ({ id: s.id, title: s.name.slice(0, 30), description: (s.description || '').slice(0, 300) })), selected: [...selected] },
        fallback: loopSpec
      };
      return [flowSpec];
    }
    return [loopSpec];
  }

  async function confirmationSpec(ctx) {
    const { conv } = ctx;
    const svcs = await catalog.listServices({ activeOnly: false });
    const names = conv.selectedServices.map((id) => svcs.find((s) => s.id === id)?.name || id);
    const lines = ['Please confirm your details:', '', `*Services:* ${names.join(', ')}`];
    const qctx = { answers: conv.answers, services: new Set(conv.selectedServices), contact: ctx.contact };
    for (const k of SUMMARY_KEYS) {
      const def = QUESTIONS[k];
      const v = conv.answers[k];
      if (v === undefined || v === null || (def.when && !def.when(qctx) && k !== 'contactName' && k !== 'email' && k !== 'marketingConsent')) continue;
      lines.push(`*${def.label}:* ${def.type === 'choice' ? optionTitle(def, v) : v}`);
    }
    if (!conv.answers.contactName && ctx.contact.name) lines.push(`*Name:* ${ctx.contact.name}`);
    lines.push('', 'Shall I submit this?');
    return buttons(lines.join('\n'), [{ id: 'confirm_submit', title: 'Confirm' }, NAV.back, NAV.startOver]);
  }

  const nextActionSpec = (conv) => buttons('What would you like to do next?',
    conv.flow === 'career' ? [{ id: 'next_add_more', title: 'Add More Services' }, NAV.menu, NAV.human] : [NAV.menu, NAV.human]);

  // ------------------------------------------------------------------ service selection (single native multi-select)
  async function handleServiceSelection(ctx) {
    const { conv, input } = ctx;
    const services = await catalog.listSelectable();
    const valid = new Set(services.map((s) => s.id));

    if (input.kind === 'flow') {
      const flow = input.flow;
      if (!flow || !conv.pendingFlowToken || flow.flow_token !== conv.pendingFlowToken) {
        ctx.log.warn({ action: 'stale_flow_response' }, 'flow response with unknown/stale token');
        ctx.out.push(text('That form has expired. Here is a fresh one.'));
        return reRender(ctx);
      }
      let picked = flow.services;
      if (typeof picked === 'string') { try { picked = JSON.parse(picked); } catch { picked = [picked]; } }
      const ids = [...new Set((Array.isArray(picked) ? picked : []).map(String).filter((id) => valid.has(id)))];
      conv.pendingFlowToken = undefined;
      if (!ids.length) { ctx.out.push(text('Please select at least one service to continue.')); return reRender(ctx); }
      return proceedWithServices(ctx, ids, 'flow');
    }

    if (input.kind === 'choice') {
      if (input.id?.startsWith('svc:')) {
        const id = input.id.slice(4);
        if (!valid.has(id)) return fallback(ctx);
        conv.selectedServices = conv.selectedServices.includes(id) ? conv.selectedServices.filter((x) => x !== id) : [...conv.selectedServices, id];
        conv.invalidCount = 0;
        return reRender(ctx);
      }
      if (input.id === 'svc_continue') {
        const ids = conv.selectedServices.filter((id) => valid.has(id));
        if (!ids.length) { ctx.out.push(text('Please select at least one service first.')); return reRender(ctx); }
        return proceedWithServices(ctx, ids, 'list_loop');
      }
    }
    return fallback(ctx);
  }

  async function proceedWithServices(ctx, ids, via) {
    for (const id of ids) await track(ctx, 'menu_selection', { serviceId: id, meta: { via, count: ids.length } });
    return startCareer(ctx, ids);
  }

  async function startCareer(ctx, ids) {
    const { conv, contact } = ctx;
    const selectable = await catalog.listSelectable();
    const valid = new Set(selectable.map((s) => s.id));
    const chosen = [...new Set(ids)].filter((id) => valid.has(id));
    if (!chosen.length) {
      ctx.out.push(text("Sorry, that service isn't available right now."));
      return enter(ctx, S.MAIN_MENU);
    }
    conv.selectedServices = chosen;
    conv.flow = 'career';
    conv.invalidCount = 0;
    conv.questionQueue = buildCareerQueue({ answers: conv.answers, contact });
    goto(conv, S.SERVICE_DETAILS);
    if (chosen.length === 1) {
      if (INTROS[chosen[0]]) ctx.out.push(text(INTROS[chosen[0]]));
    } else {
      const names = chosen.map((id) => selectable.find((s) => s.id === id).name);
      ctx.out.push(text(`Great choices! 🎉 I'll ask a few quick questions just once and reuse your answers across:\n${names.map((n) => `• ${n}`).join('\n')}\n\nTap Back at any time to change an answer.`));
    }
    return continueFlow(ctx, 0);
  }

  // ------------------------------------------------------------------ question engine
  async function continueFlow(ctx, from) {
    const { conv, contact } = ctx;
    const next = seek(conv, contact, from, 1);
    if (next >= conv.questionQueue.length) return finishFlow(ctx);
    setQuestion(ctx, next);
    ctx.out.push(renderCurrent(conv));
  }

  async function finishFlow(ctx) {
    const { conv } = ctx;
    if (conv.flow === 'order') return submitOrder(ctx);
    if (conv.flow === 'partnership') return submitPartnership(ctx);
    goto(conv, S.CONFIRMATION);
    ctx.out.push(await confirmationSpec(ctx));
  }

  async function handleQuestion(ctx) {
    const { conv, contact, input } = ctx;
    const qid = conv.questionQueue[conv.questionIndex];
    const def = QUESTIONS[qid];
    if (!def) { ctx.log.error({ action: 'bad_question', qid }, 'question missing'); return enter(ctx, S.MAIN_MENU, { push: false }); }

    let value; let flags;
    if (def.type === 'choice') {
      const opt = resolveChoice(def, qid, input);
      if (!opt) return fallback(ctx);
      value = opt.id;
    } else if (input.kind === 'choice' && input.id === 'skip' && def.optional) {
      value = null;
    } else if (input.kind === 'text' && input.text) {
      if (containsSensitive(input.text)) {
        conv.invalidCount += 1;
        ctx.out.push(text(`${SECURITY_NOTE}\nPlease reply again without that information.`));
        ctx.out.push(renderCurrent(conv));
        return;
      }
      const parsed = def.parse ? def.parse(input.text) : { ok: true, value: input.text };
      if (!parsed.ok) {
        conv.invalidCount += 1;
        if (conv.invalidCount >= ctx.env.maxInvalidInputs) return offerHuman(ctx);
        ctx.out.push(text(parsed.error));
        ctx.out.push(renderCurrent(conv));
        return;
      }
      value = parsed.value; flags = parsed.flags;
    } else {
      return fallback(ctx);
    }

    conv.invalidCount = 0;
    setAnswer(conv, qid, value);
    def.derive?.(value, conv.answers);
    conv.markModified('answers');
    await applyContactSideEffects(ctx, qid, value, flags);
    return continueFlow(ctx, conv.questionIndex + 1);
  }

  function resolveChoice(def, qid, input) {
    if (input.kind === 'choice') {
      const prefix = optionReplyId(qid, '');
      if (input.id?.startsWith(prefix)) return def.options.find((o) => o.id === input.id.slice(prefix.length)) || null;
      return null;
    }
    if (input.kind === 'text') {
      const t = input.text.trim().toLowerCase();
      return def.options.find((o) => o.title.toLowerCase() === t || o.id === t) || null;
    }
    return null;
  }

  async function applyContactSideEffects(ctx, qid, value, flags) {
    const { contact, conv } = ctx;
    if (qid === 'contactName' && value) { await contactsSvc.setContactFields(contact.contactId, { name: value }); contact.name = value; }
    if (qid === 'email' && value) { await contactsSvc.setContactFields(contact.contactId, { email: value }); contact.email = value; }
    if (qid === 'marketingConsent') {
      if (value === 'yes') { await contactsSvc.recordConsent(contact, { action: 'opt_in', source: 'whatsapp_conversation_prompt', conversationId: conv.conversationId, now: ctx.now }); await track(ctx, 'opt_in', {}); }
      else await contactsSvc.recordConsent(contact, { action: 'opt_out', source: 'whatsapp_conversation_declined', conversationId: conv.conversationId, now: ctx.now });
    }
    if (qid === 'workEmail' && flags?.freeDomain) setAnswer(conv, 'workEmailFreeDomain', true);
  }

  // ------------------------------------------------------------------ pricing
  async function handlePricingMenu(ctx) {
    const { conv, input } = ctx;
    const opt = input.kind === 'choice' ? PRICING_OPTIONS.find((o) => o.id === input.id) : null;
    if (!opt) return fallback(ctx);
    await track(ctx, 'menu_selection', { serviceId: opt.serviceId || 'plans_pricing', meta: { choice: opt.id } });

    if (opt.id === 'price_help') { ctx.out.push(text("Let's find the right tools. Select everything you're interested in and I'll guide you.")); return enter(ctx, S.SERVICE_SELECTION); }

    if (opt.id === 'price_multi') {
      const tools = await catalog.listSelectable();
      const body = tools.map((s) => formatPricing(s)).join('\n\n');
      for (const s of tools) if (s.pricing?.approved && s.pricing.checkoutUrl) await track(ctx, 'checkout_link_shared', { serviceId: s.id });
      goto(conv, S.PRICING_RESULT);
      ctx.out.push(text(body || 'Approved pricing is not available right now.'), buttons('Want to pick the tools you need?', [{ id: 'pricing_choose', title: 'Choose Services' }, NAV.menu, NAV.human]));
      return;
    }
    const svc = await catalog.getService(opt.serviceId);
    setAnswer(conv, 'pricingService', opt.serviceId);
    if (svc?.pricing?.approved && svc.pricing.checkoutUrl) await track(ctx, 'checkout_link_shared', { serviceId: svc.id });
    goto(conv, S.PRICING_RESULT);
    ctx.out.push(text(svc ? formatPricing(svc) : "I don't have verified information for that. I can connect you with our team."), ...(await render(ctx, S.PRICING_RESULT)));
  }

  // ------------------------------------------------------------------ submissions (nothing is claimed until the backend confirms)
  async function submitCareer(ctx) {
    const { conv, contact } = ctx;
    const a = conv.answers;
    const svcs = await catalog.listServices({ activeOnly: false });
    const byId = Object.fromEntries(svcs.map((s) => [s.id, s]));
    const route = queueFor('career_services');
    const qualified = Boolean(a.targetRole && a.experienceLevel);
    const needsFollowUp = conv.selectedServices.some((id) => !byId[id]?.live);
    const details = {};
    for (const k of SUMMARY_KEYS) if (!TOP_LEVEL_LEAD_KEYS.has(k) && a[k] !== undefined && a[k] !== null) details[k] = a[k];

    let result;
    try {
      result = await leadsSvc.upsertLead({
        contactId: contact.contactId, conversationId: conv.conversationId, intent: 'career_services', serviceIds: conv.selectedServices,
        fields: { targetRole: a.targetRole, experienceLevel: a.experienceLevel, preferredLocation: a.preferredLocation, customerType: 'job_seeker' },
        details, qualified, assignedOwner: route.owner || undefined, source: contact.source,
        nextAction: needsFollowUp ? (a.resumeNextStep === 'callback' ? 'callback_requested' : 'early_access_followup') : 'share_service_links'
      });
    } catch (err) {
      ctx.log.error({ action: 'lead_upsert_failed', errorCategory: err?.name }, 'lead save failed');
      ctx.out.push(buttons("Sorry — I couldn't save your request just now, so nothing has been submitted yet. Please try again, or talk to our team.", [{ id: 'confirm_submit', title: 'Try Again' }, NAV.human, NAV.menu]));
      return;
    }
    const { lead, created } = result;
    if (created) {
      await track(ctx, 'lead_captured', { meta: { services: conv.selectedServices, leadId: lead.leadId } });
      if (qualified) await track(ctx, 'qualified_lead', { meta: { leadId: lead.leadId } });
      await notifier.notify({ queue: route.queue, owner: route.owner, title: `New lead ${lead.leadId}`, lines: [`Services: ${conv.selectedServices.join(', ')}`, `Next action: ${lead.nextAction}`] });
    }
    await track(ctx, 'flow_completed', { meta: { flow: 'career' } });

    const lines = [`Thank you${firstName(contact) ? `, ${firstName(contact)}` : ''}! ✅ Your request has been saved for:`];
    for (const id of conv.selectedServices) lines.push(`• ${byId[id]?.name || id}`);
    lines.push(`Reference: ${lead.leadId}`, '');
    for (const id of conv.selectedServices) {
      const s = byId[id];
      if (s?.live && s.url) { lines.push(`${s.name}: ${s.url}`); await track(ctx, 'service_link_shared', { serviceId: id }); }
      else lines.push(`${s?.name || id}: not available for self-service here yet — our team will follow up with you.`);
    }
    if (conv.selectedServices.includes('jobs_career_guidance')) lines.push('', "DutyLaunch shares only verified, current listings and can't guarantee employment or interviews.");

    conv.leadCreated = true;
    conv.history = [S.MAIN_MENU];
    conv.currentState = S.NEXT_ACTION;
    ctx.out.push(text(lines.join('\n')), nextActionSpec(conv));
  }

  async function submitPartnership(ctx) {
    const { conv, contact } = ctx;
    const a = conv.answers;
    const type = PARTNERSHIP_TYPES.find((t) => t.id === a.partnershipType);
    const route = queueFor('business_partnership');
    let result;
    try {
      result = await leadsSvc.upsertLead({
        contactId: contact.contactId, conversationId: conv.conversationId, intent: 'partnership', serviceIds: ['partnership'],
        fields: { customerType: type?.customerType || 'other' },
        details: { partnershipType: a.partnershipType, organization: a.orgName, workEmail: a.workEmail, workEmailFreeDomain: a.workEmailFreeDomain, website: a.website, volume: a.volume, requirement: a.requirement },
        qualified: false, assignedOwner: route.owner || undefined, source: contact.source, nextAction: 'business_followup'
      });
    } catch (err) {
      ctx.log.error({ action: 'partnership_lead_failed', errorCategory: err?.name }, 'partnership lead save failed');
      ctx.out.push(buttons("Sorry — I couldn't save your enquiry just now, so nothing has been submitted yet. Please try again shortly or talk to our team.", [NAV.human, NAV.menu]));
      conv.currentState = S.PARTNERSHIP_TYPE;
      return;
    }
    if (result.created) {
      await track(ctx, 'lead_captured', { meta: { intent: 'partnership', leadId: result.lead.leadId } });
      await notifier.notify({ queue: route.queue, owner: route.owner, title: `New partnership enquiry ${result.lead.leadId}`, lines: [`Type: ${a.partnershipType}`, `Organization: ${a.orgName}`] });
    }
    await track(ctx, 'flow_completed', { meta: { flow: 'partnership' } });
    conv.leadCreated = true; conv.history = [S.MAIN_MENU]; conv.currentState = S.NEXT_ACTION;
    ctx.out.push(text(`Thank you! 🤝 Your partnership enquiry has been recorded (Reference: ${result.lead.leadId}). Our team will review it and get in touch.`), nextActionSpec(conv));
  }

  async function submitOrder(ctx) {
    const { conv, contact } = ctx;
    const a = conv.answers;
    const issue = ORDER_ISSUES.find((o) => o.id === a.orderIssue) || ORDER_ISSUES[5];

    let lookup = null;
    if (a.orderId) lookup = await ordersSvc.lookupForUser({ orderId: a.orderId, number: contact.normalizedWhatsappNumber });

    let created;
    try {
      created = await support.createTicket({
        contact, conversationId: conv.conversationId, category: issue.category, orderId: a.orderId || null,
        summary: `${issue.description}. Registered contact: ${a.orderContact}. ${a.orderDescription}`,
        dedupeKey: `${conv.conversationId}:order:${conv.ticketSeq}`
      });
    } catch (err) {
      ctx.log.error({ action: 'ticket_create_failed', errorCategory: err?.name }, 'ticket creation failed');
      ctx.out.push(buttons("Sorry — I couldn't create your support request just now, so nothing has been submitted yet. Please try again shortly.", [NAV.human, NAV.menu]));
      conv.currentState = S.ORDER_ISSUE_TYPE;
      return;
    }
    conv.ticketSeq += 1;
    await track(ctx, 'flow_completed', { meta: { flow: 'order' } });

    const parts = [ticketAckText({ firstName: firstName(contact), ticketId: created.ticket.ticketId, categoryLabel: CATEGORY_LABEL[issue.category], supportHours: ctx.env.supportHoursText })];
    if (a.orderId) {
      if (!lookup?.available) parts.push("I can't confirm your order or payment status right now, so I haven't drawn any conclusion. Our team will check it for you.");
      else if (lookup.found && lookup.verified) {
        const o = lookup.order;
        parts.push(`Our records show order ${o.orderId}: payment status *${o.paymentStatus}*, order status *${o.status}*${o.refundStatus && o.refundStatus !== 'none' ? `, refund status *${o.refundStatus}*` : ''}.`);
      } else parts.push("I couldn't match that order ID to this WhatsApp number, so I can't share its status here. Our team will verify it for you.");
    }
    if (issue.id === 'refund_request') parts.push('Refund requests are reviewed by our team. I can’t confirm or promise a refund in this chat.');

    conv.history = [S.MAIN_MENU]; conv.currentState = S.NEXT_ACTION;
    ctx.out.push(text(parts.join('\n\n')), nextActionSpec(conv));
  }

  async function doHandoff(ctx, categoryId) {
    const { conv, contact, env } = ctx;
    const prevState = conv.history[conv.history.length - 1] || conv.currentState;
    let created;
    try {
      created = await support.createTicket({
        contact, conversationId: conv.conversationId, category: categoryId, handoffActive: true,
        summary: `Human requested (${categoryId}). Last menu: ${prevState}. Services: ${conv.selectedServices.join(', ') || 'none'}.`,
        dedupeKey: `${conv.conversationId}:handoff:${conv.ticketSeq}`
      });
    } catch (err) {
      ctx.log.error({ action: 'handoff_ticket_failed', errorCategory: err?.name }, 'handoff ticket failed');
      ctx.out.push(buttons("Sorry — I couldn't reach our support system just now, so your request hasn't been logged. Please try again in a moment.", [{ id: 'cmd_human', title: 'Try Again' }, NAV.menu]));
      return;
    }
    conv.ticketSeq += 1;
    conv.status = 'human_handoff';
    conv.handoff = { ticketId: created.ticket.ticketId, since: ctx.now, expiresAt: new Date(ctx.now.getTime() + env.handoffTimeoutMinutes * 60000) };
    conv.currentState = S.HANDOFF_ACTIVE;
    await track(ctx, 'human_handoff', { meta: { category: categoryId, ticketId: created.ticket.ticketId } });
    ctx.out.push(text(ticketAckText({ firstName: firstName(contact), ticketId: created.ticket.ticketId, categoryLabel: CATEGORY_LABEL[categoryId] || 'Other', supportHours: env.supportHoursText })));
  }

  // ------------------------------------------------------------------ fallback
  async function fallback(ctx) {
    const { conv } = ctx;
    conv.invalidCount += 1;
    await track(ctx, 'fallback', { meta: { state: conv.currentState } });
    if (conv.invalidCount >= ctx.env.maxInvalidInputs) return offerHuman(ctx);
    ctx.out.push(text('I can help you with that. Please choose one of the options below.'));
    return reRender(ctx);
  }

  async function offerHuman(ctx) {
    ctx.conv.invalidCount = 0;
    await track(ctx, 'unresolved_intent', { meta: { state: ctx.conv.currentState } });
    ctx.out.push(buttons("I'm having trouble understanding that. Would you like to talk to our team?", [NAV.human, NAV.menu, NAV.back]));
  }

  // ------------------------------------------------------------------ persistence, sending
  function newConversation(contact, env, now) {
    const mode = env.multiselectMode === 'flow' && env.serviceFlowId ? 'flow' : 'list_loop';
    return new Conversation({
      conversationId: newId(), contactId: contact.contactId, whatsappNumber: contact.normalizedWhatsappNumber,
      currentState: S.WELCOME, multiselectMode: mode, status: 'active', lastMessageAt: now,
      expiresAt: new Date(now.getTime() + env.sessionTtlHours * 3600000)
    });
  }

  async function loadActive(contact, now) {
    const conv = await Conversation.findOne({ contactId: contact.contactId, status: { $in: ['active', 'human_handoff', 'opted_out'] } }).sort({ createdAt: -1 });
    if (!conv) return null;
    if (conv.status !== 'human_handoff' && conv.expiresAt && conv.expiresAt < now) {
      conv.status = conv.leadCreated ? 'completed' : 'abandoned';
      conv.endedReason = 'expired';
      await conv.save();
      return null;
    }
    return conv;
  }

  function releaseLocal(conv) {
    conv.status = 'active'; conv.handoff = undefined; conv.currentState = S.MAIN_MENU; conv.history = [];
  }

  async function logInbound(ctx) {
    const { msg, conv, contact } = ctx;
    try {
      const row = { direction: 'in', contactId: contact.contactId, conversationId: conv.conversationId, whatsappNumberHash: hashNumber(contact.normalizedWhatsappNumber), kind: `${msg.type}_in` };
      if (msg.messageId) row.providerMessageId = String(msg.messageId);
      await MessageLog.create(row);
    } catch (e) {
      if (e?.code !== 11000) ctx.log.warn({ action: 'inbound_log_failed', errorCategory: e?.name }, 'inbound audit write failed');
    }
  }

  async function sendAll(ctx) {
    const { conv, contact } = ctx;
    const undelivered = [];
    for (const spec of ctx.out) {
      if (undelivered.length) { undelivered.push(spec); continue; }
      let res = await messenger.send({ contact, conversationId: conv.conversationId, spec });
      if (!res.ok && spec.kind === 'flow' && spec.fallback && res.error?.category !== 'policy') {
        // The Flow could not be sent (e.g. MSG91 account lacks Flow support): degrade to the native list multi-select.
        ctx.log.warn({ action: 'flow_fallback', errorCategory: res.error?.category }, 'flow send failed; using native list multi-select');
        conv.multiselectMode = 'list_loop'; conv.pendingFlowToken = undefined;
        res = await messenger.send({ contact, conversationId: conv.conversationId, spec: spec.fallback });
        await conv.save();
        if (!res.ok) undelivered.push(spec.fallback);
        continue;
      }
      if (!res.ok) { if (res.error?.retryable) undelivered.push(spec); else ctx.log.error({ action: 'prompt_dropped', reason: res.error?.reason || res.error?.category }, 'prompt could not be delivered'); }
    }
    if (undelivered.length) {
      conv.pendingPrompts = undelivered.slice(0, 5).map(stripFn); conv.pendingAttempts = 0; conv.markModified('pendingPrompts');
      await conv.save();
    } else if (conv.pendingPrompts?.length) {
      conv.pendingPrompts = []; await conv.save();
    }
  }
  const stripFn = (spec) => JSON.parse(JSON.stringify(spec));

  const track = (ctx, type, extra = {}) => analytics.track(type, { contactId: ctx.contact.contactId, conversationId: ctx.conv.conversationId, ...extra });

  // ------------------------------------------------------------------ operations used by routes / sweepers
  /** Releases the bot pause for a ticket (agent finished) and, if possible, tells the user. */
  async function releaseHandoff({ ticketId, resolved = false }) {
    const ticket = await SupportTicket.findOne({ ticketId: String(ticketId) });
    if (!ticket) return { ok: false, reason: 'ticket_not_found' };
    await SupportTicket.updateOne({ _id: ticket._id }, { $set: { handoffActive: false, status: resolved ? 'resolved' : 'pending', ...(resolved ? { resolvedAt: new Date() } : {}) } });
    const first = await Conversation.findOne({ conversationId: ticket.conversationId });
    if (!first || first.status !== 'human_handoff' || first.handoff?.ticketId !== ticket.ticketId) return { ok: true, conversationReleased: false };
    return lock.run(first.whatsappNumber, async () => {
      const conv = await Conversation.findOne({ conversationId: ticket.conversationId });
      if (!conv || conv.status !== 'human_handoff') return { ok: true, conversationReleased: false };
      const contact = await Contact.findOne({ contactId: conv.contactId });
      releaseLocal(conv);
      conv.expiresAt = new Date(Date.now() + getEnv().sessionTtlHours * 3600000);
      await conv.save();
      const ctx = { conv, contact, out: [text(resolved ? 'Our team has marked your request as resolved. Is there anything else I can help with?' : 'Our team has finished for now. I can help you with anything else.'), mainMenuSpec()], log: logger };
      await sendAll(ctx);
      return { ok: true, conversationReleased: true };
    });
  }

  /** Re-sends prompts that failed to send earlier (provider outage). */
  async function resendPending(limit = 20) {
    const convs = await Conversation.find({ 'pendingPrompts.0': { $exists: true }, pendingAttempts: { $lt: 3 } }).limit(limit);
    let resent = 0;
    for (const c of convs) {
      await lock.run(c.whatsappNumber, async () => {
        const conv = await Conversation.findOne({ conversationId: c.conversationId });
        const contact = await Contact.findOne({ contactId: conv.contactId });
        conv.pendingAttempts += 1;
        const specs = conv.pendingPrompts;
        conv.pendingPrompts = []; conv.markModified('pendingPrompts');
        await conv.save();
        const ctx = { conv, contact, out: specs, log: logger };
        await sendAll(ctx);
        if (!conv.pendingPrompts.length) resent += 1;
      });
    }
    return resent;
  }

  /** Marks stale conversations as completed/abandoned; frees timed-out handoffs. */
  async function expireStale(now = new Date()) {
    const active = await Conversation.find({ status: { $in: ['active', 'opted_out'] }, expiresAt: { $lt: now } });
    for (const c of active) {
      c.status = c.leadCreated ? 'completed' : 'abandoned'; c.endedReason = 'expired'; await c.save();
    }
    const handoffs = await Conversation.find({ status: 'human_handoff', 'handoff.expiresAt': { $lt: now } });
    for (const c of handoffs) { c.status = 'completed'; c.endedReason = 'handoff_timeout'; await c.save(); }
    return { expired: active.length, handoffTimeouts: handoffs.length };
  }

  return { handleInbound, releaseHandoff, resendPending, expireStale, lock };
}

function toInput(msg) {
  switch (msg.type) {
    case 'text': return { kind: 'text', text: msg.text || '' };
    case 'button': case 'list': return { kind: 'choice', id: msg.replyId || '', title: msg.replyTitle || '' };
    case 'flow': return { kind: 'flow', flow: msg.flowResponse };
    default: return { kind: 'other' };
  }
}

function setAnswer(conv, key, value) {
  conv.answers = { ...(conv.answers || {}), [key]: value };
  conv.markModified('answers');
}
