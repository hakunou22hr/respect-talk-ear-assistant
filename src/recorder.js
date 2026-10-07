export class SessionRecorder {
  constructor(Recorder = globalThis.MediaRecorder) { this.Recorder = Recorder; this.recorder = null; this.chunks = []; this.gaps = []; this.gapStart = null; }
  reset() {
    if (this.recorder && this.recorder.state !== 'inactive') throw new Error('録音中にリセットできません');
    this.recorder = null; this.chunks = []; this.gaps = []; this.gapStart = null;
  }
  start(stream) {
    if (!this.Recorder || !stream) throw new Error('このブラウザでは録音を利用できません');
    const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((mime) => this.Recorder.isTypeSupported?.(mime));
    this.chunks = []; this.gaps = []; this.gapStart = null;
    this.recorder = new this.Recorder(stream, type ? { mimeType: type } : undefined);
    this.recorder.ondataavailable = (event) => { if (event.data.size) this.chunks.push(event.data); };
    this.recorder.onerror = (event) => this.onError?.(event.error || new Error('録音エラー'));
    this.recorder.start(1000);
  }
  pause(now = Date.now()) {
    if (this.recorder?.state === 'recording') { this.recorder.pause(); this.gapStart = now; }
  }
  resume(now = Date.now()) {
    if (this.recorder?.state === 'paused') {
      this.recorder.resume();
      this.gaps.push({ startedAt: this.gapStart, endedAt: now, reason: 'AI読み上げ中：録音除外' });
      this.gapStart = null;
    }
  }
  async stop() {
    const recorder = this.recorder;
    if (!recorder) return null;
    if (recorder.state === 'inactive') return this.chunks.length ? new Blob(this.chunks, { type: recorder.mimeType || 'audio/mp4' }) : null;
    if (this.gapStart !== null) { this.gaps.push({ startedAt: this.gapStart, endedAt: Date.now(), reason: 'AI読み上げ中：録音除外' }); this.gapStart = null; }
    return new Promise((resolve, reject) => {
      recorder.onstop = () => resolve(new Blob(this.chunks, { type: recorder.mimeType || 'audio/mp4' }));
      recorder.onerror = (event) => reject(event.error || new Error('録音停止に失敗しました'));
      recorder.stop();
    });
  }
}
