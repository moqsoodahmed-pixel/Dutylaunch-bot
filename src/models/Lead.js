import mongoose from 'mongoose';

const LeadSchema = new mongoose.Schema({
  leadId: { type: String, required: true, unique: true },
  contactId: { type: String, required: true, index: true },
  conversationId: { type: String, required: true },
  intent: { type: String, required: true },               // career_services | partnership | ...
  serviceInterest: { type: [String], default: [] },       // stable service IDs
  selectedServices: { type: [String], default: [] },
  targetRole: String,
  experienceLevel: String,
  preferredLocation: String,
  customerType: String,
  leadStatus: { type: String, default: 'new', enum: ['new', 'contacted', 'qualified', 'converted', 'closed'] },
  qualified: { type: Boolean, default: false },
  assignedOwner: String,
  nextAction: String,
  lastInteractionAt: Date,
  followUpDueAt: Date,
  followUpState: String,                                  // sent | skipped | (unset)
  followUpReason: String,
  followUpAttempts: { type: Number, default: 0 },
  source: String,
  details: { type: Object, default: {} }                  // service-specific answers
}, { timestamps: true, minimize: false });

// One lead per conversation+intent: re-submitting never duplicates.
LeadSchema.index({ conversationId: 1, intent: 1 }, { unique: true });
LeadSchema.index({ contactId: 1, intent: 1, leadStatus: 1 });

export const Lead = mongoose.models.Lead || mongoose.model('Lead', LeadSchema, 'leads');
