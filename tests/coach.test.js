import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMessage, STATES } from '../src/coach.js';

test('落ち込んだ発言には共感を提案する', () => {
  const result = analyzeMessage('最近、仕事で失敗して落ち込んでいるんだ');
  assert.equal(result.emotion, '落ち込み');
  assert.equal(result.action, '共感');
  assert.equal(result.replies[0], 'それは大変だったね。');
});
test('一般的な共有には自然な相槌を返す', () => assert.equal(analyzeMessage('今日は散歩したよ').replies[0], 'そうなんだ。'));
test('空の発言は分析しない', () => assert.equal(analyzeMessage('  '), null));
test('会話状態をすべて定義する', () => assert.deepEqual(Object.keys(STATES), ['IDLE', 'LISTENING', 'PROCESSING', 'SPEAKING']));
