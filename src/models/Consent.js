import mongoose from 'mongoose';

const ConsentSchema = new mongoose.Schema({
  contactId: { type: String, required: true, index: true },
  conversationId: String,
  type: { type: String, enum: ['marketing', 'service'], default: 'marketing' },
  action: { type: String, enum: ['opt_in', 'opt_out'], required: true },
  source: String,
  timestamp: { type: Date, default: Date.now }
}, { timestamps: false });

export const Consent = mongoose.models.Consent || mongoose.model('Consent', ConsentSchema, 'consents');
