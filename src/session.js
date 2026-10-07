export const SPEAKERS = { partner: '相手', self: '私', unknown: '未確認' };
const id = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export class ConversationSession {
  constructor(now = Date.now()) {
    this.id = id();
    this.startedAt = now;
    this.endedAt = null;
    this.title = '会話';
    this.participants = '相手、私';
    this.conversationSession = [];
    this.assistantSuggestions = [];
    this.pendingUtterances = [];
    this.recordingGaps = [];
    this.minutes = null;
  }
  add(text, speaker = 'partner', { timestamp = Date.now(), confirmed = false, pending = false } = {}) {
    if (this.endedAt !== null || !String(text).trim()) return null;
    const entry = { id: id(), timestamp, speaker, text: String(text).trim(), confirmed };
    (pending ? this.pendingUtterances : this.conversationSession).push(entry);
    this.minutes = null;
    return entry;
  }
  suggest(analysis, utteranceId, timing) {
    if (this.endedAt !== null) return null;
    const item = { id: id(), timestamp: Date.now(), utteranceId, text: analysis.replies[0] || '', action: analysis.action, source: analysis.source, kind: analysis.kind || 'coach', timing };
    this.assistantSuggestions.push(item);
    return item;
  }
  edit(entryId, patch) {
    const entry = this.conversationSession.find((item) => item.id === entryId);
    if (!entry) return;
    if (SPEAKERS[patch.speaker]) { entry.speaker = patch.speaker; entry.confirmed = true; }
    if (typeof patch.text === 'string' && patch.text.trim()) entry.text = patch.text.trim();
    this.minutes = null;
  }
  remove(entryId) {
    this.conversationSession = this.conversationSession.filter((item) => item.id !== entryId);
    this.minutes = null;
  }
  resolve(entryId, speaker) {
    const entry = this.pendingUtterances.find((item) => item.id === entryId);
    this.pendingUtterances = this.pendingUtterances.filter((item) => item.id !== entryId);
    if (entry && SPEAKERS[speaker]) {
      this.conversationSession.push({ ...entry, speaker, confirmed: true });
      this.conversationSession.sort((a, b) => a.timestamp - b.timestamp);
      this.minutes = null;
    }
  }
  end(now = Date.now()) {
    this.endedAt ??= now;
    this.title = this.conversationSession[0]?.text.slice(0, 24) || '会話';
  }
  context() {
    // Only real utterances. Suggestions and unconfirmed playback overlap never enter AI context.
    return this.conversationSession.slice(-20).map((item) => `${SPEAKERS[item.speaker]}：${item.text}`).join('\n').slice(-4000);
  }
  static restore(value) { return Object.assign(new ConversationSession(value.startedAt), value); }
}

export function durationLabel(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

export function minutesInput(session) {
  // Explicit whitelist: never serialize an entire session into a model prompt.
  return {
    startedAt: session.startedAt, endedAt: session.endedAt, participants: session.participants,
    utterances: session.conversationSession.map(({ id: entryId, timestamp, speaker, text }) => ({ id: entryId, timestamp, speaker, text }))
  };
}

export function extractiveMinutes(input, level = 'standard') {
  const list = input.utterances;
  const count = level === 'brief' ? 3 : level === 'detailed' ? 10 : 5;
  const select = (pattern) => list.filter((item) => pattern.test(item.text)).slice(0, count).map((item) => item.id);
  return {
    level, source: 'extractive', points: list.slice(0, count).map((item) => item.id),
    important: select(/重要|必ず|締切|期限|注意/), decisions: list.filter((item) => isDecision(item.text)).slice(0, count).map((item) => item.id),
    ideas: select(/アイデア|案として|提案|してみよう/), next: select(/確認|調べ|次回|宿題|あとで/)
  };
}

function isDecision(text) {
  return /決定した|決めた|合意した|に決まった|に決まりました/.test(text) && !/まだ|ない|未定|仮|かも|検討|候補|したい/.test(text);
}

export function normalizeMinutes(value, input, level) {
  const valid = new Set(input.utterances.map((item) => item.id));
  const result = { level, source: 'local' };
  for (const key of ['points', 'important', 'decisions', 'ideas', 'next']) {
    if (!Array.isArray(value?.[key])) throw new Error('議事録JSONの形式が不正です');
    if (value[key].some((entryId) => !valid.has(entryId))) throw new Error('議事録に存在しない発言があります');
    result[key] = [...new Set(value[key])].slice(0, level === 'brief' ? 3 : level === 'detailed' ? 10 : 5);
  }
  result.decisions = result.decisions.filter((entryId) => isDecision(input.utterances.find((item) => item.id === entryId).text));
  return result;
}

export function formatMinutes(input, result) {
  const byId = new Map(input.utterances.map((item) => [item.id, item]));
  const line = (item) => `${new Date(item.timestamp).toLocaleTimeString('ja-JP')} ${SPEAKERS[item.speaker]}：${item.text}`;
  const sections = [['points', '要点'], ['important', '重要事項'], ['decisions', '決まったこと'], ['ideas', 'アイデア'], ['next', '次に確認すること']];
  let text = `日時：${new Date(input.startedAt).toLocaleString('ja-JP')}\n会話時間：${durationLabel((input.endedAt ?? input.startedAt) - input.startedAt)}\n参加者：${input.participants}\n方式：${result.source === 'local' ? '端末内AIによる実発言の選択要約' : '実発言の抽出（ローカルAI未準備・失敗時）'}\n`;
  for (const [key, label] of sections) text += `\n${label}\n${result[key].map((entryId) => byId.get(entryId)).filter(Boolean).map(line).join('\n') || '該当する発言なし（未確認）'}\n`;
  if (result.level !== 'brief') text += `\n会話全文\n${input.utterances.map(line).join('\n') || '記録なし'}\n`;
  return text;
}
