import mongoose from 'mongoose';

const OrderSchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true },
  customerPhone: { type: String, index: true },
  customerEmail: String,
  serviceId: String,
  status: { type: String, default: 'created' },
  paymentStatus: { type: String, default: 'unknown' },   // paid | failed | pending | refunded | unknown
  refundStatus: { type: String, default: 'none' },
  amount: Number,
  currency: String,
  paymentProviderRef: String,
  lastPaymentEventId: String,
  confirmationClaimedAt: Date,
  confirmationSentAt: Date
}, { timestamps: true });

export const Order = mongoose.models.Order || mongoose.model('Order', OrderSchema, 'orders');
