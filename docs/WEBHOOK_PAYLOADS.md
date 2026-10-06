# Capturing and confirming a real MSG91 webhook payload

The normaliser in `src/services/msg91/msg91.inbound.js` was written against MSG91's published API
documentation for the **outbound** send format, plus the standard Meta Cloud API **inbound** webhook format
(which many BSPs, including MSG91, are believed to relay largely as-is). Neither MSG91's inbound webhook shape
for your specific account, nor whether it is the raw Meta shape or MSG91's own envelope, was confirmed during
this build. Do this before going live.

## 1. Capture one real payload

1. Deploy the app (or run it locally behind a tunnel) with logging at `debug` level:
   `LOG_LEVEL=debug npm start`.
2. Temporarily add one line to `src/controllers/webhook.controller.js` at the very top of `handle(req, res)`:
   ```js
   logger.debug({ action: 'raw_webhook_capture', body: req.body }, 'raw MSG91 webhook payload');
   ```
   (Do this only in a non-production/staging environment, or be ready to redact phone numbers from the logs
   afterwards — the raw payload will contain the sender's WhatsApp number.)
3. Configure the MSG91 webhook (see README) pointing at this instance.
4. Send a WhatsApp message to your MSG91 number from a real phone: one plain text message, one button tap,
   and (once you have a Flow published) one Flow submission.
5. Pull the three logged payloads out of your logs.
6. **Remove the temporary logging line** before deploying to production — don't leave raw payload logging on.

## 2. Compare against what the normaliser expects

`normalizeInbound(body)` in `msg91.inbound.js` currently recognises two shapes:

**A. Meta Cloud API shape** (most likely, if MSG91 relays close to the underlying Cloud API):
```json
{
  "entry": [{
    "changes": [{
      "value": {
        "contacts": [{ "wa_id": "919876543210", "profile": { "name": "Asha" } }],
        "messages": [{ "from": "919876543210", "id": "wamid.xxx", "timestamp": "1234567890", "type": "text", "text": { "body": "hi" } }]
      }
    }]
  }]
}
```

**B. An assumed MSG91-specific envelope** (guessed, not confirmed):
```json
{ "customerNumber": "919876543210", "customerName": "Asha", "contentType": "text", "text": "hi", "uuid": "abcd-1234" }
```

If your captured payload matches shape A closely, no code changes should be needed. If it matches shape B,
check the field names match exactly (`customerNumber` vs `sender` vs `from`, `contentType` vs `type`, etc.) —
`fromMsg91Envelope()` in `msg91.inbound.js` is intentionally permissive (`b.customerNumber || b.sender || b.from`)
but may still need adjusting. If it's neither, add a third branch following the same pattern — return a
`{ kind: 'message', eventId, messageId, from, name, timestamp, type, text/replyId/replyTitle/flowResponse, referral }`
object (see the doc comment at the top of the file for the full shape), so the rest of the engine doesn't need
to change.

## 3. Same exercise for delivery status webhooks

Repeat for delivery status callbacks (sent/delivered/read/failed) if MSG91 sends those to the same webhook
URL — compare against `fromMetaStatus()` in the same file, which expects Meta's `statuses[]` array shape.

## 4. Same exercise for payment confirmation

`POST /events/payment` is called by **your own payment backend**, not MSG91 — its shape
(`eventId`, `orderId`, `status`, `amount`, `currency`, `customerPhone`, `customerEmail`, `providerRef`,
`serviceId`, validated in `src/validators/index.js`) is something you control, so there's nothing to
"discover" there; just make sure your payment backend sends exactly that shape, HMAC-SHA256-signed with
`PAYMENT_WEBHOOK_SECRET` over the raw request body, in an `x-signature` (or `x-payment-signature`) header.
