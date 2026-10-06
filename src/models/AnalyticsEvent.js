import mongoose from 'mongoose';

export const ANALYTICS_TYPES = [
  'conversation_started', 'menu_selection', 'flow_completed', 'lead_captured', 'qualified_lead',
  'service_link_shared', 'checkout_link_shared', 'ticket_created', 'human_handoff', 'fallback',
  'unresolved_intent', 'opt_out', 'opt_in', 'complaint', 'delivery_failed', 'template_error', 'payment_confirmed', 'follow_up_sent'
];

const AnalyticsEventSchema = new mongoose.Schema({
  type: { type: String, required: true, enum: ANALYTICS_TYPES },
  contactId: String,
  conversationId: String,
  serviceId: String,
  meta: Object,
  createdAt: { type: Date, default: Date.now }
}, { timestamps: false });

AnalyticsEventSchema.index({ type: 1, createdAt: 1 });
AnalyticsEventSchema.index({ serviceId: 1, type: 1 });

export const AnalyticsEvent = mongoose.models.AnalyticsEvent || mongoose.model('AnalyticsEvent', AnalyticsEventSchema, 'analyticsEvents');
