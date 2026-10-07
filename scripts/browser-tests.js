import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve('dist');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  const file = resolve(root, `.${new URL(request.url, 'http://localhost').pathname.replace(/\/$/, '/index.html')}`);
  try {
    if (!file.startsWith(`${root}/`)) throw new Error('Path outside build');
    response.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream'); response.end(await readFile(file));
  } catch { response.statusCode = 404; response.end('Not found'); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
let passed = 0;
const check = (name) => { passed++; console.log(`PASS ${name}`); };
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const errors = []; const remoteRequests = [];
  context.on('request', (request) => { if (!request.url().startsWith(base) && !request.url().startsWith('blob:')) remoteRequests.push(request.url()); });
  await context.addInitScript(() => {
    window.__spoken = []; window.__aiMode = 'success'; window.__media = [];
    class Recognition {
      constructor() { window.__recognition = this; }
      start() { this.onstart?.(); }
      stop() { this.onend?.(); }
      emit(text, final = true) { const result = [{ transcript: text }]; result.isFinal = final; this.onresult?.({ resultIndex: 0, results: [result] }); }
    }
    window.SpeechRecognition = Recognition;
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => ({ getTracks: () => [{ stop() { window.__trackStopped = true; } }] }) } });
    window.AudioContext = class {
      resume() {}
      createAnalyser() { return { frequencyBinCount: 128, getByteTimeDomainData: (buffer) => buffer.fill(128) }; }
      createMediaStreamSource() { return { connect() {} }; }
    };
    window.MediaRecorder = class {
      static isTypeSupported(type) { return type === 'audio/mp4'; }
      constructor() { this.state = 'inactive'; this.mimeType = 'audio/mp4'; window.__media.push(this); }
      start() { this.state = 'recording'; }
      pause() { this.state = 'paused'; }
      resume() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['test audio'], { type: this.mimeType }) }); this.onstop?.(); }
    };
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    Object.defineProperty(window, 'speechSynthesis', { value: {
      getVoices: () => [{ name: 'Test Japanese', lang: 'ja-JP' }], addEventListener() {},
      cancel() { const previous = window.__utterance; window.__utterance = null; previous?.onerror?.({ error: 'canceled' }); },
      speak(utterance) { window.__utterance = utterance; window.__spoken.push(utterance.text); utterance.onstart?.(); }
    } });
    window.Worker = class {
      postMessage({ id, method, args }) {
        if (method === 'prepare') { queueMicrotask(() => this.onmessage({ data: { id, result: true } })); return; }
        if (method === 'analyze') {
          window.__lastContext = args[1];
          if (window.__aiMode === 'slow') { window.__resolveAI = () => this.onmessage({ data: { id, result: { ...args[2], source: 'local', replies: ['遅れた提案'] } } }); return; }
          if (window.__aiMode === 'failure') { queueMicrotask(() => this.onmessage({ data: { id, error: 'テスト用モデル失敗' } })); return; }
          queueMicrotask(() => this.onmessage({ data: { id, result: { ...args[2], source: 'local', replies: ['秘密のAI提案'] } } })); return;
        }
        if (method === 'summarize') {
          window.__summaryInput = args[0];
          const result = { source: 'local', level: args[1], points: args[0].utterances.map((item) => item.id).slice(0, args[1] === 'brief' ? 3 : 5), important: [], decisions: [], ideas: [], next: [] };
          queueMicrotask(() => this.onmessage({ data: { id, result } }));
        }
      }
    };
  });
  const page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base); await page.waitForFunction(() => document.querySelector('#capability-result').textContent.includes('WebGPU'));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); check('iPhone幅390pxで横にはみ出さない');
  await page.locator('#record-enabled').check(); await page.locator('#toggle-session').click();
  await page.waitForFunction(() => document.querySelector('#toggle-session').textContent === '■ 対話終了');
  assert.match(await page.locator('#recording-status').innerText(), /🔴 録音中/); check('対話開始・録音開始');
  await page.evaluate(() => { window.__recognition.emit('今日朝飯食べてこなかったんだよね', false); window.__recognition.emit('今日朝飯食べてこなかったんだよね'); });
  await page.waitForFunction(() => window.__spoken.length === 1);
  assert.equal((await page.evaluate(() => window.__spoken))[0], 'え、そうなの？時間なかった？');
  for (const selector of ['#recognition-ms', '#decision-ms', '#speech-ms', '#total-ms', '#average-ms']) assert.match(await page.locator(selector).innerText(), /\d+ms/);
  assert.match(await page.locator('#recording-status').innerText(), /一時停止/); check('高速自然応答・読み上げ中の録音除外');
  await page.evaluate(() => { window.__recognition.emit('自分が実際に話した言葉'); window.__recognition.emit(window.__spoken[0]); });
  assert.equal(await page.locator('#pending-list li').count(), 2); assert.equal(await page.locator('#history-list li').count(), 1);
  await page.locator('#pending-list li').first().getByRole('button', { name: '私の実発言' }).click();
  await page.locator('#pending-list li').first().getByRole('button', { name: 'AI音声として除外' }).click();
  assert.equal(await page.locator('#history-list li').count(), 2); check('読み上げ中の実発言を保持・AI音声は確認後除外');
  await page.locator('#speak-self').click(); assert.match(await page.locator('#recording-status').innerText(), /🔴 録音中/); check('私が話すボタンでAI停止・録音再開');
  await page.waitForTimeout(400);
  await page.locator('#next-speaker').selectOption('partner');
  await page.locator('#model-options summary').click();
  await page.locator('#prepare-ai').click(); await page.waitForFunction(() => document.querySelector('#prepare-ai').textContent === 'モデル準備完了');
  await page.evaluate(() => window.__recognition.emit('寝坊しちゃってさ'));
  await page.waitForFunction(() => window.__spoken.includes('秘密のAI提案'));
  assert.match(await page.evaluate(() => window.__lastContext), /相手：今日朝飯|私：自分が/); check('ローカルAIへ複数話者の実発言文脈を入力');
  await page.locator('#speak-self').click(); await page.locator('#next-speaker').selectOption('partner');
  await page.waitForTimeout(400);
  await page.evaluate(() => { window.__aiMode = 'failure'; window.__recognition.emit('試験に合格した'); });
  await page.waitForFunction(() => document.querySelector('#ai-processing').textContent.includes('fallback'));
  assert.equal((await page.evaluate(() => window.__spoken)).at(-1), 'それは嬉しいね。'); check('ローカルAI失敗時coach.jsへfallback');
  await page.locator('#toggle-session').click();
  await page.waitForFunction(() => document.querySelector('#toggle-session').textContent === '● 対話開始');
  assert.equal(await page.evaluate(() => window.__media[0].state), 'inactive');
  assert.equal(await page.evaluate(() => window.__trackStopped), true);
  assert.equal(await page.locator('#saved-sessions li').count(), 1); check('対話終了・認識/AI/録音停止・端末自動保存');
  await page.evaluate(() => { window.__oldRecognition = window.__recognition; });
  await page.locator('#record-enabled').uncheck(); await page.locator('#toggle-session').click();
  await page.waitForFunction(() => document.querySelector('#toggle-session').textContent === '■ 対話終了');
  await page.evaluate(() => window.__oldRecognition.emit('前のセッションの遅延結果'));
  assert.equal(await page.locator('#history-list li').count(), 0);
  await page.evaluate(() => window.__recognition.emit('途中の認識だけ', false));
  await page.locator('#toggle-session').click(); await page.waitForFunction(() => document.querySelector('#toggle-session').textContent === '● 対話開始');
  assert.equal(await page.locator('#pending-list li').count(), 1);
  assert.equal(await page.locator('#recording-player').isVisible(), false);
  check('録音OFFの次セッションに過去音声を混ぜない・古い認識を無視・途中認識を保持');
  await page.locator('#saved-sessions li').last().getByRole('button', { name: '開く' }).click();
  const first = page.locator('#history-list li').first(); await first.getByRole('button', { name: '私', exact: true }).click();
  assert.match(await first.locator('p').innerText(), /私/);
  await first.locator('textarea').fill('修正した実発言'); await first.locator('textarea').dispatchEvent('change');
  assert.equal(await first.locator('textarea').inputValue(), '修正した実発言'); check('会話履歴の話者変更・文章修正');
  for (const level of ['brief', 'standard', 'detailed']) {
    await page.locator('#summary-level').selectOption(level); await page.locator('#create-minutes').click();
    await page.waitForFunction(() => document.querySelector('#minutes-output').textContent.includes('日時：'));
    const text = await page.locator('#minutes-output').innerText();
    assert.ok(!text.includes('秘密のAI提案')); assert.equal(text.includes('会話全文'), level !== 'brief');
    assert.ok(!JSON.stringify(await page.evaluate(() => window.__summaryInput)).includes('assistantSuggestions'));
  }
  check('3種類のローカルAI議事録・AI提案の入力/出力からの除外');
  await first.getByRole('button', { name: '削除', exact: true }).click();
  assert.equal(await page.locator('#minutes-output').innerText(), ''); check('発言削除・古い議事録の無効化');
  await page.locator('#session-title').fill('朝の雑談'); await page.locator('#session-title').dispatchEvent('change'); await page.locator('#save-session').click();
  await page.waitForFunction(() => document.querySelector('#saved-sessions').textContent.includes('朝の雑談'));
  await page.reload(); await page.locator('#saved-sessions li').filter({ hasText: '朝の雑談' }).getByRole('button', { name: '開く' }).click();
  assert.equal(await page.locator('#session-title').inputValue(), '朝の雑談'); assert.equal(await page.locator('#recording-player').isVisible(), true); check('再読み込み後のIndexedDB会話/録音復元');
  await page.locator('#toggle-session').click(); await page.waitForFunction(() => document.querySelector('#toggle-session').textContent === '■ 対話終了');
  await page.locator('#model-options summary').click();
  await page.locator('#prepare-ai').click(); await page.waitForFunction(() => document.querySelector('#prepare-ai').textContent === 'モデル準備完了');
  await page.evaluate(() => { window.__aiMode = 'slow'; window.__recognition.emit('遅い推論のテスト'); });
  await page.waitForFunction(() => !!window.__resolveAI);
  await page.locator('#toggle-session').click(); await page.waitForFunction(() => document.querySelector('#toggle-session').textContent === '● 対話開始');
  const count = await page.evaluate(() => window.__spoken.length); await page.evaluate(() => window.__resolveAI());
  await page.waitForTimeout(1400);
  assert.equal(await page.evaluate(() => window.__spoken.length), count); check('終了後の遅延AI提案・TTSをキャンセル');
  const savedCount = await page.locator('#saved-sessions li').count();
  page.once('dialog', (dialog) => dialog.accept()); await page.locator('#saved-sessions li').last().getByRole('button', { name: '削除' }).click();
  await page.waitForFunction((count) => document.querySelectorAll('#saved-sessions li').length === count, savedCount - 1); check('セッションと録音を端末保存から削除');
  assert.deepEqual(errors, []); assert.deepEqual(remoteRequests, []); check('ブラウザ例外なし・モデルを準備しない外部通信なし（AIは模擬）');
  const plain = await browser.newContext(); const normal = await plain.newPage(); const normalErrors = [];
  normal.on('pageerror', (error) => normalErrors.push(error.message)); await normal.goto(base);
  await normal.waitForFunction(() => document.querySelector('#capability-result').textContent.includes('WebGPU'));
  assert.equal(await normal.evaluate(() => new Promise((resolve) => {
    const worker = new Worker('./src/ai-worker.js', { type: 'module' });
    const timeout = setTimeout(() => { worker.terminate(); resolve(false); }, 5000);
    worker.onmessage = ({ data }) => { if (data.ready) { clearTimeout(timeout); worker.terminate(); resolve(true); } };
    worker.onerror = () => { clearTimeout(timeout); worker.terminate(); resolve(false); };
  })), true);
  await normal.locator('#demo-input').fill('今日朝飯食べてこなかったんだよね'); await normal.locator('#run-demo').click();
  await normal.waitForFunction(() => document.querySelector('#suggestions').textContent.includes('時間なかった'));
  assert.deepEqual(normalErrors, []); check('実ブラウザで既存手動解析・Worker起動・未準備fallback');
  await normal.waitForFunction(() => navigator.serviceWorker.controller !== null || navigator.serviceWorker.ready);
  await normal.reload(); await normal.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await plain.setOffline(true); await normal.reload(); await normal.locator('#run-demo').click();
  await normal.waitForFunction(() => document.querySelector('#suggestions').textContent.includes('まだ返答案') === false); check('PWAオフラインで追加モジュールと既存手動解析を利用');
  console.log(`Browser checks passed: ${passed}. Speech/media/model mocked unless noted; not iPhone hardware validation.`);
} finally { await browser.close(); await new Promise((done) => server.close(done)); }
