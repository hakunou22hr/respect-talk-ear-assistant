export const MAX_HISTORY = 6;

export class ConversationHistory {
  constructor(limit = MAX_HISTORY) {
    this.limit = Math.max(5, limit);
    this.items = [];
  }

  add(role, text) {
    const value = String(text || '').trim();
    if (!value) return;
    this.items.push({ role, text: value });
    this.items = this.items.slice(-this.limit);
  }

  context() {
    return this.items.map(({ role, text }) => `${role === 'partner' ? '相手' : 'AI提案'}：${text}`).join('\n');
  }

  clear() { this.items = []; }
}

export function normalizeAnalysis(value, fallback, text) {
  const allowed = ['相槌', '共感', '共有', '質問', '深掘り', '確認', '励まし', 'アイデア', '提案', '今は黙って聞く'];
  const clean = (input, defaultValue, max = 30) => String(input || defaultValue).replace(/[\r\n]/g, ' ').trim().slice(0, max);
  const replies = Array.isArray(value?.replies)
    ? value.replies.map((reply) => clean(reply, '', 35)).filter(Boolean).slice(0, 3)
    : [];
  return {
    text,
    emotion: clean(value?.emotion, fallback.emotion, 20),
    intent: clean(value?.intent, fallback.intent, 30),
    need: clean(value?.need, fallback.need || fallback.intent, 30),
    action: allowed.includes(value?.action) ? value.action : fallback.action,
    replies: replies.length ? replies : fallback.replies.slice(0, 3),
    source: 'local'
  };
}

export function extractJson(output) {
  const text = typeof output === 'string' ? output : output?.[0]?.generated_text;
  const generated = Array.isArray(text) ? text.at(-1)?.content : text;
  const match = String(generated || '').match(/\{[\s\S]*\}/);
  if (!match) throw new Error('生成結果にJSONがありません');
  return JSON.parse(match[0]);
}
