import { analyzeMessage, STATES } from './coach.js';
import { ConversationSession, durationLabel } from './session.js';
import { SessionView } from './session-ui.js';
import { SessionRecorder } from './recorder.js';
import { AssistanceEngine, resemblesSuggestion } from './assistance.js';
import { inspectCapabilities, LocalAI } from './local-ai.js';
import { GeminiAI, geminiHistory, geminiChatHistory } from './gemini-ai.js';

const $ = (selector) => document.querySelector(selector);
const ui = {
  icon: $('#status-icon'), label: $('#status-label'), help: $('#status-help'), toggle: $('#toggle-session'), note: $('#support-note'),
  transcript: $('#transcript'), emotion: $('#emotion'), intent: $('#intent'), need: $('#need'), action: $('#action'), badge: $('#category-badge'), suggestions: $('#suggestions'),
  micStatus: $('#mic-status'), recognitionStatus: $('#recognition-status'), recognitionError: $('#recognition-error'), speechStatus: $('#speech-status'),
  voiceStatus: $('#voice-status'), diagnosticMessage: $('#diagnostic-message'), meter: $('#mic-meter'), meterFill: $('#mic-meter span'), micPercent: $('#mic-percent'),
  aiMode: $('#ai-mode'), capability: $('#capability-result'), progressWrap: $('#model-progress-wrap'), progress: $('#model-progress'), progressLabel: $('#model-progress-label'),
  aiInput: $('#ai-input'), aiProcessing: $('#ai-processing'), aiTime: $('#ai-time'), aiOutput: $('#ai-output'), ttsEvent: $('#tts-event')
};
const STATUS = {
  [STATES.IDLE]: ['🎙', '待機中', 'イヤホンを確認して、対話サポートを開始してください'],
  [STATES.LISTENING]: ['🎙', '聞き取り中', '相手の声を聞いています'],
  [STATES.RECOGNIZED]: ['📝', '認識完了', '日本語の音声を認識しました'],
  [STATES.PROCESSING]: ['🧠', 'AIが考えています', '直近の会話を踏まえて分析しています'],
  [STATES.SPEAKING]: ['🎧', '読み上げ中', '返答案をイヤホンへ読み上げています']
};
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const localAI = new LocalAI();
const gemini = new GeminiAI();
const chatDemo = { conversationSession: [], assistantSuggestions: [] };
const engine = new AssistanceEngine(localAI);
const view = new SessionView(localAI, engine);
const recorder = new SessionRecorder();
let session = null, epoch = 0, requestVersion = 0, speechVersion = 0, clock = null;
let recordingResumeTimer = null, speechWatchdog = null;
let firstTranscriptAt = null, firstTranscriptWall = null, speechTailUntil = 0, playbackOverlap = false, latestInterim = '';
const latencySamples = [];
view.onChange = () => { requestVersion += 1; gemini.cancel(); };

let recognition = null, recognitionRunning = false, restartTimer = null, state = STATES.IDLE, active = false;
let lastAnalysis = null, microphoneStream = null, audioContext = null, meterFrame = null, japaneseVoice = null;
let localReady = false, aiError = false, speaking = false;
const capabilities = inspectCapabilities();

function setState(next) {
  state = next;
  const [icon, label, help] = STATUS[next];
  ui.icon.textContent = icon; ui.label.textContent = label; ui.help.textContent = help;
  document.body.dataset.state = next;
}
function setDiagnostic(message) { ui.diagnosticMessage.textContent = message; }
recorder.onError = (error) => { setDiagnostic(`録音エラー：${error.message}。実発言の文字記録は継続します。`); showRecording(); };
function setAIMode(kind) {
  const states = { gemini: ['🟢 Gemini（Google）', 'gemini'], local: ['🟢 ローカル生成AI', 'local'], loading: ['🟡 モデル読み込み中', 'loading'], rule: ['🔵 ルールベース', 'rule'], error: ['🔴 AIエラー', 'error'] };
  const [label, style] = states[kind]; ui.aiMode.textContent = label; ui.aiMode.className = `mode-badge ${style}`;
}
function selectedMode() { return $('#mode-select').value; }
function useLocal() { return localReady && !localAI.workerError && ['auto', 'local'].includes(selectedMode()); }
function directChat() { return $('#talk-kind').value === 'chat'; }

function showResult(analysis) {
  lastAnalysis = analysis;
  ui.transcript.textContent = `「${analysis.text}」`; ui.transcript.classList.remove('empty');
  ui.emotion.textContent = analysis.emotion; ui.intent.textContent = analysis.intent; ui.need.textContent = analysis.need || analysis.intent;
  ui.action.textContent = analysis.action; ui.badge.textContent = analysis.action;
  ui.suggestions.replaceChildren(...analysis.replies.slice(0, 3).map((reply, index) => {
    const li = document.createElement('li'); if (index === 0) li.className = 'best';
    const text = document.createElement('span'); text.textContent = `${index + 1}  ${reply}`;
    const button = document.createElement('button'); button.className = 'speaker'; button.type = 'button'; button.textContent = '🔊'; button.setAttribute('aria-label', `候補${index + 1}を読み上げる`);
    button.addEventListener('click', () => speak(reply, active)); li.append(text, button); return li;
  }));
  $('#speak-demo').disabled = !analysis.replies.length;
}

function loadVoices() {
  if (!('speechSynthesis' in window)) { ui.voiceStatus.textContent = '非対応'; return; }
  const voices = speechSynthesis.getVoices();
  japaneseVoice = voices.find((voice) => voice.lang === 'ja-JP') || voices.find((voice) => voice.lang.startsWith('ja')) || null;
  ui.voiceStatus.textContent = japaneseVoice ? `${japaneseVoice.name} (${japaneseVoice.lang})` : (voices.length ? '日本語voiceなし（端末既定）' : '読み込み待ち');
}
function scheduleListening(delay = 120) { clearTimeout(restartTimer); if (active) restartTimer = setTimeout(startListening, delay); }
function showRecording() {
  const status = $('#recording-status'), value = recorder.recorder?.state;
  status.textContent = value === 'recording' ? '🔴 録音中' : value === 'paused' ? '録音一時停止（AI音声除外）' : '録音OFF';
  status.classList.toggle('recording', value === 'recording');
}
function updateGaps() { if (session) { session.recordingGaps = [...recorder.gaps]; view.render(); } showRecording(); }
function cancelSpeech() {
  clearTimeout(recordingResumeTimer); clearTimeout(speechWatchdog);
  speechVersion += 1;
  window.speechSynthesis?.cancel();
  if (speaking) speechTailUntil = Date.now() + 350;
  speaking = false; recorder.resume(); updateGaps();
  ui.speechStatus.textContent = '停止';
}
function speak(text, resumeListening = false, timing = null) {
  if (!text || !('speechSynthesis' in window)) { ui.speechStatus.textContent = '読み上げなし・非対応'; return; }
  if (active && session && (!timing || session.assistantSuggestions.at(-1)?.timing !== timing)) {
    session.suggest({ replies: [text], action: lastAnalysis?.action || '音声テスト', source: lastAnalysis?.source || 'rule' }, null, timing || {});
  }
  // One utterance per turn; never read both a waiting acknowledgement and a delayed final answer.
  cancelSpeech();
  const token = ++speechVersion, currentEpoch = epoch;
  speaking = true; recorder.pause(); showRecording();
  ui.speechStatus.textContent = '読み上げ準備'; ui.ttsEvent.textContent = 'SpeechSynthesis開始待ち';
  const requested = performance.now();
  const utterance = new SpeechSynthesisUtterance(text); utterance.lang = 'ja-JP'; utterance.rate = 1.08; if (japaneseVoice) utterance.voice = japaneseVoice;
  utterance.onstart = () => {
    if (token !== speechVersion || currentEpoch !== epoch) return;
    ui.speechStatus.textContent = '読み上げ中'; ui.ttsEvent.textContent = `開始：${new Date().toLocaleTimeString()}`; setState(STATES.SPEAKING);
    if (timing) {
      timing.speech = Math.round(performance.now() - requested); timing.total = Math.round(performance.now() - timing.firstAt);
      $('#speech-ms').textContent = `${timing.speech}ms`; $('#total-ms').textContent = `${timing.total}ms`;
      latencySamples.push(timing.total);
      $('#average-ms').textContent = `${Math.round(latencySamples.reduce((a, b) => a + b, 0) / latencySamples.length)}ms / ${latencySamples.length}件`;
    }
  };
  const finish = (error) => {
    if (token !== speechVersion || currentEpoch !== epoch) return;
    clearTimeout(speechWatchdog); speaking = false; speechTailUntil = Date.now() + 350;
    recordingResumeTimer = setTimeout(() => { if (token === speechVersion && currentEpoch === epoch) { recorder.resume(); updateGaps(); } }, 350);
    ui.speechStatus.textContent = error ? '読み上げエラー' : '読み上げ完了'; ui.ttsEvent.textContent = `${error ? 'エラー' : '終了'}：${new Date().toLocaleTimeString()}`;
    setState(active ? STATES.LISTENING : STATES.IDLE); if (resumeListening && active) scheduleListening();
  };
  utterance.onend = () => finish(); utterance.onerror = (event) => finish(event.error || '不明');
  speechWatchdog = setTimeout(() => { if (token === speechVersion) { speechSynthesis.cancel(); finish('読み上げタイムアウト'); } }, 12000);
  speechSynthesis.speak(utterance);
}

async function processText(rawText, shouldSpeak = true, entry = null, firstAt = performance.now()) {
  const text = rawText.trim(); if (!text) return;
  const currentEpoch = epoch, version = ++requestVersion, currentSession = session;
  if (shouldSpeak && !active) return;
  setState(STATES.RECOGNIZED); ui.recognitionStatus.textContent = '音声認識成功';
  const context = entry ? currentSession.context() : '';
  const kind = directChat() ? 'chat' : 'coach';
  const fallback = analyzeMessage(text, context);
  showResult(fallback); // Immediate text proposal; speech waits for a single chosen result.
  setState(STATES.PROCESSING);
  ui.aiInput.textContent = context || text; ui.aiProcessing.textContent = 'AI処理開始';
  const started = performance.now();
  const timing = { firstAt, recognition: Math.round(started - firstAt), decision: null, speech: null, total: null };
  $('#recognition-ms').textContent = `${timing.recognition}ms`;
  $('#speech-ms').textContent = '未開始'; $('#total-ms').textContent = '未計測';
  let analysis;
  if (selectedMode() === 'gemini') {
    try {
      const inputSession = entry ? currentSession : chatDemo;
      if (!entry && kind === 'chat') { chatDemo.conversationSession.push({ text, speaker: 'self', timestamp: Date.now() }); chatDemo.conversationSession = chatDemo.conversationSession.slice(-8); }
      analysis = await gemini.analyze(text, kind === 'coach' ? geminiHistory(inputSession) : [], kind, kind === 'chat' ? geminiChatHistory(inputSession) : []);
    } catch (error) { analysis = { ...fallback, kind, fallbackReason: error.message }; }
  } else analysis = await engine.analyze(text, context, fallback, useLocal());
  if (version !== requestVersion || currentEpoch !== epoch || (shouldSpeak && (!active || session !== currentSession))) return;
  timing.decision = Math.round(performance.now() - started);
  $('#decision-ms').textContent = `${timing.decision}ms`; ui.aiTime.textContent = `${timing.decision}ms`;
  ui.aiProcessing.textContent = analysis.source === 'gemini' ? 'Gemini処理完了' : analysis.source === 'local' ? 'ローカルAI処理完了' : 'ルール処理完了（fallback）';
  if (analysis.source === 'gemini') {
    setAIMode('gemini'); $('#gemini-status').textContent = `Gemini応答成功：${analysis.model}`;
    $('#gemini-usage').textContent = `今日のAPI利用 ${analysis.usage.used} / ${analysis.usage.limit}回（失敗・取消を含む）`;
    if (!entry && kind === 'chat') { chatDemo.assistantSuggestions.push({ text: analysis.replies[0] || '', kind: 'chat', timestamp: Date.now() }); chatDemo.assistantSuggestions = chatDemo.assistantSuggestions.slice(-8); }
  } else if (analysis.source === 'local') setAIMode('local');
  else if (localAI.workerError) { aiError = true; setAIMode('error'); setDiagnostic(`${localAI.workerError}。ルールベースで継続します。`); }
  if (analysis.fallbackReason && (useLocal() || selectedMode() === 'gemini')) {
    setDiagnostic(`${selectedMode() === 'gemini' ? 'Gemini' : 'ローカルAI'}：${analysis.fallbackReason}。短いルール応答を採用。`);
    if (selectedMode() === 'gemini') { setAIMode('rule'); $('#gemini-status').textContent = `${analysis.fallbackReason}。ルールで継続しています。`; }
  }
  ui.aiOutput.textContent = analysis.replies.join(' / ') || '今は聞くだけ'; showResult(analysis);
  if (entry) currentSession.suggest(analysis, entry.id, timing);
  setState(active ? STATES.LISTENING : STATES.IDLE);
  if (shouldSpeak && $('#auto-speak').checked) speak(analysis.replies[0], true, timing);
}

function startListening() {
  if (!active || !recognition || recognitionRunning) return;
  try { recognitionRunning = true; recognition.start(); } catch { recognitionRunning = false; scheduleListening(900); }
}
function configureRecognition() {
  if (!Recognition) return false;
  recognition = new Recognition(); recognition.lang = 'ja-JP'; recognition.continuous = false; recognition.interimResults = true;
  const recognizer = recognition;
  recognition.onstart = () => {
    if (recognition !== recognizer) return;
    if (!active) { recognition.stop(); return; }
    recognitionRunning = true; firstTranscriptAt = null; firstTranscriptWall = null; playbackOverlap = false; latestInterim = '';
    ui.recognitionStatus.textContent = '認識中'; ui.recognitionError.textContent = 'なし'; if (!speaking) setState(STATES.LISTENING);
  };
  recognition.onresult = (event) => {
    if (recognition !== recognizer || !active || !session) return;
    let transcript = '', finalText = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      transcript += event.results[i][0].transcript;
      if (event.results[i].isFinal) finalText += event.results[i][0].transcript;
    }
    if (transcript) {
      latestInterim = finalText ? '' : transcript;
      playbackOverlap ||= speaking || Date.now() < speechTailUntil;
      firstTranscriptAt ??= performance.now(); firstTranscriptWall ??= Date.now();
      ui.transcript.textContent = `「${transcript}」`; ui.transcript.classList.remove('empty');
    }
    if (!finalText.trim()) return;
    const speaker = directChat() ? 'self' : $('#next-speaker').value;
    const pending = playbackOverlap || speaking || Date.now() < speechTailUntil || resemblesSuggestion(finalText, session.assistantSuggestions.filter((item) => Date.now() - item.timestamp < 10000));
    const entry = session.add(finalText, speaker, { timestamp: firstTranscriptWall ?? Date.now(), confirmed: speaker === 'self', pending });
    view.render();
    if (pending) setDiagnostic('読み上げとの重複の可能性：発言を確認待ちに保持しました。履歴で実発言かAI音声かを確定してください。');
    else if (speaker !== 'self' || directChat()) processText(finalText, true, entry, firstTranscriptAt ?? performance.now());
    else { ++requestVersion; cancelSpeech(); setState(STATES.LISTENING); }
    firstTranscriptAt = null; firstTranscriptWall = null; playbackOverlap = false;
  };
  recognition.onerror = (event) => {
    if (recognition !== recognizer) return;
    ui.recognitionStatus.textContent = '認識エラー'; ui.recognitionError.textContent = event.error || '不明';
    if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(event.error) && active) {
      setDiagnostic('音声認識を利用できないため対話を終了しました。記録済みの発言は保持します。'); endSession();
    }
  };
  recognition.onend = () => { if (recognition !== recognizer) return; recognitionRunning = false; if (active) { preserveInterim(); scheduleListening(); } };
  return true;
}
function preserveInterim() {
  if (!latestInterim || !session || session.endedAt !== null) return;
  session.add(latestInterim, 'unknown', { timestamp: firstTranscriptWall ?? Date.now(), pending: true });
  latestInterim = ''; view.render();
  setDiagnostic('未確定の認識結果を確認待ちに保持しました。履歴から実発言を確定してください。');
}
async function endSession() {
  if (!active) return;
  active = false; epoch += 1; requestVersion += 1; gemini.cancel(); clearTimeout(restartTimer); clearInterval(clock);
  ui.toggle.disabled = true; ui.toggle.dataset.active = 'false';
  try { recognition?.stop(); } catch { /* Already stopped. */ }
  cancelSpeech(); preserveInterim(); session.end(); $('#elapsed').textContent = durationLabel(session.endedAt - session.startedAt);
  let recording = null;
  try { recording = await recorder.stop(); } catch (error) { setDiagnostic(`録音停止エラー：${error.message}`); }
  session.recordingGaps = [...recorder.gaps]; stopMicrophone(); showRecording();
  view.set(session, recording); await view.save();
  $('#record-enabled').disabled = false; $('#speak-self').disabled = true; ui.toggle.textContent = '● 対話開始'; ui.toggle.disabled = false;
  setState(STATES.IDLE); $('#history-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function startMeter(stream) {
  audioContext ||= new (window.AudioContext || window.webkitAudioContext)(); audioContext.resume(); const analyser = audioContext.createAnalyser(); analyser.fftSize = 256; audioContext.createMediaStreamSource(stream).connect(analyser); const samples = new Uint8Array(analyser.frequencyBinCount);
  const update = () => { analyser.getByteTimeDomainData(samples); const rms = Math.sqrt(samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length); const level = Math.min(100, Math.round(rms * 300)); ui.meterFill.style.width = `${level}%`; ui.micPercent.textContent = `${level}%`; ui.meter.setAttribute('aria-valuenow', level); ui.micStatus.textContent = level > 3 ? '入力中' : '許可済み'; meterFrame = requestAnimationFrame(update); }; update();
}
async function requestMicrophone() { if (!navigator.mediaDevices?.getUserMedia) return true; try { microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); startMeter(microphoneStream); return true; } catch (error) { stopMicrophone(); setDiagnostic(`マイクを利用できません：${error.name}`); return false; } }
function stopMicrophone() { cancelAnimationFrame(meterFrame); microphoneStream?.getTracks().forEach((track) => track.stop()); microphoneStream = null; ui.micStatus.textContent = '停止'; ui.meterFill.style.width = '0%'; ui.micPercent.textContent = '0%'; }

$('#prepare-ai').addEventListener('click', async () => {
  if (!capabilities.usable) return; setAIMode('loading'); ui.progressWrap.hidden = false; $('#prepare-ai').disabled = true;
  try { await localAI.prepare({ onProgress: (percent) => { ui.progress.style.width = `${percent}%`; ui.progressLabel.textContent = `${percent}%`; } }); localReady = true; localAI.ready = true; ui.progress.style.width = '100%'; ui.progressLabel.textContent = '100%'; setAIMode('local'); $('#prepare-ai').textContent = 'モデル準備完了'; }
  catch (error) { aiError = true; setAIMode('error'); $('#prepare-ai').disabled = false; setDiagnostic(`モデル読み込み失敗：${error.message}。ルールベースモードで動作します。`); }
});
$('#mode-select').addEventListener('change', () => {
  requestVersion += 1; gemini.cancel(); cancelSpeech();
  if (selectedMode() === 'gemini') setAIMode(gemini.ready ? 'gemini' : 'rule');
  else if (selectedMode() === 'rule') setAIMode('rule'); else if (localReady) setAIMode('local'); else setAIMode(aiError ? 'error' : 'rule');
});
$('#check-gemini').addEventListener('click', async () => {
  requestVersion += 1; gemini.cancel(); cancelSpeech();
  const button = $('#check-gemini'); button.disabled = true;
  try { const result = await gemini.check(); $('#gemini-status').textContent = result.ready ? `PCの設定あり：${result.model}。送信ONにしてGeminiを選ぶと使えます（実応答は未確認）。` : 'PCの.envにGemini APIキーを設定し、npm startを再起動してください。'; }
  catch (error) { gemini.available = false; $('#gemini-status').textContent = error.message; }
  finally { button.disabled = false; if (selectedMode() === 'gemini') setAIMode(gemini.ready ? 'gemini' : 'rule'); }
});
$('#use-gemini').addEventListener('click', () => { $('#mode-select').value = 'gemini'; $('#mode-select').dispatchEvent(new Event('change')); });
$('#gemini-consent').addEventListener('change', () => {
  requestVersion += 1; gemini.cancel(); cancelSpeech(); gemini.consented = $('#gemini-consent').checked;
  if (selectedMode() === 'gemini') setAIMode(gemini.ready ? 'gemini' : 'rule');
});
$('#talk-kind').addEventListener('change', () => {
  requestVersion += 1; gemini.cancel(); cancelSpeech();
  $('#next-speaker').disabled = directChat(); $('#next-speaker').value = directChat() ? 'self' : 'partner';
  $('#run-demo').textContent = directChat() ? 'JARVISへ送信' : '解析テスト';
});
$('#audio-test').addEventListener('click', () => speak('Respect Talk AI 音声テストです'));
ui.toggle.addEventListener('click', async () => {
  if (active) { await endSession(); return; }
  ui.toggle.disabled = true;
  try {
    if (view.session?.endedAt !== null && view.session) {
      try { await view.store.save(view.session, view.recording); }
      catch (error) { view.message(`前の記録を保存できません：${error.message}。新しい対話を始める前に保存を再試行してください。`); return; }
    }
    recognitionRunning = false;
    if (!configureRecognition()) { ui.note.hidden = false; ui.note.textContent = '音声認識に未対応です。手動解析テストをご利用ください。'; return; }
    if (!await requestMicrophone()) return;
    epoch += 1; requestVersion += 1; cancelSpeech(); speechTailUntil = 0;
    session = new ConversationSession(); latencySamples.length = 0; recorder.reset(); latestInterim = '';
    for (const selector of ['#recognition-ms', '#decision-ms', '#speech-ms', '#total-ms', '#average-ms']) $(selector).textContent = '—';
    view.set(session); active = true; ui.toggle.dataset.active = 'true';
    $('#record-enabled').disabled = true; $('#speak-self').disabled = false;
    if ($('#record-enabled').checked) {
      try { recorder.start(microphoneStream); }
      catch (error) { setDiagnostic(`録音不可：${error.message}。文字記録は継続します。`); }
    }
    showRecording(); $('#elapsed').textContent = '00:00:00';
    clock = setInterval(() => { $('#elapsed').textContent = durationLabel(Date.now() - session.startedAt); }, 1000);
    ui.toggle.textContent = '■ 対話終了'; startListening();
  } finally { ui.toggle.disabled = false; }
});
$('#speak-self').addEventListener('click', () => { $('#next-speaker').value = 'self'; requestVersion += 1; gemini.cancel(); cancelSpeech(); setState(STATES.LISTENING); scheduleListening(0); });
$('#next-speaker').addEventListener('change', () => { if ($('#next-speaker').value === 'self') { requestVersion += 1; gemini.cancel(); cancelSpeech(); } });
$('#auto-speak').addEventListener('change', () => { if (!$('#auto-speak').checked) cancelSpeech(); });
$('#run-demo').addEventListener('click', () => processText($('#demo-input').value, false));
$('#speak-demo').addEventListener('click', () => { if (lastAnalysis) speak(lastAnalysis.replies[0], active); });

ui.capability.textContent = `WebGPU：${capabilities.webgpu ? '利用可能' : '利用不可（WASMを使用）'} / WebAssembly：${capabilities.wasm ? '利用可能' : '利用不可'}${capabilities.memory ? ` / 端末メモリ目安：${capabilities.memory}GB` : ' / メモリ量：取得不可'}${capabilities.warning ? `。${capabilities.warning}` : ''}`;
if (!capabilities.usable) { $('#prepare-ai').disabled = true; ui.note.hidden = false; ui.note.textContent = 'この端末ではローカルAIを利用できないためルールベースモードで動作しています'; }
setState(STATES.IDLE); setAIMode('rule'); loadVoices();
if ('speechSynthesis' in window) speechSynthesis.addEventListener('voiceschanged', loadVoices);
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js'));
