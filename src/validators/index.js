import { cleanText, isEmail } from '../utils/sanitize.js';

const bad = (m) => Object.assign(new Error(m), { status: 400 });
const obj = (b) => { if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('body must be a JSON object'); return b; };

export function validateLeadInput(body) {
  const b = obj(body);
  if (!b.whatsappNumber) throw bad('whatsappNumber is required');
  const ids = b.serviceInterest ?? b.selectedServices ?? [];
  if (!Array.isArray(ids) || ids.some((i) => typeof i !== 'string')) throw bad('serviceInterest must be an array of service IDs');
  if (b.email !== undefined && b.email !== null && b.email !== '' && !isEmail(b.email)) throw bad('email is invalid');
  return {
    whatsappNumber: String(b.whatsappNumber),
    name: cleanText(b.name, 80) || undefined,
    email: b.email || undefined,
    intent: cleanText(b.intent, 40) || 'career_services',
    serviceIds: [...new Set(ids.map((i) => cleanText(i, 60)).filter(Boolean))],
    fields: {
      targetRole: b.targetRole, experienceLevel: b.experienceLevel,
      preferredLocation: b.preferredLocation, customerType: b.customerType
    },
    nextAction: cleanText(b.nextAction, 120) || undefined,
    assignedOwner: cleanText(b.assignedOwner, 80) || undefined,
    source: cleanText(b.source, 60) || 'api'
  };
}

export function validateTicketInput(body) {
  const b = obj(body);
  if (!b.whatsappNumber) throw bad('whatsappNumber is required');
  const category = cleanText(b.category, 40);
  if (!category) throw bad('category is required');
  return {
    whatsappNumber: String(b.whatsappNumber), category,
    summary: cleanText(b.summary, 500), orderId: cleanText(b.orderId, 64) || null,
    dedupeKey: cleanText(b.dedupeKey, 120) || null
  };
}

export function validateSendInput(body) {
  const b = obj(body);
  if (!b.whatsappNumber) throw bad('whatsappNumber is required');
  const type = b.type || (b.templateName ? 'template' : 'text');
  if (!['text', 'template'].includes(type)) throw bad('type must be text or template');
  const purpose = b.purpose || 'service';
  if (!['service', 'marketing'].includes(purpose)) throw bad('purpose must be service or marketing');
  if (type === 'text') {
    const t = cleanText(b.text, 1000);
    if (!t) throw bad('text is required');
    return { whatsappNumber: String(b.whatsappNumber), type, purpose, text: t };
  }
  const name = cleanText(b.templateName, 100);
  if (!name) throw bad('templateName is required');
  const variables = Array.isArray(b.variables) ? b.variables.map((v) => cleanText(v, 200)) : [];
  return { whatsappNumber: String(b.whatsappNumber), type, purpose, templateName: name, variables };
}

export function validatePaymentEvent(body) {
  const b = obj(body);
  const eventId = cleanText(b.eventId, 120);
  const orderId = cleanText(b.orderId, 64);
  if (!eventId) throw bad('eventId is required');
  if (!orderId) throw bad('orderId is required');
  const status = String(b.status || '').toLowerCase();
  if (!['paid', 'failed', 'pending', 'refunded'].includes(status)) throw bad('status must be paid, failed, pending or refunded');
  let amount;
  if (b.amount !== undefined && b.amount !== null) {
    amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount < 0) throw bad('amount is invalid');
  }
  if (b.customerEmail && !isEmail(b.customerEmail)) throw bad('customerEmail is invalid');
  return {
    eventId, orderId, status, amount,
    currency: cleanText(b.currency, 8) || undefined,
    customerPhone: b.customerPhone ? String(b.customerPhone) : undefined,
    customerEmail: b.customerEmail || undefined,
    providerRef: cleanText(b.providerRef, 120) || undefined,
    serviceId: cleanText(b.serviceId, 60) || undefined
  };
}
