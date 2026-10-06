import { Lead, Contact, Order, Conversation, SupportTicket } from '../models/index.js';
import { getEnv } from '../config/env.js';
import * as catalog from '../services/catalog/catalog.service.js';

/**
 * Enquiry follow-up (spec section 10). Deliberately conservative:
 *  - disabled unless FOLLOWUP_DELAY_HOURS > 0 AND an approved TEMPLATE_ENQUIRY_FOLLOWUP is configured
 *  - at most ONE follow-up per lead (a "small, approved cadence" of one)
 *  - marketing policy gate: explicit opt-in required, opt-out always wins, template only
 *  - skipped when the contact has paid, has an open support ticket, or a human currently has the chat
 */
export async function runFollowUps({ messenger, analytics, now = new Date(), limit = 25 }) {
  const env = getEnv();
  const template = env.templates.enquiryFollowUp;
  if (!(env.followUpDelayHours > 0) || !template) return { disabled: true, sent: 0, skipped: 0 };

  const cutoff = new Date(now.getTime() - env.followUpDelayHours * 3600000);
  const leads = await Lead.find({
    intent: 'career_services', leadStatus: { $in: ['new', 'qualified'] },
    followUpState: null, followUpAttempts: { $lt: 3 }, createdAt: { $lt: cutoff }
  }).limit(limit);

  let sent = 0; let skipped = 0;
  const skip = async (lead, reason) => {
    await Lead.updateOne({ _id: lead._id }, { $set: { followUpState: 'skipped', followUpReason: reason } });
    skipped += 1;
  };

  for (const lead of leads) {
    const contact = await Contact.findOne({ contactId: lead.contactId });
    if (!contact) { await skip(lead, 'no_contact'); continue; }
    if (!contact.marketingOptIn || contact.optOutTimestamp) { await skip(lead, 'no_marketing_consent'); continue; }
    if (await Order.exists({ customerPhone: contact.normalizedWhatsappNumber, paymentStatus: 'paid' })) { await skip(lead, 'already_paid'); continue; }
    if (await SupportTicket.exists({ contactId: contact.contactId, status: { $nin: ['resolved', 'closed'] } })) { await skip(lead, 'open_ticket'); continue; }
    if (await Conversation.exists({ contactId: contact.contactId, status: 'human_handoff' })) { await skip(lead, 'human_handoff_active'); continue; }

    const claimed = await Lead.findOneAndUpdate({ _id: lead._id, followUpState: null }, { $set: { followUpState: 'sending' }, $inc: { followUpAttempts: 1 } }, { new: true });
    if (!claimed) continue;                                   // another worker has it

    const services = await catalog.listServices({ activeOnly: false });
    const names = lead.selectedServices.map((id) => services.find((s) => s.id === id)?.name || id).join(', ');
    const first = (contact.name || contact.profileName || 'there').split(/\s+/)[0];
    const r = await messenger.send({
      contact, purpose: 'marketing',
      spec: { kind: 'template', name: template, variables: [first, names], languageCode: env.templateLanguage }
    });
    if (r.ok) {
      await Lead.updateOne({ _id: lead._id }, { $set: { followUpState: 'sent', followUpReason: null } });
      await analytics.track('follow_up_sent', { contactId: contact.contactId, meta: { leadId: lead.leadId } });
      sent += 1;
    } else if (r.error?.category === 'policy') {
      await skip(lead, r.error.reason);
    } else {
      await Lead.updateOne({ _id: lead._id }, { $set: { followUpState: null } });   // retry next tick (max 3 attempts)
    }
  }
  return { disabled: false, sent, skipped };
}
