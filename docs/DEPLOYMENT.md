# Deployment guide

This expands on the README's [Production deployment](../README.md#production-deployment) section.

## 1. Database

- Use a real managed MongoDB (e.g. MongoDB Atlas) or a self-hosted replica set — not a single standalone
  instance, so writes are durable if a node fails.
- Create a dedicated database user with only the privileges this app needs (read/write on the `dutylaunch`
  database; no admin).
- Require TLS (`mongodb+srv://...` on Atlas already does; for self-hosted, add `?tls=true`).
- Restrict network access to your application's egress IP range (Atlas Network Access / a security group).
- Enable automated backups (point-in-time if available) before go-live.
- **Do not use FerretDB in production** — it was a convenience for running the test suite in this build
  environment only, and does not implement TTL indexes (used to auto-expire old webhook idempotency records)
  or guarantee full MongoDB compatibility.

## 2. Secrets

Generate strong random values (e.g. `openssl rand -hex 32`) for:
- `MSG91_WEBHOOK_SECRET`
- `MSG91_WEBHOOK_HMAC_SECRET` (optional but recommended if MSG91 can sign webhooks)
- `INTERNAL_API_KEY`
- `PAYMENT_WEBHOOK_SECRET`

Store them in your platform's secret manager (e.g. your cloud provider's secrets service, or your
orchestrator's secret store) — never commit them. `.env` is already git-ignored.

## 3. Build and run

**Docker** (a `Dockerfile` is included):
```bash
docker build -t dutylaunch-bot .
docker run --env-file .env -p 3000:3000 dutylaunch-bot
```
It runs as the non-root `node` user, installs only production dependencies, and exposes a `HEALTHCHECK`
against `GET /health`.

**Without Docker**, on any Node 20+ host:
```bash
npm ci --omit=dev
NODE_ENV=production node src/server.js
```
Run it under a process manager (systemd, pm2, or your platform's process supervisor) so it restarts on crash.
`src/server.js` handles `SIGTERM`/`SIGINT` for graceful shutdown: it stops the background jobs, closes the
HTTP listener, waits for in-flight webhook processing to finish, then disconnects from MongoDB.

## 4. Networking / TLS

Put a reverse proxy or load balancer in front of the app that terminates TLS (the app itself speaks plain
HTTP). `app.set('trust proxy', 1)` is already configured so `req.ip` and related values are read correctly
from the proxy's forwarded headers — adjust the trust-proxy value if you have more than one hop in front of
the app.

## 5. Required configuration

The app refuses to start in production if any of `MONGODB_URI`, `MSG91_AUTH_KEY`, `MSG91_INTEGRATED_NUMBER`,
`MSG91_WEBHOOK_SECRET`, `INTERNAL_API_KEY` are missing (it logs exactly which ones and exits). Double-check
`.env.example` for the full list, and see the README's "Configuration you must supply" section for the
business-decision values (prices, URLs, templates, Flow ID, etc.) that have no default on purpose.

## 6. First-run seeding

```bash
npm run seed
```
Safe to run repeatedly — it only inserts service records that don't already exist (`$setOnInsert`), and never
overwrites edits DutyLaunch has made via `PUT /services/:id`.

## 7. Webhooks

- MSG91 → `POST https://<host>/webhooks/whatsapp?secret=<MSG91_WEBHOOK_SECRET>` (see README for the header
  alternative and the HMAC option).
- Your payment backend → `POST https://<host>/events/payment`, HMAC-SHA256-signed with
  `PAYMENT_WEBHOOK_SECRET` over the raw body, in an `x-signature` header.

## 8. Monitoring

- Logs are structured JSON (pino), with the MSG91 auth key and other secrets redacted at the logger level —
  ship them to your log aggregator as-is.
- `GET /health` for liveness/readiness checks (used by the Docker `HEALTHCHECK` already).
- `GET /analytics/summary?from=<ISO date>&to=<ISO date>` (requires `INTERNAL_API_KEY`) for lead/conversion/
  fallback/handoff metrics computed directly from MongoDB.
- Background jobs (webhook retry, prompt resend, session expiry, follow-up) log a line each time they do work;
  silence from a job for a long period alongside a growing `webhookEvents` backlog would indicate it's stuck.

## 9. Before announcing it live

Work through `docs/QA_CHECKLIST.md`, in particular: re-run the test suite against real MongoDB, complete a
real-number test, and confirm the MSG91 inbound webhook shape and WhatsApp Flow support with MSG91.
