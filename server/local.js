import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { generateReply, validatePayload, DEFAULT_MODEL } from './gemini.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const PUBLIC = new Set(['index.html', 'manifest.json', 'sw.js']);
const limit = (input, fallback) => Number.isInteger(Number(input)) && Number(input) > 0 && Number(input) <= 10000 ? Number(input) : fallback;

export class UsageBudget {
  constructor(path, dailyLimit = 200, minuteLimit = 20) { this.path = path; this.dailyLimit = dailyLimit; this.minuteLimit = minuteLimit; this.queue = Promise.resolve(); }
  reserve(now = Date.now()) {
    const job = this.queue.then(async () => {
      const day = Math.floor(now / 86400000), minute = Math.floor(now / 60000); let prior = {};
      try { prior = JSON.parse(await readFile(this.path, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('budget_unavailable'); }
      if (Object.keys(prior).length && !['day', 'minute', 'used', 'recent'].every((key) => Number.isInteger(prior[key]) && prior[key] >= 0)) throw new Error('budget_unavailable');
      const used = prior.day === day ? prior.used : 0, recent = prior.minute === minute ? prior.recent : 0;
      if (used >= this.dailyLimit || recent >= this.minuteLimit) return { allowed: false, used, limit: this.dailyLimit };
      await mkdir(resolve(this.path, '..'), { recursive: true });
      await writeFile(`${this.path}.tmp`, JSON.stringify({ day, minute, used: used + 1, recent: recent + 1 }), { mode: 0o600 });
      await rename(`${this.path}.tmp`, this.path);
      return { allowed: true, used: used + 1, limit: this.dailyLimit };
    });
    this.queue = job.catch(() => {}); return job;
  }
}

export function createLocalServer({ config = process.env, root = ROOT, fetcher = fetch, budget = null } = {}) {
  const secret = randomBytes(32).toString('hex');
  const usage = budget || new UsageBudget(resolve(root, '.jarvis-data/usage.json'), limit(config.DAILY_REQUEST_LIMIT, 200), limit(config.MINUTE_REQUEST_LIMIT, 20));
  const send = (response, status, data) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(data));
  };
  return createServer(async (request, response) => {
    const port = request.socket.localPort, host = request.headers.host;
    if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(host)) { send(response, 403, { error: 'host_denied' }); return; }
    let url;
    try { url = new URL(request.url, `http://${host}`); } catch { send(response, 400, { error: 'invalid_url' }); return; }
    if (url.pathname.startsWith('/api/')) {
      const origin = request.headers.origin;
      if ((origin && origin !== `http://${host}`) || (!origin && request.method !== 'GET') || request.headers['sec-fetch-site'] === 'cross-site') { send(response, 403, { error: 'origin_denied' }); return; }
      if (url.pathname === '/api/health' && request.method === 'GET') {
        // Refresh a stale HttpOnly cookie after server restart, even from a cached PWA page.
        response.setHeader('Set-Cookie', `jarvis_session=${secret}; HttpOnly; SameSite=Strict; Path=/`);
        send(response, 200, { ready: Boolean(config.GEMINI_API_KEY), model: config.GEMINI_MODEL || DEFAULT_MODEL, dailyLimit: limit(config.DAILY_REQUEST_LIMIT, 200) }); return;
      }
      const cookie = request.headers.cookie?.split(';').map((item) => item.trim()).find((item) => item.startsWith('jarvis_session='))?.slice('jarvis_session='.length) || '';
      if (!/^[a-f0-9]{64}$/.test(cookie) || !timingSafeEqual(Buffer.from(cookie), Buffer.from(secret))) { send(response, 401, { error: 'unauthorized' }); return; }
      if (url.pathname !== '/api/analyze' || request.method !== 'POST') { send(response, 404, { error: 'not_found' }); return; }
      if (!config.GEMINI_API_KEY) { send(response, 503, { error: 'not_configured' }); return; }
      if (!request.headers['content-type']?.startsWith('application/json')) { send(response, 400, { error: 'invalid_payload' }); return; }
      let payload;
      try {
        const chunks = []; let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 18000) { send(response, 413, { error: 'payload_too_large' }); return; }
          chunks.push(chunk);
        }
        payload = validatePayload(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch { send(response, 400, { error: 'invalid_payload' }); return; }
      let quota;
      try { quota = await usage.reserve(); } catch { send(response, 503, { error: 'budget_unavailable' }); return; }
      if (!quota.allowed) { send(response, 429, { error: 'usage_limit', usage: quota }); return; }
      const controller = new AbortController(); response.on('close', () => { if (!response.writableEnded) controller.abort(); });
      try {
        const result = await generateReply(payload, config, { fetcher, signal: controller.signal });
        if (!response.destroyed) send(response, 200, { ...result, usage: quota });
      } catch (error) {
        const status = error.message === 'provider_limit' ? 429 : error.message === 'provider_timeout' ? 504 : 502;
        if (!response.destroyed) send(response, status, { error: error.message });
      }
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') { send(response, 405, { error: 'method_not_allowed' }); return; }
    try {
      const path = decodeURIComponent(url.pathname).replace(/^\//, '') || 'index.html';
      if (!PUBLIC.has(path) && !/^src\/[a-z0-9-]+\.(js|css)$/.test(path) && !/^icons\/[a-z0-9-]+\.svg$/.test(path)) { send(response, 404, { error: 'not_found' }); return; }
      const file = await readFile(resolve(root, path));
      response.writeHead(200, {
        'Content-Type': MIME[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
        ...(path === 'index.html' ? { 'Set-Cookie': `jarvis_session=${secret}; HttpOnly; SameSite=Strict; Path=/` } : {})
      });
      response.end(request.method === 'HEAD' ? undefined : file);
    } catch { send(response, 404, { error: 'not_found' }); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = limit(process.env.PORT, 8787);
  const server = createLocalServer();
  server.on('error', (error) => { console.error(error.code === 'EADDRINUSE' ? 'ポートが使用中です。別のPORTを指定してください。' : 'PC版サーバーを起動できませんでした。'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => {
    console.log(`JARVIS PC版: http://localhost:${port}`);
    console.log(process.env.GEMINI_API_KEY ? 'Gemini設定あり（実際の接続は画面で確認してください）' : 'Gemini未設定。.envへGEMINI_API_KEYを登録し再起動してください。ルールモードは使えます。');
  });
}
