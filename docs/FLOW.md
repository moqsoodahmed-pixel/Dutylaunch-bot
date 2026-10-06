# Creating and publishing the WhatsApp Flow

This covers the multi-select screen used when `MSG91_SERVICE_FLOW_ID` is set. Read
[the fallback note in the README](../README.md#multi-select-whatsapp-flow-vs-native-list-fallback) first —
Flow sending through MSG91 is **unverified**; treat everything below as "how to set it up and test it",
not as a guarantee it will work end-to-end on the first try.

## 1. Where Flows are built

WhatsApp Flows are a Meta feature, configured in **Meta's WhatsApp Manager** (business.facebook.com →
WhatsApp Manager → your WABA → Flows), even though messages are sent through MSG91. MSG91's WhatsApp
integration is built on top of the same Meta Cloud API / on-premise infrastructure, so the WABA (WhatsApp
Business Account) that MSG91 provisioned for you is the one you manage Flows in.

If you don't have direct access to WhatsApp Manager for your WABA, ask MSG91 support for it, or ask them to
create/publish the Flow on your behalf and hand you the Flow ID — and ask them directly, at the same time,
whether their outbound API supports sending an `interactive.type: "flow"` message. That single question
resolves the biggest open item in this build.

## 2. Import the Flow JSON

The Flow definition is at [`flows/service-selection.flow.json`](../flows/service-selection.flow.json). It
defines one terminal screen, `SERVICE_SELECTION`, with:

- a `TextHeading` / `TextBody` (the approved intro copy),
- a `CheckboxGroup` named `services`, populated from dynamic data (`data.services`) rather than hard-coded
  options — so the bot can add/remove/rename services without touching the Flow itself,
- `min-selected-items: 1` so an empty submission isn't possible at the Flow level (the bot also checks, for
  the list fallback and as defence in depth),
- a `Footer` button labelled **Continue** whose `on-click-action` is `complete`, returning
  `{ "services": ["<ids...>"] }` — stable service IDs, not display names.

In WhatsApp Manager → Flows → Create Flow → **Import Flow JSON**, paste or upload the file. Meta's builder
will validate the JSON and show you a preview.

## 3. What the bot sends as dynamic data

Each time the bot opens the selector, it sends `flow_action_payload.data` with the current, live list of
selectable services (from `ServiceConfiguration` / `SERVICE_CATALOG`) and which ones (if any) are already
selected, e.g.:

```json
{
  "services": [
    { "id": "ai_resume_builder", "title": "AI Resume Builder", "description": "..." },
    { "id": "linkedin_optimization", "title": "LinkedIn Optimization", "description": "..." }
  ],
  "selected": []
}
```

This is why the Flow's `services` field is typed as a dynamic data source (`${data.services}`) rather than a
fixed list of options — it must reflect whatever is active in the database at send time, never a hard-coded
copy.

## 4. Test in draft mode first

Set `FLOW_DRAFT_MODE=true` in `.env` while testing. This adds `"mode": "draft"` to the Flow message, which
lets you test an **unpublished** Flow from WhatsApp Manager's preview / test number, without affecting real
users. Once you're satisfied, publish the Flow in WhatsApp Manager and set `FLOW_DRAFT_MODE=false` (or remove
the variable — it defaults to `false`).

## 5. Publish and wire up the Flow ID

1. In WhatsApp Manager, click **Publish** on the Flow. Note: once published, a Flow's structure generally
   can't be edited further (Meta requires a new Flow for structural changes) — minor copy changes inside
   existing components may still be possible; check Meta's current Flow documentation if you need to change
   it later.
2. Copy the **Flow ID** shown in WhatsApp Manager.
3. Set `MSG91_SERVICE_FLOW_ID=<that id>` in your environment and restart the app. With this set (and
   `MULTISELECT_MODE` not forced to `list_loop`), the engine will default to `multiselectMode: 'flow'` for new
   conversations.

## 6. Confirm MSG91 will actually send it

Before relying on this in production:

1. Ask MSG91 support to confirm their WhatsApp outbound API supports `interactive.type: "flow"` messages (or
   their own equivalent), and whether the request shape in
   `src/services/msg91/msg91.flow.js` (`buildFlow`) matches what they expect.
2. Send a real test message that reaches `SERVICE_SELECTION` (e.g. tap "Choose Career Services" from a real
   WhatsApp number wired up per the README's real-number test) and confirm the Flow actually renders on the
   phone, rather than erroring or silently falling back.
3. If MSG91 rejects the send, the bot already handles this automatically — it falls back to the native list
   toggle UI (see the README) and logs `flow not supported` / the underlying MSG91 error category. Check your
   logs for repeated fallbacks as a signal that Flow sending isn't working for your account.

## 7. How a Flow submission is handled

When the user taps Continue, WhatsApp delivers an `nfm_reply` webhook event containing a `response_json`
string. The bot:

- parses it (`parseFlowResponse` in `msg91.flow.js`; malformed JSON is handled without crashing),
- checks `flow_token` against the token it stored when it sent the Flow (`conv.pendingFlowToken`) — a stale or
  forged token gets a fresh Flow re-sent rather than being trusted,
- filters `services` down to IDs that are actually in the current selectable catalogue (guards against a
  stale Flow payload referencing a service that's since been deactivated, or a forged/unexpected ID),
- refuses an empty selection and re-sends the selector, exactly as the list fallback does.

All of this is covered by `tests/integration/flowmode.test.js`.
