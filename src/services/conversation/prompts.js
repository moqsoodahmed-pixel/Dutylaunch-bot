/** Prompt-spec builders + approved message copy (from the DutyLaunch specification, section 5). */
export const text = (body) => ({ kind: 'text', body });
export const buttons = (body, btns, extra = {}) => ({ kind: 'buttons', body, buttons: btns, ...extra });
export const list = (body, sections, extra = {}) => ({ kind: 'list', body, button: 'Choose', sections, ...extra });

export const NAV = {
  back: { id: 'cmd_back', title: '⬅ Back' },
  menu: { id: 'cmd_menu', title: '🏠 Main Menu' },
  startOver: { id: 'cmd_start_over', title: '🔄 Start Over' },
  human: { id: 'cmd_human', title: '👤 Talk to a Human' }
};
export const navSection = (...items) => ({ title: 'Navigation', rows: items });

export const welcomeText = (firstName) =>
  `Hi ${firstName || 'there'}! 👋 Welcome to *DutyLaunch* — your career growth companion.\n\nI can help you create a professional resume, improve your LinkedIn profile, prepare for interviews, explore career opportunities and get support.\n\n*What would you like help with today?*`;

export const welcomeBackText = (firstName) => `Welcome back${firstName ? `, ${firstName}` : ''}! 👋 *What would you like help with today?*`;

export const welcomeSpec = (body) => buttons(body, [
  { id: 'welcome_resume', title: 'Build My Resume' },
  { id: 'welcome_jobs', title: 'Jobs & Career Growth' },
  { id: 'welcome_other', title: 'Services & Support' }
]);

export const mainMenuSpec = () => list('What would you like help with?', [
  {
    title: 'DutyLaunch',
    rows: [
      { id: 'menu_select_services', title: 'Choose Career Services', description: 'Pick one or more: resume, LinkedIn, cover letter, interview, jobs' },
      { id: 'menu_pricing', title: 'Plans & Pricing', description: 'Approved plans and checkout details' },
      { id: 'menu_order', title: 'Existing Order / Payment', description: 'Activation, payment, refund or account issues' },
      { id: 'menu_partnership', title: 'Partnership Enquiry', description: 'Employer / Institute Partnership' },
      { id: 'cmd_human', title: 'Talk to a Human', description: 'Create a support ticket' }
    ]
  },
  navSection(NAV.startOver)
], { button: 'Main menu', header: 'DutyLaunch' });

export const INTROS = {
  ai_resume_builder: 'Great choice! 📄 DutyLaunch can help you create a professional, ATS-friendly resume tailored to your experience and target role.',
  linkedin_optimization: 'Want to make your professional profile clearer to recruiters? 🚀',
  cover_letter_generator: "Let's help you prepare a cover letter tailored to the role you're applying for. ✍️",
  interview_preparation: 'Prepare for your next interview with structured practice and feedback. 🎯',
  jobs_career_guidance: "Let's understand what opportunity you're looking for. 💼"
};

export const PRICING_INTRO = 'We can help you choose the right DutyLaunch tools for your career goals. 😊';
export const ORDER_INTRO = "We're here to help with your DutyLaunch order. Please select the issue that best matches:";
export const PARTNERSHIP_INTRO = 'Thank you for your interest in partnering with DutyLaunch! 🤝';
export const HANDOFF_INTRO = 'Of course! Our team can help you further. 😊\nWhat is this about?';
export const SECURITY_NOTE = "For your security, please don't share passwords, OTPs, PINs or card security details in this chat.";

export const ORDER_ISSUES = [
  { id: 'payment_success_not_activated', title: 'Paid, not activated', description: 'Payment successful, service not activated', category: 'order_payment' },
  { id: 'payment_failed_pending', title: 'Payment failed/pending', description: 'Payment failed or still pending', category: 'order_payment' },
  { id: 'refund_request', title: 'Refund request', description: 'Request a refund', category: 'payment_refund' },
  { id: 'account_access', title: 'Account access issue', description: "Can't access your account", category: 'account_technical' },
  { id: 'career_tool_issue', title: 'Career tool issue', description: 'A DutyLaunch tool is not working', category: 'account_technical' },
  { id: 'other_issue', title: 'Other issue', description: 'Something else about an order', category: 'other' }
];

export const PARTNERSHIP_TYPES = [
  { id: 'company_hiring', title: 'Company hiring', description: 'Hiring candidates', customerType: 'employer' },
  { id: 'edtech_institution', title: 'Education / EdTech', description: 'Education / EdTech institution', customerType: 'institute' },
  { id: 'corporate_training', title: 'Corporate training', description: 'Corporate training', customerType: 'corporate_training' },
  { id: 'recruitment_partner', title: 'Recruitment partner', description: 'Recruitment partnership', customerType: 'recruiter' },
  { id: 'other_business', title: 'Other business enquiry', description: 'Something else', customerType: 'other' }
];

export const HANDOFF_CATEGORIES = [
  { id: 'career_services', title: 'Career services', description: 'Resume, LinkedIn, interview and more' },
  { id: 'account_technical', title: 'Account / technical', description: 'Account or technical issue' },
  { id: 'payment_refund', title: 'Payment / refund', description: 'Payment or refund' },
  { id: 'business_partnership', title: 'Business partnership', description: 'Employer / institute partnership' },
  { id: 'other', title: 'Other', description: 'Anything else' }
];

export const PRICING_OPTIONS = [
  { id: 'price_ai_resume_builder', title: 'Resume', description: 'Resume creation / optimization', serviceId: 'ai_resume_builder' },
  { id: 'price_linkedin_optimization', title: 'LinkedIn profile', description: 'LinkedIn optimization', serviceId: 'linkedin_optimization' },
  { id: 'price_cover_letter_generator', title: 'Cover letter', description: 'Cover letter generator', serviceId: 'cover_letter_generator' },
  { id: 'price_interview_preparation', title: 'Interview preparation', description: 'Interview practice', serviceId: 'interview_preparation' },
  { id: 'price_multi', title: 'Multiple tools', description: 'Compare all approved plans' },
  { id: 'price_help', title: 'Help choosing', description: 'Pick the tools you need' }
];

export function ticketAckText({ firstName, ticketId, categoryLabel, supportHours }) {
  return `Hi ${firstName || 'there'}, we've received your request (Ticket ${ticketId}).\nCategory: ${categoryLabel}\n\nOur team will review your request and respond according to our published support hours.${supportHours ? `\nSupport hours: ${supportHours}` : ''}\n\n${SECURITY_NOTE}`;
}

export function formatPricing(service) {
  const p = service.pricing || {};
  if (!p.approved || p.amount === null || p.amount === undefined) {
    return `Approved pricing for *${service.name}* isn't published in this chat yet. Our team can share current plans.`;
  }
  const lines = [`*${service.name}*`, `Price: ${p.currency ? p.currency + ' ' : ''}${p.amount}`];
  if (p.taxes) lines.push(`Taxes: ${p.taxes}`);
  if (p.discountConditions) lines.push(`Discounts: ${p.discountConditions}`);
  if (p.inclusions?.length) lines.push('Includes:', ...p.inclusions.map((i) => `• ${i}`));
  if (p.checkoutUrl) lines.push(`Checkout: ${p.checkoutUrl}`);
  if (p.terms) lines.push(`Terms: ${p.terms}`);
  return lines.join('\n');
}
