export class AssistanceEngine {
  constructor(ai, { budget = 1200 } = {}) { this.ai = ai; this.budget = budget; this.busy = false; }
  async analyze(text, context, fallback, useLocal) {
    if (!useLocal || this.busy) return { ...fallback, fallbackReason: this.busy ? '前のAI処理が継続中' : 'ルールモード・AI未準備' };
    this.busy = true;
    let timer;
    const generation = Promise.resolve().then(() => this.ai.analyze(text, context, fallback))
      .catch((error) => ({ ...fallback, fallbackReason: error.message }))
      .finally(() => { this.busy = false; });
    try {
      return await Promise.race([generation, new Promise((resolve) => { timer = setTimeout(() => resolve({ ...fallback, fallbackReason: `${this.budget}msの応答予算を超過` }), this.budget); })]);
    } finally { clearTimeout(timer); }
  }
}

export function resemblesSuggestion(text, suggestions) {
  const normalize = (value) => value.normalize('NFKC').replace(/[\s。、！？!?「」]/g, '').toLowerCase();
  const target = normalize(text);
  return target.length >= 3 && suggestions.some((item) => {
    const candidate = normalize(item.text);
    return candidate.length >= 3 && (target.includes(candidate) || candidate.includes(target));
  });
}
