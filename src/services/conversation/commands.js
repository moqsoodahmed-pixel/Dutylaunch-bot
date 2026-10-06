const WORDS = {
  STOP: ['STOP', 'UNSUBSCRIBE', 'OPT OUT', 'OPTOUT', 'STOP ALL'],
  MENU: ['MENU', 'MAIN MENU', 'HOME'],
  BACK: ['BACK'],
  SUPPORT: ['SUPPORT', 'HELP'],
  HUMAN: ['HUMAN', 'AGENT', 'TALK TO A HUMAN', 'TALK TO HUMAN'],
  START_OVER: ['START OVER', 'RESTART', 'RESET']
};
const BY_ID = { cmd_back: 'BACK', cmd_menu: 'MENU', cmd_start_over: 'START_OVER', cmd_human: 'HUMAN', cmd_support: 'SUPPORT' };

/** Returns one of STOP|MENU|BACK|SUPPORT|HUMAN|START_OVER or null. Typed commands must be the whole message. */
export function parseCommand(msg) {
  if (msg.type === 'button' || msg.type === 'list') return BY_ID[msg.replyId] || null;
  if (msg.type === 'text') {
    const t = String(msg.text || '').trim().toUpperCase().replace(/\s+/g, ' ');
    for (const [cmd, words] of Object.entries(WORDS)) if (words.includes(t)) return cmd;
  }
  return null;
}
