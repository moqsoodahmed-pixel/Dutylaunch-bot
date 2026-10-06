import { AnalyticsEvent, Contact, Lead, MessageLog, SupportTicket } from '../../models/index.js';
import { logger as defaultLogger } from '../../utils/logger.js';

export function createAnalytics({ logger = defaultLogger } = {}) {
  /** Fire-and-forget: analytics failures must never break a conversation. */
  async function track(type, { contactId, conversationId, serviceId, meta } = {}) {
    try { await AnalyticsEvent.create({ type, contactId, conversationId, serviceId, meta }); }
    catch (err) { logger.error({ action: 'analytics_track', type, errorCategory: err?.name }, 'analytics write failed'); }
  }

  /** Queryable summary (GET /analytics/summary). All numbers come from MongoDB. */
  async function summary({ from, to } = {}) {
    const range = {};
    if (from) range.$gte = new Date(from);
    if (to) range.$lte = new Date(to);
    const w = (extra = {}) => (Object.keys(range).length ? { ...extra, createdAt: range } : extra);
    const countType = (type) => AnalyticsEvent.countDocuments(w({ type }));
    const types = ['conversation_started', 'lead_captured', 'qualified_lead', 'service_link_shared', 'checkout_link_shared', 'ticket_created', 'human_handoff', 'fallback', 'unresolved_intent', 'opt_out', 'opt_in', 'complaint', 'delivery_failed', 'template_error', 'payment_confirmed', 'follow_up_sent'];
    const counts = {};
    for (const t of types) counts[t] = await countType(t);

    const menu = await AnalyticsEvent.find(w({ type: 'menu_selection' })).select('serviceId meta').lean();
    const menuSelections = {};
    for (const e of menu) { const k = e.serviceId || e.meta?.choice || 'unknown'; menuSelections[k] = (menuSelections[k] || 0) + 1; }
    const completed = await AnalyticsEvent.find(w({ type: 'flow_completed' })).select('meta').lean();
    const flowCompletions = {};
    for (const e of completed) { const k = e.meta?.flow || 'unknown'; flowCompletions[k] = (flowCompletions[k] || 0) + 1; }

    const inbound = await MessageLog.countDocuments(w({ direction: 'in' }));
    const uniqueContacts = await Contact.countDocuments(w());
    const leadContacts = await Lead.distinct('contactId', w());
    const paidContacts = await AnalyticsEvent.distinct('contactId', w({ type: 'payment_confirmed' }));
    const paidSet = new Set(paidContacts.filter(Boolean));
    const converted = leadContacts.filter((c) => paidSet.has(c)).length;
    const tickets = await SupportTicket.countDocuments(w());

    return {
      counts, menuSelections, flowCompletions,
      uniqueContacts, conversationsStarted: counts.conversation_started, leadsCaptured: counts.lead_captured,
      ticketVolume: tickets,
      fallbackRate: inbound ? counts.fallback / inbound : 0,
      humanHandoffRate: counts.conversation_started ? counts.human_handoff / counts.conversation_started : 0,
      leadToPaidConversion: leadContacts.length ? converted / leadContacts.length : 0,
      note: 'Service-link CLICKS are not measurable without a redirect/tracking service; service_link_shared counts links sent.'
    };
  }
  return { track, summary };
}
