import mongoose from 'mongoose';

// Audit trail WITHOUT message bodies (spec: minimise message-body retention).
const MessageLogSchema = new mongoose.Schema({
  direction: { type: String, enum: ['in', 'out'], required: true },
  providerMessageId: { type: String, unique: true, sparse: true },
  contactId: String,
  conversationId: String,
  whatsappNumberHash: String,
  kind: String,                        // text | buttons | list | flow | template | button_reply | list_reply | flow_reply
  templateName: String,
  status: String,                      // submitted | sent | delivered | read | failed
  errorCategory: String,
  errorCode: String,
  suppressedReason: String             // e.g. bot paused during human handoff
}, { timestamps: true });

MessageLogSchema.index({ conversationId: 1, createdAt: 1 });

export const MessageLog = mongoose.models.MessageLog || mongoose.model('MessageLog', MessageLogSchema, 'messageLogs');
