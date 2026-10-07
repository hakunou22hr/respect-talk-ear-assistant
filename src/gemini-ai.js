const ERRORS = {
  not_configured: 'PCの.envにGemini APIキーを設定して再起動してください', unauthorized: 'PC版のページを再読み込みしてください',
  usage_limit: '今日または直近1分の利用上限に達しました', provider_limit: 'Geminiの利用制限に達しました',
  provider_error: 'Geminiに接続できません', provider_timeout: 'Geminiの応答待ちを超過しました',
  invalid_response: 'Geminiの返答を利用できません', budget_unavailable: '利用上限の記録を読み書きできません',
  invalid_payload: '発言が長すぎるか送信形式が違います'
};

export function geminiHistory(session) {
  return (session?.conversationSession || []).slice(-8).map(({ speaker, text }) => ({ speaker, text: text.slice(0, 500) }));
}

export function geminiChatHistory(session) {
  // Direct JARVIS replies are context only. Coaching suggestions never become human speech.
  const human = (session?.conversationSession || []).map((item) => ({ role: 'user', text: item.text.slice(0, 500), timestamp: item.timestamp }));
  const ai = (session?.assistantSuggestions || []).filter((item) => item.kind === 'chat').map((item) => ({ role: 'assistant', text: item.text.slice(0, 120), timestamp: item.timestamp }));
  return [...human, ...ai].sort((a, b) => a.timestamp - b.timestamp).slice(-8).map(({ role, text }) => ({ role, text }));
}

export class GeminiAI {
  constructor({ fetcher = (input, options) => fetch(input, options), timeout = 5500 } = {}) { this.fetcher = fetcher; this.timeout = timeout; this.controller = null; this.consented = false; this.available = false; }
  get ready() { return this.available && this.consented; }
  cancel() { this.controller?.abort(); this.controller = null; }
  async request(path, payload) {
    if (payload && !this.ready) throw new Error('Geminiの接続確認と会話テキスト送信ONが必要です');
    this.cancel(); const controller = new AbortController(); this.controller = controller;
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await this.fetcher(`/api/${path}`, {
        method: payload ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
        ...(payload ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {}), signal: controller.signal
      });
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('PC版はnpm startで起動してください');
      const value = await response.json();
      if (controller.signal.aborted) throw new Error('cancelled');
      if (!response.ok) throw new Error(ERRORS[value.error] || 'PC版サーバーに接続できません');
      return value;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Gemini処理を停止・時間切れにしました');
      throw error;
    } finally { clearTimeout(timer); if (this.controller === controller) this.controller = null; }
  }
  async check() { const value = await this.request('health'); this.available = Boolean(value.ready); return value; }
  async analyze(text, history, kind = 'coach', chatHistory = []) {
    const result = await this.request('analyze', { text, history, kind, ...(kind === 'chat' ? { chatHistory } : {}) });
    const analysis = result.analysis, max = kind === 'chat' ? 120 : 35;
    if (!analysis || analysis.source !== 'gemini' || typeof result.model !== 'string' || !Number.isInteger(result.usage?.used) || !Number.isInteger(result.usage?.limit) || !Array.isArray(analysis.replies) || analysis.replies.length > 1 || analysis.replies.some((reply) => typeof reply !== 'string' || Array.from(reply).length > max)) throw new Error('Geminiの返答形式が違います');
    return { ...analysis, text, kind, model: result.model, usage: result.usage, aiMs: result.aiMs };
  }
}
