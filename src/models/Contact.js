import mongoose from 'mongoose';

const ContactSchema = new mongoose.Schema({
  contactId: { type: String, required: true, unique: true },
  normalizedWhatsappNumber: { type: String, required: true, unique: true },
  name: String,            // name the user explicitly gave us
  profileName: String,     // WhatsApp profile display name (used only for greetings)
  email: String,
  // Attribution
  source: String,
  landingPage: String,
  campaignReferralId: String,
  // Consent (spec section 6)
  serviceMessageBasis: { type: String, default: 'user_initiated_conversation' },
  marketingOptIn: { type: Boolean, default: false },
  consentTimestamp: Date,
  consentSource: String,
  optOutTimestamp: Date,
  // Customer-service window tracking
  lastInboundAt: Date,
  firstSeenAt: { type: Date, default: Date.now }
}, { timestamps: true });

export const Contact = mongoose.models.Contact || mongoose.model('Contact', ContactSchema, 'contacts');
