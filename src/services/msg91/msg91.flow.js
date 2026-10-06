import { clip, LIMITS } from './msg91.interactive.js';

/**
 * WhatsApp Flow message (Meta Cloud API "interactive.type = flow" shape).
 *
 * IMPORTANT: MSG91's public docs (as of this build) document text, buttons, list, catalog and
 * location-request interactive messages on /api/v5/whatsapp/whatsapp-outbound-message/. They do NOT
 * document Flow sending. This builder uses the standard Meta shape through the same endpoint; if MSG91
 * rejects it for your account the conversation engine automatically falls back to the native
 * list-based multi-select (see conversation/engine.js). Confirm with MSG91 support before go-live.
 */
export function buildFlow({ body, header, footer, flowId, cta = 'Choose services', token, screen, data, draft = false }) {
  if (!flowId) throw new Error('flowId is required to send a WhatsApp Flow');
  if (!token) throw new Error('flow token is required');
  const parameters = {
    flow_message_version: '3',
    flow_token: token,
    flow_id: flowId,
    flow_cta: clip(cta, LIMITS.buttonTitle),
    flow_action: 'navigate',
    flow_action_payload: { screen, data }
  };
  if (draft) parameters.mode = 'draft';
  const interactive = { type: 'flow', body: { text: clip(body, LIMITS.body) }, action: { name: 'flow', parameters } };
  if (header) interactive.header = { type: 'text', text: clip(header, LIMITS.header) };
  if (footer) interactive.footer = { text: clip(footer, LIMITS.footer) };
  return interactive;
}

/** Parses the nfm_reply.response_json string. Returns null on malformed input. */
export function parseFlowResponse(responseJson) {
  try {
    const obj = typeof responseJson === 'string' ? JSON.parse(responseJson) : responseJson;
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch { return null; }
}
