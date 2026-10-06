# DutyLaunch WhatsApp Bot

A production-oriented WhatsApp bot for DutyLaunch, built on Node.js/Express, MongoDB/Mongoose and MSG91's
WhatsApp API. Plain JavaScript (ES modules) throughout — no TypeScript, no NestJS, no SQL, no Firebase/Supabase.

The conversation engine is a deterministic state machine. No AI is involved: every reply is either approved
copy from the specification or data read from configuration / the database. This keeps behaviour auditable
and means prices, URLs and service names are never invented — see [Configuration you must supply](#configuration-you-must-supply).

## Contents

- [What's implemented](#whats-implemented)
- [Project layout](#project-layout)
- [Multi-select: WhatsApp Flow vs. native list fallback](#multi-select-whatsapp-flow-vs-native-list-fallback) — **read this before going live**
- [Run locally](#run-locally)
- [Test](#test)
- [Configure the MSG91 webhook](#configure-the-msg91-webhook)
- [Create and publish the WhatsApp Flow](#create-and-publish-the-whatsapp-flow)
- [Test with a real WhatsApp number](#test-with-a-real-whatsapp-number)
- [Environment variables](#environment-variables)
- [Configuration you must supply](#configuration-you-must-supply)
- [Production deployment](#production-deployment)
- [Known limitations / unverified assumptions](#known-limitations--unverified-assumptions)

## What's implemented

- Native WhatsApp multi-select for career services (resume, LinkedIn, cover letter, interview prep, jobs/career
  guidance) — via a WhatsApp Flow `CheckboxGroup` when configured, with an automatic fallback to a tick-list +
  Continue UI. The user never types numbers or comma-separated lists.
- One conversation, one lead per multi-service selection. Shared questions (target role, experience, etc.) are
  asked once and reused across every selected service.
- Stable service IDs stored on the lead (`ai_resume_builder`, `linkedin_optimization`, ...) — never display names.
- BACK / MENU / START OVER / STOP / SUPPORT / HUMAN, exactly as in the specification's Appendix B, both as typed
  keywords and as buttons.
- Human handoff: creates a ticket, pauses the bot for that conversation (STOP is still always honoured), and
  resumes the bot when the ticket is released or the handoff times out.
- Idempotent webhook processing (safe against MSG91 redelivery and concurrent delivery of the same event),
  per-number serialisation (concurrent taps from one user never corrupt state), retry sweepers for failed
  sends and failed webhook processing, and session expiry.
- Existing order / payment lookup that verifies the requester's WhatsApp number against the order before
  revealing anything.
- Payment confirmation webhook (`POST /events/payment`) that is idempotent, cannot downgrade a paid order, and
  sends the confirmation template at most once.
- Structured logging (pino) that redacts the MSG91 auth key and other secrets.
- Analytics events and a queryable summary endpoint.
- Sensitive-data guard: OTPs, PINs, CVVs, passwords and card numbers typed into free-text answers are detected
  and rejected rather than stored.
- 88 automated tests (unit + integration) — see [Test](#test).

No pseudo-code or `TODO`s were left in the code. Anything left open (prices, URLs, templates, the Flow ID,
support hours, queue owners) is a **configuration value**, not a missing code path — see
[Configuration you must supply](#configuration-you-must-supply).

## Project layout

```
src/
  config/        env.js (reads process.env), services.js (the 9-service catalogue), queues.js (ticket routing)
  models/        Mongoose schemas: Contact, Conversation, Lead, SupportTicket, WebhookEvent, MessageLog,
                 Order, ServiceConfiguration, Consent, AnalyticsEvent
  services/
    msg91/       MSG91 HTTP client + WhatsApp message builders (text, buttons, list, flow, template) + inbound normaliser
    conversation/ the state machine (engine.js), approved copy (prompts.js), question registry (questions.js)
    catalog/ contacts/ leads/ orders/ support/ analytics/ messaging/ events/   domain services
  middleware/    webhook/internal/payment auth, rate limiting, error handling
  controllers/ routes/   the HTTP layer
  jobs/          background sweepers (webhook retry, resend, session expiry, follow-up)
  container.js   composition root (wires everything; swappable for tests)
  app.js         builds the Express app
  server.js      connects Mongo, seeds services, starts the app and the jobs
flows/           the WhatsApp Flow JSON (CheckboxGroup multi-select)
scripts/         seedServices.js
tests/           unit/ + integration/ (Node's built-in test runner)
docs/            this file's companions: DEPLOYMENT.md, FLOW.md, WEBHOOK_PAYLOADS.md, QA_CHECKLIST.md
```

## Multi-select: WhatsApp Flow vs. native list fallback

**This is the one thing to verify before go-live.**

MSG91's public API documentation (checked while building this) documents text, button, list, product and
location-request interactive messages on `POST /api/v5/whatsapp/whatsapp-outbound-message/`. It does **not**
document sending a WhatsApp Flow. I could not confirm, from MSG91's docs or three searches, whether Flow
sending is supported for your account.

So the bot does this:

1. If `MSG91_SERVICE_FLOW_ID` is set, it sends a WhatsApp Flow (`interactive.type: "flow"`, the standard Meta
   Cloud API shape) through the same MSG91 endpoint, with a `CheckboxGroup` screen (see
   [flows/service-selection.flow.json](flows/service-selection.flow.json)).
2. If that send is rejected by MSG91 (or if no Flow ID is configured), the bot automatically uses a **native
   list-based multi-select**: each service is a list row the user taps to tick (☑) or untick (☐); a
   "➡ Continue" row submits the current selection. This is genuinely multi-select and never asks the user to
   type numbers — but it is one tap per toggle rather than one screen with checkboxes.

Both paths are covered by tests (`tests/integration/flowmode.test.js`, `tests/integration/multiselect.test.js`).
The list fallback is the **verified-reliable path**; the Flow path is **unverified** until you confirm it with
MSG91 support and test it against a real number. Set `MULTISELECT_MODE=list_loop` to force the reliable path
regardless of `MSG91_SERVICE_FLOW_ID` while you're confirming Flow support.

## Run locally

Requirements: Node.js 20+, a MongoDB instance (real MongoDB — not FerretDB, see
[Known limitations](#known-limitations--unverified-assumptions)), an MSG91 account with WhatsApp enabled.

```bash
cp .env.example .env
# edit .env — at minimum MONGODB_URI, MSG91_AUTH_KEY, MSG91_INTEGRATED_NUMBER, MSG91_WEBHOOK_SECRET, INTERNAL_API_KEY
npm install
npm run seed      # inserts the 9 default services (no URLs, no pricing) if they don't already exist
npm run dev        # or: npm start
```

The server starts on `PORT` (default 3000) and logs `"DutyLaunch bot listening"` once MongoDB is connected and
indexes are ensured. `GET /health` reports `{ status, db, msg91Configured, multiselectMode }`.

In development (`NODE_ENV` not `production`), the webhook endpoint will accept requests even with no
`MSG91_WEBHOOK_SECRET` set, to make local testing easier — this is disabled (the endpoint returns 503) once
`NODE_ENV=production`.

## Test

```bash
npm test          # unit + integration (Node's built-in test runner)
npm run test:unit  # unit tests only, no database needed
```

**Test results (this build):** 88/88 passing — 24 unit tests, 64 integration tests across
`multiselect.test.js`, `journeys.test.js`, `resilience.test.js`, `api.test.js`, `flowmode.test.js` and
`followup.test.js`. Coverage includes every scenario requested: new/returning user, single- and multi-select,
empty selection, each of the 5 career flows, pricing (approved and unapproved), order/payment/refund, human
handoff (including STOP during handoff), BACK/MENU/START OVER/STOP, duplicate and concurrent webhook delivery,
MSG91 failure (with resend on recovery), MongoDB failure (both at the idempotency store and mid-processing),
invalid payloads, expired sessions, and concurrent events from one user and from many users. The key scenario
— selecting Resume + LinkedIn + Cover Letter — is asserted to produce exactly one conversation and one lead
with `selectedServices: ["ai_resume_builder", "linkedin_optimization", "cover_letter_generator"]`.

**Caveat:** the integration tests ran against **FerretDB** (a MongoDB-compatible server backed by SQLite), not
real MongoDB, because no `mongod` binary was available in the build environment. The test harness strips the
one TTL index (`WebhookEvent.expiresAt`) that FerretDB doesn't implement. Everything else — all unique indexes,
which the idempotency and lead-merging logic depend on — runs for real. **Re-run `npm test` against a real
MongoDB before trusting these results in production.** `src/server.js` itself was smoke-tested (boot, connect,
seed, `/health`, one webhook round-trip) against FerretDB with the same TTL index stripped; it has not been
run against real MongoDB by me. MSG91 itself was never called — the WhatsApp send layer is a fake in every
test (`tests/helpers.js`'s `fakeWhatsApp()`). See [Test with a real WhatsApp number](#test-with-a-real-whatsapp-number)
for the step that actually exercises MSG91.

## Configure the MSG91 webhook

In the MSG91 dashboard, point your WhatsApp integration's inbound webhook at:

```
https://<your-host>/webhooks/whatsapp?secret=<MSG91_WEBHOOK_SECRET>
```

(Use the same value for `MSG91_WEBHOOK_SECRET` in `.env`.) If MSG91 lets you attach custom headers to the
webhook instead, send `x-webhook-secret: <MSG91_WEBHOOK_SECRET>` and drop the query string. For extra
assurance, if MSG91 signs its webhook payloads, set `MSG91_WEBHOOK_HMAC_SECRET` and the bot will also verify an
`x-signature` / `x-hub-signature-256` HMAC-SHA256 of the raw body.

**The exact shape of MSG91's inbound webhook for your account is not confirmed.** The normaliser
(`src/services/msg91/msg91.inbound.js`) accepts both the standard Meta Cloud API shape and a best-guess MSG91
envelope. Capture one real delivered payload and compare it against `docs/WEBHOOK_PAYLOADS.md` — see that file
for how, and adjust `msg91.inbound.js` if the shape differs.

## Create and publish the WhatsApp Flow

See [docs/FLOW.md](docs/FLOW.md) for the full walkthrough. Short version: import
`flows/service-selection.flow.json` into Meta's Flow Builder (via the WhatsApp Manager linked to your MSG91
number), publish it, copy its Flow ID into `MSG91_SERVICE_FLOW_ID`, and confirm with MSG91 support that Flow
sending works for your account before relying on it (see the fallback note above).

## Test with a real WhatsApp number

1. Deploy the app somewhere reachable over HTTPS (or use a tunnel like `ngrok http 3000` for a quick local test).
2. Point the MSG91 webhook at your public URL as above.
3. From your own phone, send any message to the WhatsApp number linked to your MSG91 account.
4. You should get the welcome message with three buttons within a couple of seconds. Reply MENU, HUMAN, STOP
   etc. to exercise the flows; check `GET /health` and your server logs alongside.
5. Capture the very first inbound webhook payload MSG91 actually sends you (log it once, safely, with the
   number masked) and compare it against `docs/WEBHOOK_PAYLOADS.md`.

This step has **not been performed** during this build — there was no live MSG91 account or phone number
available. Please do it before considering the bot production-ready.

## Environment variables

See [.env.example](.env.example) for the full, commented list. The ones required to start in production
(`missingProductionConfig` in `src/config/env.js` checks these and refuses to boot if any are missing):

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | MongoDB connection string |
| `MSG91_AUTH_KEY` | MSG91 API auth key |
| `MSG91_INTEGRATED_NUMBER` | Your WhatsApp number as registered with MSG91 |
| `MSG91_WEBHOOK_SECRET` | Shared secret MSG91 must send back on every webhook call |
| `INTERNAL_API_KEY` | Protects `/leads`, `/contacts/upsert`, `/messages/send`, etc. |

`PAYMENT_WEBHOOK_SECRET` is required for `POST /events/payment` to work at all (that route returns 503 without
it, in any environment) but is not in the production start-up check, since not every deployment will use it
immediately.

## Configuration you must supply

Nothing below is a code gap — it's a business decision or credential this build could not invent:

- **Service URLs and "live" flags** — every service ships with `live: false, url: null`. Set via
  `PUT /services/:id` (needs `INTERNAL_API_KEY`) once each tool actually exists online.
- **Approved pricing** — every service ships with `pricing.approved: false`. Set amount, currency, inclusions,
  terms and checkout URL the same way once DutyLaunch approves the numbers. Until then the bot tells the user
  pricing isn't published yet rather than guessing.
- **Approved WhatsApp template names** — `TEMPLATE_ENQUIRY_FOLLOWUP`, `TEMPLATE_CHECKOUT_REMINDER`,
  `TEMPLATE_PAYMENT_CONFIRMATION`, `TEMPLATE_TICKET_ACK` must match templates already approved in
  MSG91/Meta, with the variable order documented in `.env.example`.
- **The Flow ID** (`MSG91_SERVICE_FLOW_ID`) — see above.
- **Support hours text** (`SUPPORT_HOURS_TEXT`) — shown verbatim in ticket acknowledgements; empty by default.
- **Queue owners** (`OWNER_SALES`, `OWNER_SUPPORT`, `OWNER_FINANCE`, `OWNER_PARTNERSHIPS`) — used for internal
  routing/notification only; empty by default.
- **Consent / marketing wording** — the marketing opt-in question in `src/services/conversation/questions.js`
  (`marketingConsent`) uses generic wording ("occasional updates about DutyLaunch offers"); replace with
  DutyLaunch's approved consent copy if different.
- **Internal notifications** — `NOTIFY_WEBHOOK_URL` (a Slack-compatible incoming webhook) for new-ticket alerts;
  without it, tickets are still created and routed, just not pinged anywhere.
- **Follow-up cadence** — disabled unless you set `FOLLOWUP_DELAY_HOURS` and `TEMPLATE_ENQUIRY_FOLLOWUP`; see
  `src/jobs/followUp.js`. Sends at most one follow-up per lead, only to contacts who explicitly opted in, and
  skips anyone who has since paid, has an open ticket, or is in an active human handoff.
- **The optional React/Vite admin dashboard** was not built (marked optional in the brief); `PUT /services/:id`,
  `GET /services` and `GET /analytics/summary` are ready for one to be built against.

## Production deployment

1. **Database**: a real MongoDB (Atlas or self-hosted) with a dedicated least-privilege user, TLS
   (`mongodb+srv://...` or `?tls=true`), and network access restricted to your app's egress IPs. Take backups.
2. **Secrets**: generate strong random values for `MSG91_WEBHOOK_SECRET`, `MSG91_WEBHOOK_HMAC_SECRET` (if used),
   `INTERNAL_API_KEY` and `PAYMENT_WEBHOOK_SECRET`; store them in your platform's secret manager, not in source
   control (`.env` is git-ignored).
3. **Build/run**: `Dockerfile` is included (`node:22-alpine`, runs as the non-root `node` user,
   `npm ci --omit=dev`, exposes `PORT`, has a `HEALTHCHECK` against `/health`). Or run directly with
   `NODE_ENV=production node src/server.js` behind a process manager.
4. **TLS**: terminate HTTPS at a load balancer / reverse proxy in front of the app; `app.set('trust proxy', 1)`
   is already set for that.
5. **Set every required env var** (see table above) — the app refuses to start in production if any are
   missing, and logs exactly which ones (`missing required production configuration`).
6. **Seed services**: run `npm run seed` once against the production database (safe to re-run; it only inserts
   defaults that don't already exist, never overwrites DutyLaunch's edits).
7. **Point the MSG91 webhook** at the deployed URL (see above), and set up `POST /events/payment` similarly if
   your payment backend can call out.
8. **Monitor**: logs are structured JSON (pino) with secrets redacted; wire them into your log aggregator.
   `GET /analytics/summary?from=...&to=...` gives lead/conversion/fallback/handoff metrics from MongoDB
   directly.
9. Complete the real-number test above against the production number before announcing it.

## Known limitations / unverified assumptions

- **WhatsApp Flow sending through MSG91 is unverified** (see above) — the list-based fallback is the
  reliable path today.
- **MSG91's inbound webhook envelope for your account is assumed**, not confirmed (see
  `docs/WEBHOOK_PAYLOADS.md`).
- **Bulk-template and get-templates endpoint shapes are best-effort** from MSG91's documentation; verify
  `buildTemplatePayload` in `src/services/msg91/msg91.templates.js` against a real template send.
- **Tests ran on FerretDB**, not real MongoDB (see [Test](#test)).
- **No live MSG91/WhatsApp call was made** during this build — everything MSG91-facing is unit-tested against
  a fake HTTP client, and the conversation flows are integration-tested against a fake WhatsApp send layer.
- **The optional admin dashboard (React/Vite) was not built.**
- **Prices, URLs, templates, Flow ID, support hours and queue owners are all unset** — see
  [Configuration you must supply](#configuration-you-must-supply).
