/**
 * Service catalogue (defaults). The live source of truth is the `serviceConfigurations`
 * collection, seeded from this file ONLY for services that do not exist yet, so DutyLaunch
 * can edit names/URLs/prices/active flags without a deploy (PUT /services/:id).
 *
 * URLs and prices are intentionally null: the specification requires APPROVED values, which
 * must be supplied by DutyLaunch. Nothing here invents a price or URL.
 */
export const CATEGORIES = {
  CAREER_TOOL: 'career_tool',
  INFO: 'info',
  TRANSACTIONAL: 'transactional',
  BUSINESS: 'business',
  SUPPORT: 'support'
};

// Only these categories can be combined in the multi-select screen.
export const MULTI_SELECTABLE_CATEGORIES = [CATEGORIES.CAREER_TOOL];

const noPricing = () => ({
  approved: false, currency: null, amount: null, taxes: null,
  discountConditions: null, inclusions: [], checkoutUrl: null, terms: null
});

export const SERVICE_CATALOG = [
  { id: 'ai_resume_builder', name: 'AI Resume Builder', description: 'Create a professional ATS-friendly resume', category: CATEGORIES.CAREER_TOOL, order: 1 },
  { id: 'linkedin_optimization', name: 'LinkedIn Optimization', description: 'Make your profile clearer to recruiters', category: CATEGORIES.CAREER_TOOL, order: 2 },
  { id: 'cover_letter_generator', name: 'Cover Letter Generator', description: 'Cover letters tailored to the role', category: CATEGORIES.CAREER_TOOL, order: 3 },
  { id: 'interview_preparation', name: 'Interview Preparation', description: 'Structured practice and feedback', category: CATEGORIES.CAREER_TOOL, order: 4 },
  { id: 'jobs_career_guidance', name: 'Jobs & Career Guidance', description: 'Jobs, courses and career guidance', category: CATEGORIES.CAREER_TOOL, order: 5 },
  { id: 'plans_pricing', name: 'Plans & Pricing', description: 'Approved plans and checkout details', category: CATEGORIES.INFO, order: 6 },
  { id: 'existing_order_payment', name: 'Existing Order / Payment', description: 'Order, payment, refund or account help', category: CATEGORIES.TRANSACTIONAL, order: 7 },
  { id: 'partnership', name: 'Employer / Institute Partnership', description: 'Hiring, EdTech, training, recruitment partners', category: CATEGORIES.BUSINESS, order: 8 },
  { id: 'human_support', name: 'Talk to a Human', description: 'Speak with the DutyLaunch team', category: CATEGORIES.SUPPORT, order: 9 }
].map((s) => ({
  ...s,
  active: true,
  // Live status is deliberately false until DutyLaunch confirms it (spec section 15).
  live: false,
  url: null,
  pricing: noPricing()
}));

export const CAREER_TOOL_IDS = SERVICE_CATALOG.filter((s) => s.category === CATEGORIES.CAREER_TOOL).map((s) => s.id);
