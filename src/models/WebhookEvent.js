import mongoose from 'mongoose';
import { getEnv } from '../config/env.js';

const WebhookEventSchema = new mongoose.Schema({
  provider: { type: String, required: true },
  providerEventId: { type: String, required: true },
  eventType: String,
  payloadHash: String,
  normalized: Object,                 // dropped once processed, to minimise retention
  processed: { type: Boolean, default: false },
  processedAt: Date,
  attempts: { type: Number, default: 0 },
  lockedUntil: Date,
  error: String,
  expiresAt: { type: Date, default: () => new Date(Date.now() + getEnv().webhookEventTtlDays * 86400000) }
}, { timestamps: { createdAt: true, updatedAt: false }, minimize: false });

WebhookEventSchema.index({ provider: 1, providerEventId: 1 }, { unique: true });
WebhookEventSchema.index({ processed: 1, lockedUntil: 1 });
WebhookEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const WebhookEvent = mongoose.models.WebhookEvent || mongoose.model('WebhookEvent', WebhookEventSchema, 'webhookEvents');
