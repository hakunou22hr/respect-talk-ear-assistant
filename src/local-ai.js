import { extractJson, normalizeAnalysis } from './conversation.js';

export const MODEL = Object.freeze({
  id: 'onnx-community/Qwen2.5-0.5B-Instruct',
  label: 'Qwen2.5 0.5B Instruct (ONNX q4)',
  approximateMB: 400
});

export function inspectCapabilities(nav = navigator) {
  const memory = nav.deviceMemory || null;
  const webgpu = Boolean(nav.gpu);
  const wasm = typeof WebAssembly !== 'undefined';
  return {
    webgpu, wasm, memory,
    usable: wasm,
    warning: !wasm ? 'WebAssemblyに対応していません。' : memory && memory < 4 ? 'メモリ不足の可能性があります。' : ''
  };
}

export class LocalAI {
  constructor({ importer = (url) => import(url) } = {}) {
    this.importer = importer;
    this.generator = null;
    this.loading = null;
  }

  async prepare({ onProgress = () => {} } = {}) {
    if (this.generator) return this.generator;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const { pipeline, env } = await this.importer('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.3');
      env.allowLocalModels = false;
      const device = navigator.gpu ? 'webgpu' : 'wasm';
      this.generator = await pipeline('text-generation', MODEL.id, {
        dtype: 'q4', device,
        progress_callback: (event) => {
          if (Number.isFinite(event.progress)) onProgress(Math.round(event.progress));
        }
      });
      return this.generator;
    })();
    try { return await this.loading; } finally { this.loading = null; }
  }

  async analyze(text, history, fallback) {
    if (!this.generator) throw new Error('モデルが未準備です');
    const prompt = `あなたは対面会話の日本語コーチです。直近の文脈を踏まえ、相手の最新発言を分析します。
会話履歴:
${history || '（なし）'}
最新発言:「${text}」
次のJSONだけを返してください。emotionは感情、intentは会話意図、needは求めていること、actionは[相槌,共感,共有,質問,深掘り,確認,励まし,アイデア,提案,今は黙って聞く]から1つ。repliesはすぐ口に出せる10～35文字の候補を1～3個。
{"emotion":"","intent":"","need":"","action":"","replies":[""]}`;
    const output = await this.generator([{ role: 'user', content: prompt }], {
      max_new_tokens: 180, do_sample: false, repetition_penalty: 1.1
    });
    return normalizeAnalysis(extractJson(output), fallback, text);
  }
}
