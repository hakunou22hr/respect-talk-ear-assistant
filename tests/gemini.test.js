import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { validatePayload, buildGeminiRequest, readAnalysis, generateReply } from '../server/gemini.js';
import { createLocalServer, UsageBudget } from '../server/local.js';
import { GeminiAI, geminiHistory, geminiChatHistory } from '../src/gemini-ai.js';
import { ConversationSession, minutesInput } from '../src/session.js';

const input = { text: '朝飯食べてこなかった', history: [{ speaker: 'partner', text: 'おはよう' }], kind: 'coach' };
const analysis = { emotion: '驚き', intent: '雑談', need: '自然な反応', action: '質問', replies: ['え、そうなの？時間なかった？'] };
const output = (value = analysis) => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }] });

test('Gemini入力は実発言の指定フィールドのみ、録音・AI提案を除外', () => {
  const clean = validatePayload({ ...input, assistantSuggestions: [{ text: '送信禁止' }], recording: '音声', GEMINI_API_KEY: '禁止', history: [{ ...input.history[0], secret: '禁止' }] });
  assert.doesNotMatch(JSON.stringify(buildGeminiRequest(clean)), /送信禁止|secret|GEMINI_API_KEY|recording/);
  assert.throws(() => validatePayload({ ...input, text: 'a'.repeat(1001) }));
  assert.throws(() => validatePayload({ ...input, history: [{ speaker: 'assistant', text: '提案' }] }));
  assert.throws(() => validatePayload({ ...input, history: Array(9).fill(input.history[0]) }));
});

test('PC直接対話はJARVIS返答も文脈に使うが議事録へ混ぜない', () => {
  const session = new ConversationSession(); session.add('自己紹介して', 'self');
  session.suggest({ ...analysis, kind: 'chat', replies: ['私はJARVISです'] }, null, {});
  session.suggest({ ...analysis, kind: 'coach', replies: ['仮の耳元提案'] }, null, {});
  assert.equal(geminiHistory(session).length, 1);
  const context = geminiChatHistory(session);
  assert.ok(context.some((item) => item.role === 'assistant' && item.text === '私はJARVISです'));
  assert.ok(!context.some((item) => item.text === '仮の耳元提案'));
  assert.doesNotMatch(JSON.stringify(minutesInput(session)), /私はJARVIS|仮の耳元提案/);
});

test('会話支援35文字・直接対話120文字、長文・講義・不完全出力は拒否', () => {
  assert.equal(readAnalysis(output(), input).source, 'gemini');
  assert.throws(() => readAnalysis(output({ ...analysis, replies: ['a'.repeat(36)] }), input));
  assert.throws(() => readAnalysis(output({ ...analysis, replies: ['朝食の重要性について説明します'] }), input));
  assert.equal(readAnalysis(output({ ...analysis, replies: ['a'.repeat(120)] }), { ...input, kind: 'chat' }).replies[0].length, 120);
  assert.throws(() => readAnalysis({ candidates: [{ finishReason: 'MAX_TOKENS' }] }, input));
  assert.deepEqual(readAnalysis(output({ ...analysis, action: '今は黙って聞く', replies: [] }), input).replies, []);
});

test('Google APIキーはサーバーのヘッダーのみ、エラー本文は外へ返さない', async () => {
  let seen;
  const result = await generateReply(validatePayload(input), { GEMINI_API_KEY: 'test-only-not-real' }, {
    fetcher: async (url, options) => { seen = { url, options }; return Response.json(output()); }
  });
  assert.match(seen.url, /^https:\/\/generativelanguage.googleapis.com\//);
  assert.equal(seen.options.headers['x-goog-api-key'], 'test-only-not-real');
  assert.ok(!seen.url.includes('test-only')); assert.ok(!seen.options.body.includes('test-only'));
  assert.equal(result.analysis.source, 'gemini');
  await assert.rejects(generateReply(input, { GEMINI_API_KEY: 'test' }, { fetcher: async () => new Response('secret upstream error', { status: 403 }) }), /^Error: provider_error$/);
});

test('Google待機時間超過・利用制限を検知し、クライアント取消を伝播', async () => {
  const slow = (url, { signal }) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('abort'))); });
  await assert.rejects(generateReply(input, { GEMINI_API_KEY: 'test' }, { fetcher: slow, timeout: 5 }), /provider_timeout/);
  await assert.rejects(generateReply(input, { GEMINI_API_KEY: 'test' }, { fetcher: async () => new Response('', { status: 429 }) }), /provider_limit/);
  const controller = new AbortController();
  const running = generateReply(input, { GEMINI_API_KEY: 'test' }, { fetcher: slow, signal: controller.signal });
  controller.abort(); await assert.rejects(running, /provider_timeout/);
});

test('送信OFF・設定未確認ではGoogleへ送らず、取消と上限エラーを処理', async () => {
  let calls = 0;
  const ai = new GeminiAI({ fetcher: async () => { calls++; return Response.json({ ready: true }); } });
  await assert.rejects(ai.analyze('こんにちは', [])); assert.equal(calls, 0);
  await ai.check(); assert.equal(ai.available, true);
  await assert.rejects(ai.analyze('こんにちは', [])); assert.equal(calls, 1);
  ai.consented = true; ai.fetcher = async () => Response.json({ error: 'usage_limit' }, { status: 429 });
  await assert.rejects(ai.analyze('こんにちは', []), /利用上限/);
  ai.fetcher = (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('abort'))));
  const running = ai.analyze('こんにちは', []); ai.cancel(); await assert.rejects(running, /停止/);
});

test('同時リクエストでも日次上限を守り、サーバー再起動後も回数を保持', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-budget-'));
  try {
    const path = join(directory, 'usage.json'), budget = new UsageBudget(path, 2, 20);
    const responses = await Promise.all([budget.reserve(), budget.reserve(), budget.reserve()]);
    assert.equal(responses.filter((item) => item.allowed).length, 2);
    assert.equal((await new UsageBudget(path, 2, 20).reserve()).allowed, false);
    await writeFile(path, '{invalid'); await assert.rejects(budget.reserve(), /budget_unavailable/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('PCサーバーは.env非公開、外部Origin/Host・認証なしAPIを拒否', async () => {
  let calls = 0;
  const server = createLocalServer({ config: { GEMINI_API_KEY: 'test-only' }, budget: { reserve: async () => ({ allowed: true, used: 1, limit: 2 }) }, fetcher: async () => { calls++; return Response.json(output()); } });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/.env`)).status, 404);
    assert.equal((await fetch(`${base}/server/local.js`)).status, 404);
    const health = await fetch(`${base}/api/health`); assert.equal(health.status, 200);
    const cookie = health.headers.get('set-cookie').split(';')[0];
    const options = { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: JSON.stringify(input) };
    assert.equal((await fetch(`${base}/api/analyze`, { ...options, headers: { ...options.headers, Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${base}/api/analyze`, { ...options, headers: { ...options.headers, Cookie: '' } })).status, 401);
    const deniedHost = await new Promise((done, reject) => {
      const request = httpRequest(`${base}/`, { headers: { Host: 'evil.example' } }, (response) => { response.resume(); done(response.statusCode); });
      request.on('error', reject); request.end();
    });
    assert.equal(deniedHost, 403);
    assert.equal(calls, 0);
    const success = await fetch(`${base}/api/analyze`, options);
    assert.equal(success.status, 200); assert.equal((await success.json()).analysis.source, 'gemini'); assert.equal(calls, 1);
  } finally { await new Promise((done) => server.close(done)); }
});

test('PCサーバーの回数上限・巨大入力はGoogleへの呼び出しを止める', async () => {
  let calls = 0;
  const server = createLocalServer({ config: { GEMINI_API_KEY: 'test-only' }, budget: { reserve: async () => ({ allowed: false, used: 2, limit: 2 }) }, fetcher: async () => { calls++; return Response.json(output()); } });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const cookie = (await fetch(`${base}/api/health`)).headers.get('set-cookie').split(';')[0];
    const headers = { 'Content-Type': 'application/json', Origin: base, Cookie: cookie };
    assert.equal((await fetch(`${base}/api/analyze`, { method: 'POST', headers, body: JSON.stringify(input) })).status, 429);
    assert.equal((await fetch(`${base}/api/analyze`, { method: 'POST', headers, body: JSON.stringify({ ...input, extra: 'a'.repeat(19000) }) })).status, 413);
    assert.equal(calls, 0);
  } finally { await new Promise((done) => server.close(done)); }
});
