const WINDOW_MS = 24 * 3600 * 1000;

/**
 * WhatsApp/consent policy gate applied before EVERY outbound message.
 *  - free-form (non-template) messages only inside the 24h customer-service window
 *  - marketing purpose requires explicit opt-in and no opt-out
 *  - templates are required outside the window
 */
export function canSend({ contact, kind, purpose = 'service', now = new Date() }) {
  if (!contact) return { allowed: false, reason: 'unknown_contact' };
  if (purpose === 'marketing') {
    if (contact.optOutTimestamp && (!contact.consentTimestamp || contact.optOutTimestamp >= contact.consentTimestamp)) return { allowed: false, reason: 'opted_out' };
    if (!contact.marketingOptIn) return { allowed: false, reason: 'no_marketing_consent' };
    if (kind !== 'template' && !inWindow(contact, now)) return { allowed: false, reason: 'template_required_outside_window' };
    return { allowed: true };
  }
  if (kind === 'template') return { allowed: true };
  if (!inWindow(contact, now)) return { allowed: false, reason: 'outside_customer_service_window' };
  return { allowed: true };
}

export function inWindow(contact, now = new Date()) {
  return Boolean(contact?.lastInboundAt) && now.getTime() - new Date(contact.lastInboundAt).getTime() < WINDOW_MS;
}
