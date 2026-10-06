import { ServiceConfiguration } from '../../models/index.js';
import { SERVICE_CATALOG, MULTI_SELECTABLE_CATEGORIES } from '../../config/services.js';
import { cleanText, normalizeUrl } from '../../utils/sanitize.js';

/** Insert any missing default services. Never overwrites edits made by DutyLaunch. */
export async function seedServices() {
  for (const s of SERVICE_CATALOG) {
    await ServiceConfiguration.updateOne({ serviceId: s.id }, {
      $setOnInsert: {
        serviceId: s.id, name: s.name, description: s.description, category: s.category,
        order: s.order, active: s.active, live: s.live, url: s.url, pricing: s.pricing
      }
    }, { upsert: true });
  }
}

const toPlain = (d) => ({
  id: d.serviceId, name: d.name, description: d.description, category: d.category, order: d.order,
  active: d.active,
  // A service only counts as live if it is flagged live AND has a configured URL.
  live: Boolean(d.live && d.url), url: d.url || null, pricing: d.pricing || { approved: false }
});

export async function listServices({ activeOnly = true } = {}) {
  const docs = await ServiceConfiguration.find(activeOnly ? { active: true } : {}).sort({ order: 1 }).lean();
  if (!docs.length) {
    return SERVICE_CATALOG.filter((s) => !activeOnly || s.active).map((s) => ({ ...s, live: false, url: null }));
  }
  return docs.map(toPlain);
}

export async function getService(id) {
  const d = await ServiceConfiguration.findOne({ serviceId: String(id) }).lean();
  if (d) return toPlain(d);
  const s = SERVICE_CATALOG.find((x) => x.id === id);
  return s ? { ...s, live: false, url: null } : null;
}

/** Services that may appear in the multi-select screen. */
export async function listSelectable() {
  return (await listServices({ activeOnly: true })).filter((s) => MULTI_SELECTABLE_CATEGORIES.includes(s.category));
}

export async function updateService(id, patch) {
  const set = {};
  if (patch.name !== undefined) set.name = cleanText(patch.name, 80);
  if (patch.description !== undefined) set.description = cleanText(patch.description, 200);
  if (patch.active !== undefined) set.active = Boolean(patch.active);
  if (patch.live !== undefined) set.live = Boolean(patch.live);
  if (patch.url !== undefined) {
    if (patch.url === null || patch.url === '') set.url = null;
    else { const u = normalizeUrl(patch.url); if (!u) throw Object.assign(new Error('invalid url'), { status: 400 }); set.url = u; }
  }
  if (patch.pricing && typeof patch.pricing === 'object') {
    const p = patch.pricing;
    if (p.approved !== undefined) set['pricing.approved'] = Boolean(p.approved);
    for (const k of ['currency', 'taxes', 'discountConditions', 'terms']) if (p[k] !== undefined) set[`pricing.${k}`] = p[k] === null ? null : cleanText(p[k], 500);
    if (p.amount !== undefined) { const n = Number(p.amount); if (!Number.isFinite(n) || n < 0) throw Object.assign(new Error('invalid amount'), { status: 400 }); set['pricing.amount'] = n; }
    if (p.inclusions !== undefined) set['pricing.inclusions'] = (Array.isArray(p.inclusions) ? p.inclusions : []).map((x) => cleanText(x, 200)).filter(Boolean).slice(0, 20);
    if (p.checkoutUrl !== undefined) {
      if (p.checkoutUrl === null || p.checkoutUrl === '') set['pricing.checkoutUrl'] = null;
      else { const u = normalizeUrl(p.checkoutUrl); if (!u) throw Object.assign(new Error('invalid checkoutUrl'), { status: 400 }); set['pricing.checkoutUrl'] = u; }
    }
  }
  const res = await ServiceConfiguration.findOneAndUpdate({ serviceId: String(id) }, { $set: set }, { new: true }).lean();
  return res ? toPlain(res) : null;
}
