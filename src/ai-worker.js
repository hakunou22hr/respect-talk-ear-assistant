import { LocalAI } from './local-ai.js';
const ai = new LocalAI({ worker: false });
self.postMessage({ ready: true });
// Serialize inference. Slow timed-out requests may finish, but cannot publish stale UI results.
let queue = Promise.resolve();
self.onmessage = ({ data: { id, method, args } }) => {
  queue = queue.then(async () => {
    try {
      const result = method === 'prepare'
        ? Boolean(await ai.prepare({ onProgress: (progress) => self.postMessage({ id, progress }) }))
        : await ai[method](...args);
      self.postMessage({ id, result });
    } catch (error) { self.postMessage({ id, error: error.message }); }
  });
};
