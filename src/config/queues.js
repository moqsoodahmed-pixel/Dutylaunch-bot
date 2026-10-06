import { getEnv } from './env.js';

/** Ticket categories -> queue/ownership. Owners come from env (spec section 15: owners must be named by DutyLaunch). */
export function queueFor(category) {
  const { owners } = getEnv();
  const map = {
    career_services: { queue: 'sales', owner: owners.sales, priority: 'normal' },
    account_technical: { queue: 'support', owner: owners.support, priority: 'normal' },
    payment_refund: { queue: 'finance', owner: owners.finance, priority: 'high' },
    business_partnership: { queue: 'partnerships', owner: owners.partnerships, priority: 'normal' },
    order_payment: { queue: 'finance', owner: owners.finance, priority: 'high' },
    complaint: { queue: 'support', owner: owners.support, priority: 'high' },
    other: { queue: 'support', owner: owners.support, priority: 'normal' }
  };
  return map[category] || map.other;
}
