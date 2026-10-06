import mongoose from 'mongoose';

export const CONVERSATION_STATUSES = ['active', 'completed', 'abandoned', 'human_handoff', 'opted_out'];

const ConversationSchema = new mongoose.Schema({
  conversationId: { type: String, required: true, unique: true },
  contactId: { type: String, required: true, index: true },
  whatsappNumber: { type: String, required: true },
  currentState: { type: String, required: true },
  history: { type: [String], default: [] },          // previous states, for BACK
  flow: { type: String, default: null },              // career | order | partnership
  selectedServices: { type: [String], default: [] },  // stable service IDs
  answers: { type: Object, default: {} },
  questionQueue: { type: [String], default: [] },
  questionIndex: { type: Number, default: 0 },
  pendingFlowToken: String,
  multiselectMode: { type: String, default: 'list_loop' },
  status: { type: String, enum: CONVERSATION_STATUSES, default: 'active' },
  invalidCount: { type: Number, default: 0 },
  ticketSeq: { type: Number, default: 0 },
  leadCreated: { type: Boolean, default: false },
  handoff: { ticketId: String, since: Date, expiresAt: Date },
  pendingPrompts: { type: [Object], default: [] },    // prompts that failed to send; retried by a sweeper
  pendingAttempts: { type: Number, default: 0 },
  endedReason: String,
  lastMessageAt: Date,
  expiresAt: Date
}, { timestamps: true, minimize: false, optimisticConcurrency: true });

ConversationSchema.index({ whatsappNumber: 1, status: 1 });
ConversationSchema.index({ status: 1, expiresAt: 1 });

export const Conversation = mongoose.models.Conversation || mongoose.model('Conversation', ConversationSchema, 'conversations');
