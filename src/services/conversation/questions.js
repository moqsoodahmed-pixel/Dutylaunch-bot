import { NAV, navSection, buttons, list } from './prompts.js';
import { cleanText, isEmail, isFreeEmailDomain, normalizeUrl, isLinkedInUrl, parseDate } from '../../utils/sanitize.js';

const yesNo = [{ id: 'yes', title: 'Yes' }, { id: 'no', title: 'No' }];
const has = (ctx, id) => ctx.services.has(id);
const anyCareer = (ctx) => ctx.services.size > 0;

const txt = (max = 200, min = 1) => (raw) => {
  const v = cleanText(raw, max);
  return v.length >= min ? { ok: true, value: v } : { ok: false, error: min > 1 ? `Please share a little more detail (at least ${min} characters).` : 'Please reply with some text.' };
};

export const EXPERIENCE_OPTIONS = [
  { id: 'fresher', title: 'Fresher / Graduate', description: 'Fresher / Recent Graduate' },
  { id: '1_3_years', title: '1–3 years' },
  { id: '3_7_years', title: '3–7 years' },
  { id: '7_plus_years', title: '7+ years' }
];

/**
 * Question registry. `phase` decides the conversation state; `when(ctx)` gates applicability dynamically.
 * Answers are stored under answers[id]; choice answers store the stable option id; null = skipped.
 */
export const QUESTIONS = {
  // ---------- shared career questions (asked ONCE, reused by every selected service) ----------
  resumeSegment: {
    phase: 'service', type: 'choice', label: 'Resume situation', when: (c) => has(c, 'ai_resume_builder'),
    prompt: 'What best describes you?',
    options: [
      { id: 'fresher', title: 'Fresher / Graduate', description: 'Fresher / Recent Graduate' },
      { id: 'experienced', title: 'Experienced Professional' },
      { id: 'career_change', title: 'Career Change' },
      { id: 'improve_existing', title: 'Improve My Resume', description: 'Improve My Existing Resume' }
    ],
    derive: (v, a) => {
      if (v === 'fresher' && a.experienceLevel === undefined) a.experienceLevel = 'fresher';
      if (v === 'improve_existing') a.hasExistingResume = 'yes';
    }
  },
  targetRole: {
    phase: 'service', type: 'text', label: 'Target role', when: anyCareer, parse: txt(120),
    prompt: 'What job role are you targeting? (for example: Software Engineer, Marketing Manager)'
  },
  experienceLevel: {
    phase: 'service', type: 'choice', label: 'Experience', options: EXPERIENCE_OPTIONS,
    when: (c) => anyCareer(c) && !(c.answers.resumeSegment === 'fresher' && c.answers.experienceLevel === 'fresher'),
    prompt: 'How much work experience do you have?'
  },
  targetIndustry: {
    phase: 'service', type: 'text', optional: true, label: 'Target industry', parse: txt(100),
    when: (c) => has(c, 'ai_resume_builder') || has(c, 'jobs_career_guidance'),
    prompt: 'Which industry are you targeting? (optional)'
  },
  // ---------- AI Resume Builder ----------
  hasExistingResume: {
    phase: 'service', type: 'choice', label: 'Has existing resume', options: yesNo,
    when: (c) => has(c, 'ai_resume_builder') && c.answers.resumeSegment !== 'improve_existing',
    prompt: 'Do you have an existing resume?'
  },
  resumeNextStep: {
    phase: 'service', type: 'choice', label: 'Resume next step', when: (c) => has(c, 'ai_resume_builder'),
    options: [{ id: 'online_tool', title: 'Use online tool' }, { id: 'callback', title: 'Request a callback' }],
    prompt: 'How would you like to continue with your resume?'
  },
  // ---------- LinkedIn ----------
  linkedinFocus: {
    phase: 'service', type: 'choice', label: 'LinkedIn focus', when: (c) => has(c, 'linkedin_optimization'),
    prompt: 'What would you like to improve on LinkedIn?',
    options: [
      { id: 'headline', title: 'LinkedIn headline' }, { id: 'about', title: 'About section' },
      { id: 'experience', title: 'Work experience' }, { id: 'full_profile', title: 'Complete profile' },
      { id: 'guidance', title: 'Guidance first' }
    ]
  },
  linkedinProfileUrl: {
    phase: 'service', type: 'text', optional: true, label: 'LinkedIn profile', when: (c) => has(c, 'linkedin_optimization'),
    prompt: 'Share your LinkedIn profile URL if you like (optional). Please never share your LinkedIn password or OTP.',
    parse: (raw) => {
      const u = normalizeUrl(raw);
      if (!u || !isLinkedInUrl(u)) return { ok: false, error: "That doesn't look like a LinkedIn profile link (for example linkedin.com/in/your-name). You can also tap Skip." };
      return { ok: true, value: u };
    }
  },
  // ---------- Cover letter ----------
  coverLetterType: {
    phase: 'service', type: 'choice', label: 'Cover letter need', when: (c) => has(c, 'cover_letter_generator'),
    prompt: 'What would you like to do with your cover letter?',
    options: [
      { id: 'new', title: 'Create a new letter' }, { id: 'tailor', title: 'Tailor to a job post' },
      { id: 'improve', title: 'Improve existing' }, { id: 'plans', title: 'Learn about plans' }
    ]
  },
  companyName: {
    phase: 'service', type: 'text', optional: true, label: 'Company', when: (c) => has(c, 'cover_letter_generator'), parse: txt(120),
    prompt: 'Which company are you applying to? (optional)'
  },
  jobDescriptionAvailable: {
    phase: 'service', type: 'choice', label: 'Job description available', options: yesNo, when: (c) => has(c, 'cover_letter_generator'),
    prompt: 'Do you have the job description?'
  },
  hasResume: {
    phase: 'service', type: 'choice', label: 'Has resume', options: yesNo,
    when: (c) => has(c, 'cover_letter_generator') && c.answers.hasExistingResume === undefined,
    prompt: 'Do you have a resume?'
  },
  // ---------- Interview preparation ----------
  interviewRound: {
    phase: 'service', type: 'choice', label: 'Interview type', when: (c) => has(c, 'interview_preparation'),
    prompt: 'What kind of interview are you preparing for?',
    options: [
      { id: 'hr', title: 'HR / Recruiter Round' }, { id: 'technical', title: 'Technical Interview' },
      { id: 'managerial', title: 'Managerial / Leadership' }, { id: 'behavioral', title: 'Behavioral Questions' },
      { id: 'mock', title: 'Mock Interview Practice' }, { id: 'tips', title: 'General Interview Tips' }
    ]
  },
  interviewDate: {
    phase: 'service', type: 'text', optional: true, label: 'Interview date', when: (c) => has(c, 'interview_preparation'),
    prompt: 'Do you have an interview date? Reply like 25/11/2026, or tap Skip.',
    parse: (raw) => { const d = parseDate(raw); return d ? { ok: true, value: d } : { ok: false, error: 'Please use a date like 25/11/2026 (DD/MM/YYYY), or tap Skip.' }; }
  },
  interviewTopics: {
    phase: 'service', type: 'text', optional: true, label: 'Topics to practise', when: (c) => has(c, 'interview_preparation'), parse: txt(300),
    prompt: 'Any topics you want to practise? (optional)'
  },
  // ---------- Jobs & career guidance ----------
  jobsRoute: {
    phase: 'service', type: 'choice', label: 'Looking for', when: (c) => has(c, 'jobs_career_guidance'),
    prompt: 'What are you looking for?',
    options: [
      { id: 'jobs_india', title: 'Jobs in India' }, { id: 'uae', title: 'UAE Opportunities' },
      { id: 'courses', title: 'Courses & Upskilling' }, { id: 'career_guidance', title: 'Career Guidance' },
      { id: 'early_access', title: 'Early Access List' }
    ]
  },
  preferredLocation: {
    phase: 'service', type: 'text', label: 'Preferred city/country', when: (c) => has(c, 'jobs_career_guidance'), parse: txt(100),
    prompt: 'Which city or country would you prefer to work in?'
  },
  skills: {
    phase: 'service', type: 'text', optional: true, label: 'Skills', when: (c) => has(c, 'jobs_career_guidance'), parse: txt(300),
    prompt: 'What are your key skills? (optional)'
  },
  employmentType: {
    phase: 'service', type: 'choice', label: 'Employment type', when: (c) => has(c, 'jobs_career_guidance'),
    prompt: 'What type of employment are you looking for?',
    options: [{ id: 'full_time', title: 'Full-time' }, { id: 'part_time', title: 'Part-time' }, { id: 'contract', title: 'Contract' }, { id: 'internship', title: 'Internship' }]
  },
  // ---------- contact details (shared by career + partnership) ----------
  contactName: {
    phase: 'contact', type: 'text', label: 'Name', parse: txt(80, 2),
    prompt: 'May I have your name?'
  },
  email: {
    phase: 'contact', type: 'text', optional: true, label: 'Email',
    prompt: 'Your email address, if you would like the team to reach you there (optional).',
    parse: (raw) => { const e = cleanText(raw, 254).toLowerCase(); return isEmail(e) ? { ok: true, value: e } : { ok: false, error: "That email doesn't look right. Please check it, or tap Skip." }; }
  },
  marketingConsent: {
    phase: 'contact', type: 'choice', label: 'Updates', options: [{ id: 'yes', title: 'Yes, keep me posted' }, { id: 'no', title: 'No, thanks' }],
    // NOTE: wording must be approved by DutyLaunch (spec section 15).
    prompt: 'Would you also like occasional updates about DutyLaunch offers on WhatsApp? You can reply STOP at any time. This is optional and does not affect your request.'
  },
  // ---------- existing order / payment ----------
  orderId: {
    phase: 'order', type: 'text', optional: true, label: 'Order ID', parse: txt(64),
    prompt: 'Please share your Order ID (or tap Skip if you do not have one).'
  },
  orderContact: {
    phase: 'order', type: 'text', label: 'Registered email/phone',
    prompt: 'What email or phone number is registered with DutyLaunch?',
    parse: (raw) => {
      const v = cleanText(raw, 254).toLowerCase();
      if (isEmail(v) || v.replace(/\D/g, '').length >= 7) return { ok: true, value: v };
      return { ok: false, error: 'Please send the registered email address or phone number.' };
    }
  },
  orderDescription: {
    phase: 'order', type: 'text', label: 'Description', parse: txt(500, 5),
    prompt: 'Briefly describe the issue. (Please do not include passwords, OTPs, PINs or card details.)'
  },
  // ---------- partnership ----------
  orgName: { phase: 'partnership', type: 'text', label: 'Organization', parse: txt(120, 2), prompt: 'What is your organization called?' },
  workEmail: {
    phase: 'partnership', type: 'text', label: 'Work email',
    prompt: 'What is your official work email?',
    parse: (raw) => {
      const e = cleanText(raw, 254).toLowerCase();
      if (!isEmail(e)) return { ok: false, error: 'Please send a valid work email address.' };
      return { ok: true, value: e, flags: { freeDomain: isFreeEmailDomain(e) } };
    }
  },
  website: {
    phase: 'partnership', type: 'text', optional: true, label: 'Website', prompt: 'Your organization website (optional).',
    parse: (raw) => { const u = normalizeUrl(raw); return u ? { ok: true, value: u } : { ok: false, error: "That doesn't look like a website address. Please check it, or tap Skip." }; }
  },
  volume: { phase: 'partnership', type: 'text', optional: true, label: 'Hiring / learner volume', parse: txt(100), prompt: 'Roughly how many hires or learners are you thinking about? (optional)' },
  requirement: { phase: 'partnership', type: 'text', label: 'Requirement', parse: txt(500, 5), prompt: 'Please describe your requirement in a few words.' }
};

const SERVICE_ORDER = ['resumeSegment', 'targetRole', 'experienceLevel', 'targetIndustry', 'hasExistingResume', 'resumeNextStep', 'linkedinFocus', 'linkedinProfileUrl', 'coverLetterType', 'companyName', 'jobDescriptionAvailable', 'hasResume', 'interviewRound', 'interviewDate', 'interviewTopics', 'jobsRoute', 'preferredLocation', 'skills', 'employmentType'];
const CONTACT_ORDER = ['contactName', 'email', 'marketingConsent'];

/** Builds the ordered question queue for a career flow. Questions already answered are not asked again. */
export function buildCareerQueue({ answers, contact }) {
  const q = [...SERVICE_ORDER, ...CONTACT_ORDER].filter((id) => answers[id] === undefined);
  return q.filter((id) => !(id === 'contactName' && contact.name) && !(id === 'email' && contact.email) && !(id === 'marketingConsent' && (contact.consentTimestamp || contact.optOutTimestamp)));
}
export const buildOrderQueue = () => ['orderId', 'orderContact', 'orderDescription'];
export const buildPartnershipQueue = ({ contact }) => [...(contact.name ? [] : ['contactName']), 'orgName', 'workEmail', 'website', 'volume', 'requirement'];

export function questionContext({ conv, contact }) {
  return { answers: conv.answers || {}, services: new Set(conv.selectedServices || []), contact };
}

/** Finds the next applicable question index from `start`, stepping by `step` (+1/-1). Returns -1 / queue.length when none. */
export function seek(conv, contact, start, step) {
  const ctx = questionContext({ conv, contact });
  const q = conv.questionQueue;
  for (let i = start; i >= 0 && i < q.length; i += step) {
    const def = QUESTIONS[q[i]];
    if (def && (!def.when || def.when(ctx))) return i;
  }
  return step > 0 ? q.length : -1;
}

/** Option reply IDs are namespaced per question ("q:<questionId>:<optionId>") so stale taps can't answer the wrong question. */
export const optionReplyId = (qid, optId) => `q:${qid}:${optId}`;

/** Renders a question as native buttons/list. Text questions get Back (and Skip if optional) buttons. */
export function renderQuestion(def, qid) {
  const withIds = (opts) => opts.map((o) => ({ ...o, id: optionReplyId(qid, o.id) }));
  if (def.type === 'text') {
    const b = def.optional ? [{ id: 'skip', title: 'Skip' }, NAV.back] : [NAV.back];
    return buttons(def.prompt, b);
  }
  if (def.options.length <= 2) return buttons(def.prompt, [...withIds(def.options).map((o) => ({ id: o.id, title: o.title })), NAV.back]);
  return list(def.prompt, [{ title: 'Options', rows: withIds(def.options) }, navSection(NAV.back, NAV.menu)]);
}

export function optionTitle(def, id) {
  return def?.options?.find((o) => o.id === id)?.title || id;
}
