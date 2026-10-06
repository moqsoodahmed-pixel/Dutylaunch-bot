import mongoose from 'mongoose';

const ServiceConfigurationSchema = new mongoose.Schema({
  serviceId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  description: String,
  category: { type: String, required: true },
  order: { type: Number, default: 100 },
  active: { type: Boolean, default: true },
  live: { type: Boolean, default: false },   // live vs early-access (spec section 15)
  url: String,
  pricing: {
    approved: { type: Boolean, default: false },
    currency: String,
    amount: Number,
    taxes: String,
    discountConditions: String,
    inclusions: { type: [String], default: [] },
    checkoutUrl: String,
    terms: String
  }
}, { timestamps: true, minimize: false });

export const ServiceConfiguration = mongoose.models.ServiceConfiguration || mongoose.model('ServiceConfiguration', ServiceConfigurationSchema, 'serviceConfigurations');
