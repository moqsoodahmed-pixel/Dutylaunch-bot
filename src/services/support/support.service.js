import { SupportTicket } from '../../models/index.js';
import { ticketId as newTicketId } from '../../utils/ids.js';
import { queueFor } from '../../config/queues.js';
import { cleanText } from '../../utils/sanitize.js';

export function createSupportService({ notifier, analytics }) {
  /**
   * Creates a ticket (idempotent on dedupeKey), routes it to a queue and notifies the team.
   * Returns { ticket, created, notified }.
   */
  async function createTicket({ contact, conversationId = null, category, summary = '', orderId = null, dedupeKey = null, handoffActive = false, priority }) {
    const route = queueFor(category);
    let ticket, created = true;
    try {
      ticket = await SupportTicket.create({
        ticketId: newTicketId(), dedupeKey: dedupeKey || undefined, contactId: contact.contactId, conversationId,
        category, priority: priority || route.priority, assignedQueue: route.queue, assignedOwner: route.owner || undefined,
        summary: cleanText(summary, 500), orderId: orderId ? cleanText(orderId, 64) : undefined, handoffActive
      });
    } catch (e) {
      if (e?.code === 11000 && dedupeKey) { ticket = await SupportTicket.findOne({ dedupeKey }); created = false; }
      else throw e;
    }
    let notified = false;
    if (created) {
      const res = await notifier.notify({
        queue: route.queue, owner: route.owner, title: `New ticket ${ticket.ticketId} [${category}]`,
        lines: [`Priority: ${ticket.priority}`, `Contact: ${contact.contactId}`, ticket.orderId ? `Order: ${ticket.orderId}` : null, handoffActive ? 'Bot is PAUSED for this chat until released.' : null].filter(Boolean)
      });
      notified = res.delivered;
      if (notified) await SupportTicket.updateOne({ _id: ticket._id }, { $set: { notifiedAt: new Date() } });
      await analytics.track('ticket_created', { contactId: contact.contactId, conversationId, meta: { category, queue: route.queue } });
      if (category === 'complaint') await analytics.track('complaint', { contactId: contact.contactId, conversationId });
    }
    return { ticket: ticket.toObject ? ticket.toObject() : ticket, created, notified };
  }

  const getTicket = (id) => SupportTicket.findOne({ ticketId: String(id) }).lean();
  return { createTicket, getTicket };
}
