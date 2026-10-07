import { extractMessageId } from './msg91.client.js';
import { buildButtons, buildList } from './msg91.interactive.js';
import { buildFlow } from './msg91.flow.js';
import { buildTemplatePayload } from './msg91.templates.js';

const OUTBOUND = '/api/v5/whatsapp/whatsapp-outbound-message/';   // trailing slash is required by MSG91
const BULK_TEMPLATE = '/api/v5/whatsapp/whatsapp-outbound-message/bulk/';
const TEMPLATE_LIST = (num) => `/api/v5/whatsapp/get-template-client/${encodeURIComponent(num)}`;

/** High-level WhatsApp operations on top of Msg91Client. All return { providerMessageId }. */
export function createWhatsApp(client, { defaultLanguage = 'en', namespace = '' } = {}) {
  const base = (to) => ({ integrated_number: client.integratedNumber, recipient_number: String(to) });

  const interactive = async (to, interactivePayload, action) => {
    const resp = await client.request({
      path: OUTBOUND, action,
      body: { ...base(to), content_type: 'interactive', interactive: interactivePayload }
    });
    return { providerMessageId: extractMessageId(resp) };
  };

  return {
    /**
     * Session text. Sent as a JSON body, the same shape as interactive messages — this is the
     * format verified against live MSG91 traffic. (URL query parameters break on long or
     * multi-line text and are not what MSG91 accepts for this endpoint in practice.)
     */
    async sendText(to, text) {
      const resp = await client.request({
        path: OUTBOUND, action: 'send_text',
        body: { ...base(to), content_type: 'text', text }
      });
      return { providerMessageId: extractMessageId(resp) };
    },
    sendInteractiveButtons: (to, spec) => interactive(to, buildButtons(spec), 'send_buttons'),
    sendInteractiveList: (to, spec) => interactive(to, buildList(spec), 'send_list'),
    sendFlow: (to, spec) => interactive(to, buildFlow(spec), 'send_flow'),
    async sendTemplate(to, { name, variables = [], buttonValues = [], languageCode = defaultLanguage }) {
      const body = buildTemplatePayload({ integratedNumber: client.integratedNumber, to, name, languageCode, namespace, variables, buttonValues });
      const resp = await client.request({ path: BULK_TEMPLATE, action: 'send_template', body });
      return { providerMessageId: extractMessageId(resp) };
    },
    async getTemplates() {
      return client.request({ method: 'GET', path: TEMPLATE_LIST(client.integratedNumber), action: 'get_templates' });
    }
  };
}