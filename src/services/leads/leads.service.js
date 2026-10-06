import { Lead } from '../../models/index.js';
import { leadId as newLeadId } from '../../utils/ids.js';
import { listServices } from '../catalog/catalog.service.js';
import { cleanText } from '../../utils/sanitize.js';

const OPEN = ['new', 'contacted', 'qualified'];
const MERGE_WINDOW_MS = 30 * 86400000;

/**
 * Creates or updates ONE lead. Resolution order:
 *  1. same conversation + intent  (idempotent re-submits)
 *  2. the contact's open lead with the same intent in the last 30 days (merge; service interests are unioned)
 *  3. create a new lead
 * Service IDs are stored, never display names.
 */
export async function upsertLead({ contactId, conversationId, intent, serviceIds = [], fields = {}, details = {}, qualified = false, assignedOwner, nextAction, source, now = new Date() }) {
  const ids = [...new Set(serviceIds.map(String))];
  const $set = { lastInteractionAt: now };
  for (const k of ['targetRole', 'experienceLevel', 'preferredLocation', 'customerType']) if (fields[k]) $set[k] = cleanText(fields[k], 120);
  if (qualified) { $set.qualified = true; $set.leadStatus = 'qualified'; }
  if (nextAction) $set.nextAction = nextAction;
  if (assignedOwner) $set.assignedOwner = assignedOwner;
  if (source) $set.source = source;
  for (const [k, v] of Object.entries(details)) if (v !== undefined && v !== null && v !== '') $set[`details.${k}`] = v;

  const addToSet = ids.length ? { serviceInterest: { $each: ids }, selectedServices: { $each: ids } } : undefined;
  const update = addToSet ? { $set, $addToSet: addToSet } : { $set };

  const findExisting = async () => {
    let l = await Lead.findOne({ conversationId, intent });
    if (!l) l = await Lead.findOne({ contactId, intent, leadStatus: { $in: OPEN }, updatedAt: { $gte: new Date(now.getTime() - MERGE_WINDOW_MS) } }).sort({ updatedAt: -1 });
    return l;
  };

  let existing = await findExisting();
  if (existing) {
    // Never downgrade a 'qualified' lead's status via a later non-qualified merge.
    await Lead.updateOne({ _id: existing._id }, update);
    return { lead: await Lead.findById(existing._id).lean(), created: false };
  }
  try {
    const doc = await Lead.create({
      leadId: newLeadId(), contactId, conversationId, intent, serviceInterest: ids, selectedServices: ids,
      leadStatus: qualified ? 'qualified' : 'new', qualified, lastInteractionAt: now,
      ...Object.fromEntries(Object.entries($set).filter(([k]) => !k.startsWith('details.') && !['lastInteractionAt', 'qualified', 'leadStatus'].includes(k))),
      details: Object.fromEntries(Object.entries(details).filter(([, v]) => v !== undefined && v !== null && v !== ''))
    });
    return { lead: doc.toObject(), created: true };
  } catch (e) {
    if (e?.code !== 11000) throw e;
    existing = await findExisting();
    await Lead.updateOne({ _id: existing._id }, update);
    return { lead: await Lead.findById(existing._id).lean(), created: false };
  }
}

/** Validates service IDs against the active catalogue (used by POST /leads). */
export async function validateServiceIds(ids) {
  const known = new Set((await listServices({ activeOnly: false })).map((s) => s.id));
  const bad = ids.filter((i) => !known.has(i));
  return { ok: bad.length === 0, bad };
}
