import mongoose from 'mongoose';

const SupportTicketSchema = new mongoose.Schema({
  ticketId: { type: String, required: true, unique: true },
  dedupeKey: { type: String, unique: true, sparse: true },
  contactId: { type: String, required: true, index: true },
  conversationId: String,
  category: { type: String, required: true },
  priority: { type: String, default: 'normal' },
  assignedQueue: String,
  assignedOwner: String,
  status: { type: String, default: 'open', enum: ['open', 'pending', 'resolved'] },
  summary: String,
  orderId: String,
  handoffActive: { type: Boolean, default: false },
  notifiedAt: Date,
  resolvedAt: Date
}, { timestamps: true });

export const SupportTicket = mongoose.models.SupportTicket || mongoose.model('SupportTicket', SupportTicketSchema, 'supportTickets');
