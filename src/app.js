import { analyzeMessage, STATES } from './coach.js';
import { ConversationHistory } from './conversation.js';
import { inspectCapabilities, LocalAI } from './local-ai.js';

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
const history = new ConversationHistory(6);
const localAI = new LocalAI();
let recognition = null, recognitionRunning = false, restartTimer = null, state = STATES.IDLE, active = false;
let lastAnalysis = null, microphoneStream = null, audioContext = null, meterFrame = null, japaneseVoice = null;
let localReady = false, aiError = false, speaking = false, lastQuickAckAt = 0;
const capabilities = inspectCapabilities();

function setState(next) {
  state = next;
  const [icon, label, help] = STATUS[next];
  ui.icon.textContent = icon; ui.label.textContent = label; ui.help.textContent = help;
  document.body.dataset.state = next;
}
function setDiagnostic(message) { ui.diagnosticMessage.textContent = message; }
function setAIMode(kind) {
  const states = { local: ['🟢 ローカル生成AI', 'local'], loading: ['🟡 モデル読み込み中', 'loading'], rule: ['🔵 ルールベース', 'rule'], error: ['🔴 AIエラー', 'error'] };
  const [label, style] = states[kind]; ui.aiMode.textContent = label; ui.aiMode.className = `mode-badge ${style}`;
}
function selectedMode() { return $('#mode-select').value; }
function useLocal() { return localReady && selectedMode() !== 'rule'; }

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
function scheduleListening(delay = 450) { clearTimeout(restartTimer); if (active && !speaking) restartTimer = setTimeout(startListening, delay); }
function speak(text, resumeListening = false) {
  if (!text || !('speechSynthesis' in window)) { ui.speechStatus.textContent = '読み上げエラー'; return; }
  speaking = true; clearTimeout(restartTimer); if (recognitionRunning) recognition.stop(); speechSynthesis.cancel();
  ui.speechStatus.textContent = '読み上げ準備'; ui.ttsEvent.textContent = 'SpeechSynthesis開始待ち';
  const utterance = new SpeechSynthesisUtterance(text); utterance.lang = 'ja-JP'; if (japaneseVoice) utterance.voice = japaneseVoice;
  utterance.onstart = () => { ui.speechStatus.textContent = '読み上げ中'; ui.ttsEvent.textContent = `開始：${new Date().toLocaleTimeString()}`; setState(STATES.SPEAKING); };
  const finish = (error) => { speaking = false; ui.speechStatus.textContent = error ? '読み上げエラー' : '読み上げ完了'; ui.ttsEvent.textContent = `${error ? 'エラー' : '終了'}：${new Date().toLocaleTimeString()}`; if (resumeListening && active) scheduleListening(); else setState(active ? STATES.LISTENING : STATES.IDLE); };
  utterance.onend = () => finish(); utterance.onerror = (event) => finish(event.error || '不明');
  setTimeout(() => speechSynthesis.speak(utterance), 120);
}

async function processText(rawText, shouldSpeak = true) {
  const text = rawText.trim(); if (!text) return;
  setState(STATES.RECOGNIZED); ui.recognitionStatus.textContent = '音声認識成功'; ui.transcript.textContent = `「${text}」`; ui.transcript.classList.remove('empty');
  history.add('partner', text); const fallback = analyzeMessage(text);
  // 生成待ちを埋める短い相槌は15秒のクールダウンで、長めの発言だけに限定する。
  if (shouldSpeak && useLocal() && text.length >= 12 && Date.now() - lastQuickAckAt > 15000) { lastQuickAckAt = Date.now(); speak(fallback.replies[0], false); }
  await new Promise((resolve) => setTimeout(resolve, 180)); setState(STATES.PROCESSING);
  ui.aiInput.textContent = history.context(); ui.aiProcessing.textContent = 'AI処理開始'; const started = performance.now();
  let analysis = fallback;
  if (useLocal()) {
    try { analysis = await localAI.analyze(text, history.context(), fallback); setAIMode('local'); aiError = false; }
    catch (error) { aiError = true; setAIMode('error'); setDiagnostic(`ローカルAI失敗：${error.message}。ルールベースへ自動fallbackしました。`); }
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  ui.aiTime.textContent = `生成時間 ${seconds}秒`; ui.aiProcessing.textContent = analysis.source === 'local' ? 'ローカルAI処理完了' : 'ルール処理完了（fallback）';
  ui.aiOutput.textContent = analysis.replies.join(' / '); showResult(analysis); history.add('assistant', analysis.replies[0]);
  setState(STATES.IDLE); ui.label.textContent = '返答案完成'; ui.icon.textContent = '💡'; ui.help.textContent = `${analysis.source === 'local' ? 'ローカル生成AI' : 'ルールベース'}・${seconds}秒`;
  if (shouldSpeak && $('#auto-speak').checked) speak(analysis.replies[0], true); else if (active) scheduleListening();
}

function startListening() { if (!active || !recognition || recognitionRunning || speaking || state === STATES.PROCESSING) return; try { recognition.start(); } catch { scheduleListening(900); } }
function configureRecognition() {
  if (!Recognition) return false; recognition = new Recognition(); recognition.lang = 'ja-JP'; recognition.continuous = false; recognition.interimResults = true;
  recognition.onstart = () => { recognitionRunning = true; ui.recognitionStatus.textContent = '認識中'; ui.recognitionError.textContent = 'なし'; setState(STATES.LISTENING); };
  recognition.onresult = (event) => { let transcript = '', finalText = ''; for (let i = event.resultIndex; i < event.results.length; i += 1) { transcript += event.results[i][0].transcript; if (event.results[i].isFinal) finalText += event.results[i][0].transcript; } if (transcript) { ui.transcript.textContent = `「${transcript}」`; ui.transcript.classList.remove('empty'); } if (finalText && !speaking) processText(finalText); };
  recognition.onerror = (event) => { ui.recognitionStatus.textContent = '認識エラー'; ui.recognitionError.textContent = event.error || '不明'; if (['not-allowed', 'service-not-allowed'].includes(event.error)) { active = false; setState(STATES.IDLE); } };
  recognition.onend = () => { recognitionRunning = false; if (active && state === STATES.LISTENING && !speaking) scheduleListening(); }; return true;
}
function startMeter(stream) {
  audioContext ||= new (window.AudioContext || window.webkitAudioContext)(); audioContext.resume(); const analyser = audioContext.createAnalyser(); analyser.fftSize = 256; audioContext.createMediaStreamSource(stream).connect(analyser); const samples = new Uint8Array(analyser.frequencyBinCount);
  const update = () => { analyser.getByteTimeDomainData(samples); const rms = Math.sqrt(samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length); const level = Math.min(100, Math.round(rms * 300)); ui.meterFill.style.width = `${level}%`; ui.micPercent.textContent = `${level}%`; ui.meter.setAttribute('aria-valuenow', level); ui.micStatus.textContent = level > 3 ? '入力中' : '許可済み'; meterFrame = requestAnimationFrame(update); }; update();
}
async function requestMicrophone() { if (!navigator.mediaDevices?.getUserMedia) return true; try { microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true }); startMeter(microphoneStream); return true; } catch (error) { setDiagnostic(`マイクを利用できません：${error.name}`); return false; } }
function stopMicrophone() { cancelAnimationFrame(meterFrame); microphoneStream?.getTracks().forEach((track) => track.stop()); microphoneStream = null; ui.micStatus.textContent = '停止'; ui.meterFill.style.width = '0%'; ui.micPercent.textContent = '0%'; }

$('#prepare-ai').addEventListener('click', async () => {
  if (!capabilities.usable) return; setAIMode('loading'); ui.progressWrap.hidden = false; $('#prepare-ai').disabled = true;
  try { await localAI.prepare({ onProgress: (percent) => { ui.progress.style.width = `${percent}%`; ui.progressLabel.textContent = `${percent}%`; } }); localReady = true; ui.progress.style.width = '100%'; ui.progressLabel.textContent = '100%'; setAIMode('local'); $('#prepare-ai').textContent = 'モデル準備完了'; }
  catch (error) { aiError = true; setAIMode('error'); $('#prepare-ai').disabled = false; setDiagnostic(`モデル読み込み失敗：${error.message}。ルールベースモードで動作します。`); }
});
$('#mode-select').addEventListener('change', () => { if (selectedMode() === 'rule') setAIMode('rule'); else if (localReady) setAIMode('local'); else setAIMode(aiError ? 'error' : 'rule'); });
$('#audio-test').addEventListener('click', () => speak('Respect Talk AI 音声テストです'));
ui.toggle.addEventListener('click', async () => { if (active) { active = false; clearTimeout(restartTimer); if (recognitionRunning) recognition.stop(); speechSynthesis?.cancel(); stopMicrophone(); setState(STATES.IDLE); ui.toggle.textContent = '対話サポート開始'; return; } if (!await requestMicrophone()) return; if (!recognition && !configureRecognition()) { ui.note.hidden = false; ui.note.textContent = '音声認識に未対応です。手動解析テストをご利用ください。'; stopMicrophone(); return; } active = true; ui.toggle.textContent = '対話サポート停止'; startListening(); });
$('#run-demo').addEventListener('click', () => processText($('#demo-input').value, false));
$('#speak-demo').addEventListener('click', () => { if (lastAnalysis) speak(lastAnalysis.replies[0], active); });

ui.capability.textContent = `WebGPU：${capabilities.webgpu ? '利用可能' : '利用不可（WASMを使用）'} / WebAssembly：${capabilities.wasm ? '利用可能' : '利用不可'}${capabilities.memory ? ` / 端末メモリ目安：${capabilities.memory}GB` : ' / メモリ量：取得不可'}${capabilities.warning ? `。${capabilities.warning}` : ''}`;
if (!capabilities.usable) { $('#prepare-ai').disabled = true; ui.note.hidden = false; ui.note.textContent = 'この端末ではローカルAIを利用できないためルールベースモードで動作しています'; }
setState(STATES.IDLE); setAIMode('rule'); loadVoices();
if ('speechSynthesis' in window) speechSynthesis.addEventListener('voiceschanged', loadVoices);
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js'));
