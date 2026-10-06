import 'dotenv/config';

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes'].includes(String(v).toLowerCase()));

/** Read configuration at call time (keeps tests and hot-reloads simple). */
export function getEnv() {
  const e = process.env;
  const serviceFlowId = e.MSG91_SERVICE_FLOW_ID || '';
  return {
    nodeEnv: e.NODE_ENV || 'development',
    isProd: (e.NODE_ENV || 'development') === 'production',
    port: num(e.PORT, 3000),
    mongoUri: e.MONGODB_URI || 'mongodb://127.0.0.1:27017/dutylaunch',
    msg91: {
      authKey: e.MSG91_AUTH_KEY || '',
      integratedNumber: e.MSG91_INTEGRATED_NUMBER || '',
      baseUrl: e.MSG91_BASE_URL || 'https://control.msg91.com',
      webhookSecret: e.MSG91_WEBHOOK_SECRET || '',
      webhookHmacSecret: e.MSG91_WEBHOOK_HMAC_SECRET || '',
      templateNamespace: e.MSG91_TEMPLATE_NAMESPACE || '',
      timeoutMs: num(e.MSG91_TIMEOUT_MS, 10000),
      maxRetries: num(e.MSG91_MAX_RETRIES, 2)
    },
    // Multi-select: 'flow' (WhatsApp Flow CheckboxGroup) or 'list_loop' (native list, toggle + Continue)
    serviceFlowId,
    multiselectMode: e.MULTISELECT_MODE || (serviceFlowId ? 'flow' : 'list_loop'),
    flowDraftMode: bool(e.FLOW_DRAFT_MODE, false),
    internalApiKey: e.INTERNAL_API_KEY || '',
    paymentWebhookSecret: e.PAYMENT_WEBHOOK_SECRET || '',
    defaultCountryCode: e.DEFAULT_COUNTRY_CODE || '91',
    sessionTtlHours: num(e.SESSION_TTL_HOURS, 24),
    handoffTimeoutMinutes: num(e.HANDOFF_TIMEOUT_MINUTES, 240),
    maxInvalidInputs: num(e.MAX_INVALID_INPUTS, 3),
    supportHoursText: e.SUPPORT_HOURS_TEXT || '',
    notifyWebhookUrl: e.NOTIFY_WEBHOOK_URL || '',
    webhookEventTtlDays: num(e.WEBHOOK_EVENT_TTL_DAYS, 7),
    // Follow-up cadence is a business decision (spec "decisions required"): disabled unless explicitly set.
    followUpDelayHours: num(e.FOLLOWUP_DELAY_HOURS, 0),
    templateLanguage: e.TEMPLATE_LANGUAGE || 'en',
    templates: {
      enquiryFollowUp: e.TEMPLATE_ENQUIRY_FOLLOWUP || '',
      checkoutReminder: e.TEMPLATE_CHECKOUT_REMINDER || '',
      paymentConfirmation: e.TEMPLATE_PAYMENT_CONFIRMATION || '',
      ticketAck: e.TEMPLATE_TICKET_ACK || ''
    },
    owners: {
      sales: e.OWNER_SALES || null,
      support: e.OWNER_SUPPORT || null,
      finance: e.OWNER_FINANCE || null,
      partnerships: e.OWNER_PARTNERSHIPS || null
    }
  };
}

/** Returns names of required variables that are missing (used to fail fast in production). */
export function missingProductionConfig(env = getEnv()) {
  const missing = [];
  if (!env.msg91.authKey) missing.push('MSG91_AUTH_KEY');
  if (!env.msg91.integratedNumber) missing.push('MSG91_INTEGRATED_NUMBER');
  if (!env.msg91.webhookSecret) missing.push('MSG91_WEBHOOK_SECRET');
  if (!env.internalApiKey) missing.push('INTERNAL_API_KEY');
  if (!process.env.MONGODB_URI) missing.push('MONGODB_URI');
  return missing;
}
