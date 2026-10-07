import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationSession, minutesInput, extractiveMinutes, formatMinutes, normalizeMinutes } from '../src/session.js';
import { AssistanceEngine, resemblesSuggestion } from '../src/assistance.js';
import { analyzeMessage } from '../src/coach.js';
import { LocalAI } from '../src/local-ai.js';
import { SessionRecorder } from '../src/recorder.js';

test('実発言・提案・読み上げ重複を分離し、編集・削除・話者変更する', () => {
  const session = new ConversationSession(1000);
  const first = session.add('朝飯食べてこなかった', 'partner', { timestamp: 1100 });
  session.add('時間なかった？', 'self', { timestamp: 1200 });
  session.suggest(analyzeMessage('朝飯食べてこなかった'), first.id, {});
  const pending = session.add('AI音声かもしれない', 'unknown', { pending: true });
  assert.equal(session.conversationSession.length, 2);
  assert.equal(session.assistantSuggestions.length, 1);
  assert.doesNotMatch(session.context(), /AI音声かもしれない|え、そうなの/);
  session.edit(first.id, { speaker: 'self', text: '本当の発言' });
  assert.equal(first.speaker, 'self'); assert.equal(first.confirmed, true);
  session.resolve(pending.id, 'partner');
  assert.equal(session.conversationSession.length, 3);
  session.remove(first.id); assert.equal(session.conversationSession.length, 2);
  session.end(2000); assert.equal(session.add('終了後の発言'), null);
  assert.equal(session.suggest(analyzeMessage('禁止'), null, {}), null);
});

test('議事録入力・全文・3種類の要約にAI提案は入らず雑談に決定を捏造しない', () => {
  const session = new ConversationSession(1000);
  session.add('今日散歩したよ');
  session.suggest({ replies: ['秘密のAI提案'], source: 'rule', action: '相槌' }, null, {});
  session.add('読み上げ重複', 'unknown', { pending: true });
  session.end(3000);
  const input = minutesInput(session);
  assert.doesNotMatch(JSON.stringify(input), /秘密のAI提案|読み上げ重複|assistantSuggestions/);
  for (const level of ['brief', 'standard', 'detailed']) {
    const result = extractiveMinutes(input, level);
    assert.deepEqual(result.decisions, []);
    const text = formatMinutes(input, result);
    assert.match(text, /今日散歩したよ/);
    assert.doesNotMatch(text, /秘密のAI提案|読み上げ重複/);
    assert.equal(text.includes('会話全文'), level !== 'brief');
  }
  assert.throws(() => normalizeMinutes({ points: ['invented'] }, input, 'standard'));
});

test('会話が編集されたら生成済み議事録を無効化する', () => {
  const session = new ConversationSession(); const entry = session.add('発言');
  session.minutes = { text: '古い議事録' };
  session.edit(entry.id, { text: '修正' }); assert.equal(session.minutes, null);
});

test('ローカルAI失敗・遅延はfallbackし、遅延中に二重推論しない', async () => {
  const fallback = analyzeMessage('こんにちは');
  const failed = new AssistanceEngine({ analyze: async () => { throw new Error('メモリ不足'); } });
  assert.equal((await failed.analyze('こんにちは', '', fallback, true)).source, 'rule');
  let resolve, calls = 0;
  const slow = new AssistanceEngine({ analyze: () => { calls++; return new Promise((r) => { resolve = r; }); } }, { budget: 5 });
  const result = await slow.analyze('こんにちは', '', fallback, true);
  assert.equal(result.source, 'rule'); assert.equal(slow.busy, true);
  await slow.analyze('次', '', fallback, true); assert.equal(calls, 1);
  resolve({ source: 'local' }); await new Promise((r) => setTimeout(r, 0)); assert.equal(slow.busy, false);
});

test('朝食の雑談と履歴に沿った短い自然な返答', () => {
  assert.equal(analyzeMessage('今日朝飯食べてこなかったんだよね').replies[0], 'え、そうなの？時間なかった？');
  assert.equal(analyzeMessage('寝坊しちゃってさ', '相手：朝飯食べてこなかった').action, '軽いユーモア');
});

test('生成AIへの入力は実発言だけで、長い講義形式はfallbackする', async () => {
  const ai = new LocalAI({ worker: false }); let prompt;
  ai.generator = async (messages) => { prompt = messages[0].content; return [{ generated_text: '{"action":"提案","replies":["朝食の重要性について説明します"]}' }]; };
  const result = await ai.analyze('朝飯食べてこなかった', '私：時間なかった？', analyzeMessage('朝飯食べてこなかった'));
  assert.match(prompt, /私：時間なかった/); assert.equal(result.replies[0], 'え、そうなの？時間なかった？');
});

test('AI要約は発言IDを選ぶ方式で、存在しない引用を拒否する', async () => {
  const ai = new LocalAI({ worker: false }); const session = new ConversationSession(); const entry = session.add('今日は寝坊した');
  const value = { points: ['u1'], important: [], decisions: [], ideas: [], next: [] };
  ai.generator = async () => [{ generated_text: JSON.stringify(value) }];
  const result = await ai.summarize(minutesInput(session), 'brief');
  assert.equal(result.source, 'local'); assert.equal(result.points[0], entry.id);
  value.decisions = ['不存在']; await assert.rejects(ai.summarize(minutesInput(session), 'standard'), /存在しない/);
});

test('MediaRecorderの開始・一時停止・再開・終了と録音除外区間', async () => {
  class Recorder {
    static isTypeSupported(type) { return type === 'audio/mp4'; }
    constructor(stream, options) { this.mimeType = options.mimeType; this.state = 'inactive'; }
    start() { this.state = 'recording'; }
    pause() { this.state = 'paused'; }
    resume() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable({ data: new Blob(['audio']) }); this.onstop(); }
  }
  const recorder = new SessionRecorder(Recorder); recorder.start({});
  assert.equal(recorder.recorder.state, 'recording');
  recorder.pause(1000); assert.equal(recorder.recorder.state, 'paused');
  recorder.resume(1500); const blob = await recorder.stop();
  assert.equal(blob.type, 'audio/mp4'); assert.equal(blob.size, 5);
  assert.deepEqual(recorder.gaps, [{ startedAt: 1000, endedAt: 1500, reason: 'AI読み上げ中：録音除外' }]);
  recorder.reset(); assert.equal(await recorder.stop(), null);
});

test('AI音声と似た結果は捨てず確認待ちに分類可能', () => {
  assert.equal(resemblesSuggestion('え、そうなの、時間なかった', [{ text: 'え、そうなの？時間なかった？' }]), true);
  assert.equal(resemblesSuggestion('寝坊しちゃってさ', [{ text: '時間なかった？' }]), false);
});
