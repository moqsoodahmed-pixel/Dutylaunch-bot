/** Builders + WhatsApp limit enforcement for interactive buttons and lists. */
export const LIMITS = { buttonTitle: 20, maxButtons: 3, rowTitle: 24, rowDescription: 72, maxRows: 10, listButton: 20, body: 1024, header: 60, footer: 60, sectionTitle: 24 };

export const clip = (s, n) => {
  const t = String(s ?? '');
  const chars = [...t];
  return chars.length > n ? chars.slice(0, n - 1).join('') + '…' : t;
};

export function buildButtons({ body, header, footer, buttons }) {
  if (!body) throw new Error('interactive buttons require a body');
  if (!Array.isArray(buttons) || buttons.length < 1 || buttons.length > LIMITS.maxButtons) {
    throw new Error(`WhatsApp reply buttons: 1-${LIMITS.maxButtons} required`);
  }
  const interactive = {
    type: 'button',
    body: { text: clip(body, LIMITS.body) },
    action: { buttons: buttons.map((b) => ({ type: 'reply', reply: { id: String(b.id).slice(0, 256), title: clip(b.title, LIMITS.buttonTitle) } })) }
  };
  if (header) interactive.header = { type: 'text', text: clip(header, LIMITS.header) };
  if (footer) interactive.footer = { text: clip(footer, LIMITS.footer) };
  return interactive;
}

export function buildList({ body, header, footer, button = 'Choose', sections }) {
  if (!body) throw new Error('interactive list requires a body');
  const total = sections.reduce((n, s) => n + s.rows.length, 0);
  if (total < 1 || total > LIMITS.maxRows) throw new Error(`WhatsApp list: 1-${LIMITS.maxRows} rows required (got ${total})`);
  const interactive = {
    type: 'list',
    body: { text: clip(body, LIMITS.body) },
    action: {
      button: clip(button, LIMITS.listButton),
      sections: sections.map((s) => ({
        title: clip(s.title || 'Options', LIMITS.sectionTitle),
        rows: s.rows.map((r) => {
          const row = { id: String(r.id).slice(0, 200), title: clip(r.title, LIMITS.rowTitle) };
          if (r.description) row.description = clip(r.description, LIMITS.rowDescription);
          return row;
        })
      }))
    }
  };
  if (header) interactive.header = { type: 'text', text: clip(header, LIMITS.header) };
  if (footer) interactive.footer = { text: clip(footer, LIMITS.footer) };
  return interactive;
}
