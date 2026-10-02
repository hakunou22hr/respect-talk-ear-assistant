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
test('嬉しい発言には喜びの共有を提案する', () => assert.equal(analyzeMessage('試験に合格して嬉しい').emotion, '喜び'));
test('不安な発言にはまず聞くことを提案する', () => assert.equal(analyzeMessage('明日の面接が不安だ').action, '今は聞く'));
test('怒っている発言には共感を提案する', () => assert.equal(analyzeMessage('理不尽で腹が立つ').emotion, '怒り'));
test('質問には確認を提案する', () => assert.equal(analyzeMessage('これはどうするの？').action, '確認'));
test('空の発言は分析しない', () => assert.equal(analyzeMessage('  '), null));
test('会話状態をすべて定義する', () => assert.deepEqual(Object.keys(STATES), ['IDLE', 'LISTENING', 'RECOGNIZED', 'PROCESSING', 'SPEAKING']));
test('アイデア要求にはアイデア行動を提案する', () => assert.equal(analyzeMessage('週末のアイデアがほしい').action, 'アイデア'));
test('短い相槌向けの一般発言を処理する', () => assert.equal(analyzeMessage('そうだね').action, '相槌'));
test('相談したい発言に深掘りを提案する', () => assert.equal(analyzeMessage('ちょっと相談したい').action, '深掘り'));
