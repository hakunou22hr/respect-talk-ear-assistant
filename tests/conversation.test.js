import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationHistory, extractJson, normalizeAnalysis } from '../src/conversation.js';

test('複数ターンの直近6発言を保持する', () => {
  const history = new ConversationHistory(6);
  for (let i = 0; i < 8; i += 1) history.add(i % 2 ? 'assistant' : 'partner', `発言${i}`);
  assert.equal(history.items.length, 6);
  assert.equal(history.items[0].text, '発言2');
  assert.match(history.context(), /相手：発言6/);
  assert.match(history.context(), /AI提案：発言7/);
});

test('生成JSONを抽出し候補を最大3個・35文字に制限する', () => {
  const parsed = extractJson('前置き {"emotion":"不安","intent":"相談","need":"安心","action":"共感","replies":["a","b","c","d"]} 後置き');
  const result = normalizeAnalysis(parsed, { emotion: '穏やか', intent: '共有', action: '相槌', replies: ['そうなんだ。'] }, '本文');
  assert.equal(result.replies.length, 3);
  assert.equal(result.source, 'local');
});

test('不正な生成値はルールベース結果へfallbackする', () => {
  const fallback = { emotion: '落ち込み', intent: '聞いてほしい', need: '共感', action: '共感', replies: ['大変だったね。'] };
  const result = normalizeAnalysis({ action: '不正', replies: [] }, fallback, '失敗した');
  assert.equal(result.action, '共感');
  assert.deepEqual(result.replies, ['大変だったね。']);
});

test('生成結果がJSONでなければ失敗として扱う', () => assert.throws(() => extractJson('生成失敗'), /JSON/));
