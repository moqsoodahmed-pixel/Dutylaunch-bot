import mongoose from 'mongoose';
import { Contact } from '../models/index.js';
import { getEnv } from '../config/env.js';
import { normalizePhone } from '../utils/phone.js';
import * as contactsSvc from '../services/contacts/contacts.service.js';
import * as leadsSvc from '../services/leads/leads.service.js';
import * as ordersSvc from '../services/orders/orders.service.js';
import * as catalog from '../services/catalog/catalog.service.js';
import { validateLeadInput, validateTicketInput, validateSendInput } from '../validators/index.js';
import { text } from '../services/conversation/prompts.js';

const notFound = (m) => Object.assign(new Error(m), { status: 404 });
const badReq = (m) => Object.assign(new Error(m), { status: 400 });

/** Back-office / integration endpoints (protected by the internal API key). */
export function createApiController({ support, messenger, engine, analytics }) {
  const findContact = async (raw) => {
    const n = normalizePhone(raw, getEnv().defaultCountryCode);
    if (!n) throw badReq('whatsappNumber is invalid');
    return Contact.findOne({ normalizedWhatsappNumber: n });
  };

  return {
    health: async (req, res) => {
      const dbUp = mongoose.connection.readyState === 1;
      const env = getEnv();
      res.status(dbUp ? 200 : 503).json({
        status: dbUp ? 'ok' : 'degraded', db: dbUp ? 'up' : 'down',
        msg91Configured: Boolean(env.msg91.authKey && env.msg91.integratedNumber),
        multiselectMode: env.multiselectMode
      });
    },

    upsertContact: async (req, res) => {
      const b = req.body || {};
      const contact = await contactsSvc.upsertContact(b);
      res.status(200).json({ contact });
    },

    createLead: async (req, res) => {
      const input = validateLeadInput(req.body);
      const v = await leadsSvc.validateServiceIds(input.serviceIds);
      if (!v.ok) throw badReq(`unknown service IDs: ${v.bad.join(', ')}`);
      const contact = await contactsSvc.upsertContact({ whatsappNumber: input.whatsappNumber, name: input.name, email: input.email, source: input.source });
      const { lead, created } = await leadsSvc.upsertLead({
        contactId: contact.contactId, conversationId: `api:${contact.contactId}`, intent: input.intent,
        serviceIds: input.serviceIds, fields: input.fields, nextAction: input.nextAction, assignedOwner: input.assignedOwner, source: input.source
      });
      if (created) await analytics.track('lead_captured', { contactId: contact.contactId, meta: { via: 'api' } });
      res.status(created ? 201 : 200).json({ lead, created });
    },

    getOrder: async (req, res) => {
      const phone = req.query.phone ? normalizePhone(String(req.query.phone), getEnv().defaultCountryCode) : null;
      const order = await ordersSvc.getOrderPublic(req.params.orderId, phone);
      if (!order) throw notFound('order not found');
      res.json({ order });
    },

    createTicket: async (req, res) => {
      const input = validateTicketInput(req.body);
      const contact = await contactsSvc.upsertContact({ whatsappNumber: input.whatsappNumber });
      const { ticket, created, notified } = await support.createTicket({ contact, category: input.category, summary: input.summary, orderId: input.orderId, dedupeKey: input.dedupeKey });
      res.status(created ? 201 : 200).json({ ticket, created, teamNotified: notified });
    },

    sendMessage: async (req, res) => {
      const input = validateSendInput(req.body);
      const contact = await findContact(input.whatsappNumber);
      if (!contact) throw notFound('contact not found');
      const env = getEnv();
      const spec = input.type === 'template'
        ? { kind: 'template', name: input.templateName, variables: input.variables, languageCode: env.templateLanguage }
        : text(input.text);
      const r = await messenger.send({ contact, spec, purpose: input.purpose });
      if (r.ok) return res.status(200).json({ sent: true, providerMessageId: r.providerMessageId || null });
      // Policy blocks are a client-visible 422; provider problems are 502 and never reported as sent.
      const status = r.error.category === 'policy' ? 422 : 502;
      res.status(status).json({ sent: false, error: r.error });
    },

    listServices: async (req, res) => res.json({ services: await catalog.listServices({ activeOnly: false }) }),

    updateService: async (req, res) => {
      const svc = await catalog.updateService(req.params.id, req.body || {});
      if (!svc) throw notFound('service not found');
      res.json({ service: svc });
    },

    analyticsSummary: async (req, res) => res.json(await analytics.summary({ from: req.query.from, to: req.query.to })),

    releaseHandoff: async (req, res) => {
      const r = await engine.releaseHandoff({ ticketId: req.params.ticketId, resolved: Boolean(req.body?.resolved) });
      if (!r.ok) throw notFound('ticket not found');
      res.json(r);
    }
  };
}
