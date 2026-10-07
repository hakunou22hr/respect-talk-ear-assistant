import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createLocalServer } from '../server/local.js';

let calls = 0, fail = false, hold = false, cancelled = false;
const sent = [];
const server = createLocalServer({
  config: { GEMINI_API_KEY: 'test-only-not-real' },
  budget: { reserve: async () => ({ allowed: true, used: calls + 1, limit: 200 }) },
  fetcher: async (url, { body, signal }) => {
    calls++;
    const payload = JSON.parse(JSON.parse(body).contents[0].parts[0].text); sent.push(payload);
    if (hold) return new Promise((resolve, reject) => signal.addEventListener('abort', () => { cancelled = true; reject(new Error('abort')); }));
    if (fail) return new Response('', { status: 429 });
    const replies = [payload.kind === 'chat' ? '朝はパンと卵など、手軽に食べられるものを前日に用意しておくと楽ですね。水分も忘れずに。' : 'え、そうなの？時間なかった？'];
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ emotion: '共感', intent: '自然な対話', need: '返答', action: '提案', replies }) }] } }] });
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
let passed = 0;
const check = (name) => { passed++; console.log(`PASS ${name}`); };
try {
  const page = await browser.newPage(); const errors = [], external = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => { if (!request.url().startsWith(base) && !request.url().startsWith('blob:')) external.push(request.url()); });
  await page.addInitScript(() => {
    window.__spoken = [];
    window.SpeechRecognition = class {
      constructor() { window.__recognition = this; }
      start() { this.onstart?.(); }
      stop() { this.onend?.(); }
      emit(text) { const result = [{ transcript: text }]; result.isFinal = true; this.onresult?.({ resultIndex: 0, results: [result] }); }
    };
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
    window.AudioContext = class { resume() {} createAnalyser() { return { frequencyBinCount: 128, getByteTimeDomainData: (data) => data.fill(128) }; } createMediaStreamSource() { return { connect() {} }; } };
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    Object.defineProperty(window, 'speechSynthesis', { value: {
      getVoices: () => [], addEventListener() {},
      cancel() { const old = window.__utterance; window.__utterance = null; old?.onerror?.({ error: 'canceled' }); },
      speak(utterance) { window.__utterance = utterance; window.__spoken.push(utterance.text); utterance.onstart?.(); }
    } });
  });
  await page.goto(base); await page.waitForFunction(() => document.querySelector('#capability-result').textContent.includes('WebGPU'));
  await page.locator('#use-gemini').click(); await page.locator('#demo-input').fill('今日朝飯食べてこなかった'); await page.locator('#run-demo').click();
  await page.waitForFunction(() => document.querySelector('#ai-processing').textContent.includes('fallback'));
  assert.equal(calls, 0); check('送信OFF・設定未確認でAPIを呼ばない');
  await page.locator('#check-gemini').click(); await page.waitForFunction(() => !document.querySelector('#check-gemini').disabled);
  assert.match(await page.locator('#gemini-status').innerText(), /PCの設定あり/);
  assert.equal(calls, 0); check('接続設定確認は課金される生成を行わない');
  await page.locator('#gemini-consent').check(); await page.locator('#run-demo').click();
  await page.waitForFunction(() => document.querySelector('#ai-processing').textContent === 'Gemini処理完了');
  assert.equal(calls, 1); assert.equal(sent[0].kind, 'coach');
  assert.match(await page.locator('#suggestions').innerText(), /時間なかった/); check('PCサーバー経由で35文字以内のGemini提案');
  await page.locator('#talk-kind').selectOption('chat'); await page.locator('#toggle-session').click();
  await page.waitForFunction(() => document.querySelector('#toggle-session').textContent === '■ 対話終了');
  await page.evaluate(() => window.__recognition.emit('朝ごはんのおすすめを教えて'));
  await page.waitForFunction(() => window.__spoken.length === 1);
  assert.ok(Array.from((await page.evaluate(() => window.__spoken))[0]).length > 35);
  assert.equal(sent.at(-1).kind, 'chat'); assert.equal(sent.at(-1).history.length, 0);
  assert.match(await page.locator('#history-list li p').innerText(), /私/); check('JARVIS直接対話・私の発言からGemini返答を読み上げ');
  await page.locator('#speak-self').click(); await page.waitForTimeout(400);
  await page.evaluate(() => window.__recognition.emit('それなら前日に準備できそう？'));
  await page.waitForFunction(() => window.__spoken.length === 2);
  assert.ok(sent.at(-1).chatHistory.some((item) => item.role === 'assistant' && item.text.includes('パンと卵')));
  check('直前のJARVIS返答を直接対話の文脈へ含める');
  await page.locator('#toggle-session').click(); await page.waitForFunction(() => document.querySelector('#toggle-session').textContent === '● 対話開始');
  await page.locator('#create-minutes').click(); await page.waitForFunction(() => document.querySelector('#minutes-output').textContent.includes('会話全文'));
  assert.ok(!(await page.locator('#minutes-output').innerText()).includes('パンと卵'));
  assert.equal(calls, 3); check('議事録へAI返答を混ぜず、議事録をGoogleへ送らない');
  fail = true; await page.locator('#demo-input').fill('質問'); await page.locator('#run-demo').click();
  await page.waitForFunction(() => document.querySelector('#gemini-status').textContent.includes('利用制限'));
  assert.match(await page.locator('#ai-processing').innerText(), /fallback/); check('Gemini 429でルールへfallback');
  fail = false; hold = true;
  await page.locator('#run-demo').click(); await page.waitForTimeout(150);
  await page.locator('#gemini-consent').uncheck();
  await page.waitForTimeout(200);
  assert.equal(cancelled, true);
  const count = calls; await page.locator('#run-demo').click(); await page.waitForTimeout(100);
  assert.equal(calls, count); check('送信OFFで処理を取消し、追加のGoogle呼び出しを止める');
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  assert.equal(await page.evaluate(() => document.cookie.includes('jarvis_session')), false);
  check('ブラウザへAPIキーを渡さず、HttpOnly認証で同じPCだけから接続');
  console.log(`Gemini PC browser checks passed: ${passed}. Google responses and speech are mocked; no live API charges.`);
} finally { await browser.close(); server.closeAllConnections(); await new Promise((done) => server.close(done)); }
