# QA checklist (mapped to the specification)

Status legend: ✅ automated test exists · ⚠️ implemented, not exercised against real MSG91/WhatsApp · ❌ not built.

| Spec item | Status | Where |
| --- | --- | --- |
| Welcome message + 3 buttons (approved copy) | ✅ | `journeys.test.js` #1 |
| Main menu (list, 5 options + Start Over) | ✅ | `journeys.test.js` #1, #17 |
| Multi-select career services, no typing | ✅ (list fallback) / ⚠️ (Flow) | `multiselect.test.js`, `flowmode.test.js` |
| One lead per multi-service selection, IDs not names | ✅ | `multiselect.test.js`, `flowmode.test.js` |
| Shared questions asked once, reused | ✅ | `multiselect.test.js` (asks "target role" exactly once) |
| Resume / LinkedIn / Cover Letter / Interview / Jobs flows | ✅ | `journeys.test.js` #6–#10 |
| Pricing: never invented, shown once approved | ✅ | `journeys.test.js` #11 |
| Existing order/payment lookup, server-verified | ✅ | `journeys.test.js` #12, #12b |
| Payment/refund routing | ✅ | `journeys.test.js` #13, #14 |
| Never asks for OTP/PIN/CVV/password; rejects if sent | ✅ | `journeys.test.js` #14, #14b |
| Partnership enquiry | ✅ | `journeys.test.js` (partnership test) |
| Human handoff: ticket + bot pause + resume | ✅ | `journeys.test.js` #15 |
| STOP honoured even during handoff | ✅ | `journeys.test.js` #15b |
| BACK / MENU / START OVER / STOP | ✅ | `journeys.test.js` #16–#19 |
| Fallback handling + escalation after repeated failures | ✅ | `journeys.test.js` (fallback test) |
| Idempotent webhook (duplicate + concurrent delivery) | ✅ | `resilience.test.js` #20, #20b |
| MSG91 send failure: no data loss, resend on recovery | ✅ | `resilience.test.js` #21, #21b |
| MongoDB failure: 503 at idempotency gate, retry-safe mid-processing | ✅ | `resilience.test.js` #22, #22b, #22c |
| Invalid payloads rejected safely | ✅ | `resilience.test.js` #23 |
| Webhook authenticity (shared secret + optional HMAC) | ✅ | `resilience.test.js` #23b, #23c |
| Expired session handling | ✅ | `resilience.test.js` #24 |
| Concurrent events (one user, many users) | ✅ | `resilience.test.js` #25, #25b, #25c |
| Structured logging without secrets | ✅ | `msg91.test.js` (logs never contain the auth key) |
| Analytics events + summary | ✅ | `api.test.js` (analytics summary test) |
| Internal API endpoints (contacts/leads/orders/tickets/send/services) | ✅ | `api.test.js` |
| Payment webhook idempotency, no-downgrade, single confirmation | ✅ | `api.test.js` (payment event tests) |
| Follow-up automation (small, approved cadence, opt-in only) | ✅ | `followup.test.js` |
| Marketing opt-in/opt-out policy enforcement | ✅ | `journeys.test.js` #19, `api.test.js` |
| WhatsApp Flow actually sends via MSG91 in production | ⚠️ | unverified — see README |
| Real MSG91 webhook payload shape confirmed | ⚠️ | unverified — see `docs/WEBHOOK_PAYLOADS.md` |
| Tests run against real MongoDB (not FerretDB) | ⚠️ | see README caveat |
| Real-number end-to-end test performed | ⚠️ | not performed during this build |
| Optional admin dashboard (React/Vite) | ❌ | not built (optional in the brief) |

## Manual pass still required before go-live

1. Re-run `npm test` against real MongoDB.
2. Complete the real-number test in the README.
3. Confirm the MSG91 inbound webhook shape (`docs/WEBHOOK_PAYLOADS.md`) and adjust the normaliser if needed.
4. Confirm WhatsApp Flow sending with MSG91 support, or deliberately run with `MULTISELECT_MODE=list_loop`.
5. Have DutyLaunch review the approved copy in `src/services/conversation/prompts.js` and
   `src/services/conversation/questions.js` one more time against the specification's section 5, since this
   build transcribed it but a final human proofread is worthwhile before launch.
6. Fill in the configuration values listed in the README's "Configuration you must supply" section.
