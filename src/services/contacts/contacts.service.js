import { Contact, Consent } from '../../models/index.js';
import { getEnv } from '../../config/env.js';
import { newId } from '../../utils/ids.js';
import { cleanText, isEmail } from '../../utils/sanitize.js';
import { normalizePhone } from '../../utils/phone.js';

function attributionFrom(referral) {
  if (!referral || typeof referral !== 'object') return { source: 'whatsapp_direct' };
  return {
    source: 'whatsapp_referral',
    landingPage: cleanText(referral.source_url, 300) || undefined,
    campaignReferralId: cleanText(referral.ctwa_clid || referral.source_id, 120) || undefined
  };
}

/** Finds or creates the single contact for a number; never creates duplicates (unique index + dup-key recovery). */
export async function upsertFromInbound({ number, profileName, referral, now = new Date() }) {
  const n = normalizePhone(number, getEnv().defaultCountryCode);
  if (!n) throw Object.assign(new Error('invalid whatsapp number'), { status: 400 });
  let contact = await Contact.findOne({ normalizedWhatsappNumber: n });
  let isNew = false;
  if (!contact) {
    try {
      contact = await Contact.create({ contactId: newId(), normalizedWhatsappNumber: n, profileName: cleanText(profileName, 80) || undefined, lastInboundAt: now, ...attributionFrom(referral) });
      isNew = true;
    } catch (e) {
      if (e?.code !== 11000) throw e;
      contact = await Contact.findOne({ normalizedWhatsappNumber: n });
    }
  }
  if (!isNew) {
    const set = { lastInboundAt: now };
    if (profileName) set.profileName = cleanText(profileName, 80);
    await Contact.updateOne({ _id: contact._id }, { $set: set });
    contact.lastInboundAt = now;
    if (set.profileName) contact.profileName = set.profileName;
  }
  return { contact, isNew };
}

/** API upsert (POST /contacts/upsert). Consent changes require an explicit source. */
export async function upsertContact(input) {
  const n = normalizePhone(input.whatsappNumber, getEnv().defaultCountryCode);
  if (!n) throw Object.assign(new Error('whatsappNumber is invalid'), { status: 400 });
  if (input.email !== undefined && input.email !== null && !isEmail(input.email)) throw Object.assign(new Error('email is invalid'), { status: 400 });
  if (input.marketingOptIn !== undefined && typeof input.marketingOptIn !== 'boolean') throw Object.assign(new Error('marketingOptIn must be boolean'), { status: 400 });
  if (input.marketingOptIn !== undefined && !cleanText(input.consentSource, 100)) throw Object.assign(new Error('consentSource is required when changing marketing consent'), { status: 400 });

  let contact = await Contact.findOne({ normalizedWhatsappNumber: n });
  if (!contact) {
    try { contact = await Contact.create({ contactId: newId(), normalizedWhatsappNumber: n }); }
    catch (e) { if (e?.code !== 11000) throw e; contact = await Contact.findOne({ normalizedWhatsappNumber: n }); }
  }
  const set = {};
  if (input.name) set.name = cleanText(input.name, 80);
  if (input.email) set.email = input.email.toLowerCase();
  if (input.source) set.source = cleanText(input.source, 60);
  if (input.landingPage) set.landingPage = cleanText(input.landingPage, 300);
  if (input.campaignReferralId) set.campaignReferralId = cleanText(input.campaignReferralId, 120);
  if (Object.keys(set).length) await Contact.updateOne({ _id: contact._id }, { $set: set });
  if (input.marketingOptIn === true) await recordConsent(contact, { action: 'opt_in', source: cleanText(input.consentSource, 100) });
  if (input.marketingOptIn === false) await recordConsent(contact, { action: 'opt_out', source: cleanText(input.consentSource, 100) });
  return Contact.findOne({ _id: contact._id }).lean();
}

export async function setContactFields(contactId, fields) {
  const set = {};
  if (fields.name) set.name = cleanText(fields.name, 80);
  if (fields.email) set.email = String(fields.email).toLowerCase();
  if (Object.keys(set).length) await Contact.updateOne({ contactId }, { $set: set });
}

/** Records marketing consent changes both on the contact and in the append-only consents collection. */
export async function recordConsent(contact, { action, source, conversationId = null, now = new Date() }) {
  await Consent.create({ contactId: contact.contactId, conversationId, type: 'marketing', action, source, timestamp: now });
  const set = action === 'opt_in'
    ? { marketingOptIn: true, consentTimestamp: now, consentSource: source, optOutTimestamp: null }
    : { marketingOptIn: false, optOutTimestamp: now };
  await Contact.updateOne({ _id: contact._id }, { $set: set });
  Object.assign(contact, set);
  return contact;
}
