/**
 * Template message payload (MSG91 bulk template format: to_and_components with body_N variables).
 * Variables are passed positionally: variables[0] -> body_1, etc.
 */
export function buildTemplatePayload({ integratedNumber, to, name, languageCode = 'en', namespace, variables = [], buttonValues = [] }) {
  const components = {};
  variables.forEach((v, i) => { components[`body_${i + 1}`] = { type: 'text', value: String(v ?? '') }; });
  buttonValues.forEach((v, i) => { components[`button_${i + 1}`] = { subtype: 'url', type: 'text', value: String(v ?? '') }; });
  const template = {
    name,
    language: { code: languageCode, policy: 'deterministic' },
    to_and_components: [{ to: [String(to)], components }]
  };
  if (namespace) template.namespace = namespace;
  return {
    integrated_number: integratedNumber,
    content_type: 'template',
    payload: { messaging_product: 'whatsapp', type: 'template', template }
  };
}
