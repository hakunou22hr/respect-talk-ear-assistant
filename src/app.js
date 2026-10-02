import { analyzeMessage, STATES } from './coach.js';

const $ = (selector) => document.querySelector(selector);
const ui = {
  icon: $('#status-icon'), label: $('#status-label'), help: $('#status-help'), toggle: $('#toggle-session'), note: $('#support-note'),
  transcript: $('#transcript'), emotion: $('#emotion'), intent: $('#intent'), action: $('#action'), badge: $('#category-badge'), suggestions: $('#suggestions'),
  micStatus: $('#mic-status'), recognitionStatus: $('#recognition-status'), recognitionError: $('#recognition-error'), speechStatus: $('#speech-status'),
  voiceStatus: $('#voice-status'), diagnosticMessage: $('#diagnostic-message'), meter: $('#mic-meter'), meterFill: $('#mic-meter span'), micPercent: $('#mic-percent')
};
const STATUS = {
  [STATES.IDLE]: ['🎙', 'IDLE', 'イヤホンを確認して、対話サポートを開始してください'],
  [STATES.LISTENING]: ['🎙', 'LISTENING', '相手の声を聞いています'],
  [STATES.RECOGNIZED]: ['✓', 'RECOGNIZED', '日本語の音声を認識しました'],
  [STATES.PROCESSING]: ['🧠', 'PROCESSING', '気持ちと会話の意図を分析しています'],
  [STATES.SPEAKING]: ['👂', 'SPEAKING', '候補1を読み上げています']
};
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let recognitionRunning = false;
let restartTimer = null;
let state = STATES.IDLE;
let active = false;
let lastAnalysis = null;
let microphoneStream = null;
let audioContext = null;
let meterFrame = null;
let japaneseVoice = null;

function setState(next) {
  state = next;
  const [icon, label, help] = STATUS[next];
  ui.icon.textContent = icon;
  ui.label.textContent = label;
  ui.help.textContent = help;
  document.body.dataset.state = next;
}

function setDiagnostic(message) {
  ui.diagnosticMessage.textContent = message;
}

function showResult(analysis) {
  lastAnalysis = analysis;
  ui.transcript.textContent = `「${analysis.text}」`;
  ui.transcript.classList.remove('empty');
  ui.emotion.textContent = analysis.emotion;
  ui.intent.textContent = analysis.intent;
  ui.action.textContent = analysis.action;
  ui.badge.textContent = analysis.action;
  ui.suggestions.replaceChildren(...analysis.replies.map((reply, index) => {
    const li = document.createElement('li');
    li.textContent = `候補${index + 1}「${reply}」`;
    if (index === 0) li.className = 'best';
    return li;
  }));
  const canSpeak = analysis.replies.length > 0;
  $('#speak-demo').disabled = !canSpeak;
  $('#speak-candidate').disabled = !canSpeak;
}

function loadVoices() {
  if (!('speechSynthesis' in window)) {
    ui.voiceStatus.textContent = '非対応';
    return;
  }
  const voices = window.speechSynthesis.getVoices();
  japaneseVoice = voices.find((voice) => voice.lang === 'ja-JP') || voices.find((voice) => voice.lang.startsWith('ja')) || null;
  ui.voiceStatus.textContent = japaneseVoice ? `${japaneseVoice.name} (${japaneseVoice.lang})` : (voices.length ? '日本語voiceなし（端末既定を使用）' : '読み込み待ち');
}

function scheduleListening(delay = 400) {
  window.clearTimeout(restartTimer);
  if (!active) return;
  restartTimer = window.setTimeout(startListening, delay);
}

function speak(text, resumeListening = false) {
  if (!text) {
    ui.speechStatus.textContent = '読み上げエラー';
    setDiagnostic('返答案を生成できませんでした');
    return;
  }
  if (!('speechSynthesis' in window)) {
    ui.speechStatus.textContent = '読み上げエラー';
    setDiagnostic('このブラウザは音声読み上げに対応していません。');
    return;
  }
  ui.speechStatus.textContent = '読み上げ準備';
  setDiagnostic(`候補1を読み上げへ渡しました：「${text}」`);
  if (recognitionRunning) recognition.stop();
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'ja-JP';
  utterance.rate = 1;
  if (japaneseVoice) utterance.voice = japaneseVoice;
  utterance.onstart = () => {
    ui.speechStatus.textContent = '読み上げ開始';
    setState(STATES.SPEAKING);
    window.setTimeout(() => { if (state === STATES.SPEAKING) ui.speechStatus.textContent = '読み上げ中'; }, 200);
  };
  utterance.onend = () => {
    ui.speechStatus.textContent = '読み上げ完了';
    setDiagnostic('読み上げが完了しました。音が聞こえない場合はiPhoneの出力先と音量を確認してください。');
    if (resumeListening && active) scheduleListening(); else setState(active ? STATES.LISTENING : STATES.IDLE);
  };
  utterance.onerror = (event) => {
    ui.speechStatus.textContent = '読み上げエラー';
    setDiagnostic(`読み上げエラー：${event.error || '詳細不明'}`);
    if (resumeListening && active) scheduleListening(); else setState(STATES.IDLE);
  };
  // iOSではcancel直後のspeakが不安定になるため、短い間隔を空ける。
  window.setTimeout(() => window.speechSynthesis.speak(utterance), 120);
}

function processText(text, shouldSpeak = true) {
  setState(STATES.RECOGNIZED);
  ui.recognitionStatus.textContent = '認識成功';
  ui.transcript.textContent = `「${text}」`;
  ui.transcript.classList.remove('empty');
  window.setTimeout(() => {
    setState(STATES.PROCESSING);
    const analysis = analyzeMessage(text);
    if (!analysis || !analysis.replies.length) {
      setDiagnostic('返答案を生成できませんでした');
      ui.speechStatus.textContent = '待機';
      if (active) scheduleListening();
      return;
    }
    showResult(analysis);
    setDiagnostic('認識結果をcoach.jsへ渡し、返答候補を生成しました。');
    window.setTimeout(() => shouldSpeak ? speak(analysis.replies[0], true) : setState(active ? STATES.LISTENING : STATES.IDLE), 250);
  }, 250);
}

function startListening() {
  if (!active || !recognition || recognitionRunning || state === STATES.SPEAKING) return;
  try {
    recognition.start();
  } catch (error) {
    setDiagnostic(`音声認識を開始できません：${error.message}`);
    scheduleListening(800);
  }
}

function configureRecognition() {
  if (!Recognition) return false;
  recognition = new Recognition();
  recognition.lang = 'ja-JP';
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.onstart = () => {
    recognitionRunning = true;
    ui.recognitionStatus.textContent = '認識中';
    ui.recognitionError.textContent = 'なし';
    setState(STATES.LISTENING);
    setDiagnostic('日本語（ja-JP）の音声認識を開始しました。');
  };
  recognition.onresult = (event) => {
    let transcript = '';
    let finalText = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      transcript += event.results[i][0].transcript;
      if (event.results[i].isFinal) finalText += event.results[i][0].transcript;
    }
    if (transcript) {
      ui.transcript.textContent = `「${transcript}」`;
      ui.transcript.classList.remove('empty');
    }
    if (finalText) processText(finalText);
  };
  recognition.onerror = (event) => {
    ui.recognitionStatus.textContent = '認識エラー';
    ui.recognitionError.textContent = event.error || '詳細不明';
    setDiagnostic(`音声認識エラー：${event.error || '詳細不明'}`);
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      active = false;
      ui.micStatus.textContent = '未許可';
      ui.toggle.textContent = '対話サポート開始';
      setState(STATES.IDLE);
    }
  };
  recognition.onend = () => {
    recognitionRunning = false;
    if (active && state === STATES.LISTENING) {
      ui.recognitionStatus.textContent = '待機';
      scheduleListening();
    }
  };
  return true;
}

function startMeter(stream) {
  audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
  audioContext.resume();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  audioContext.createMediaStreamSource(stream).connect(analyser);
  const samples = new Uint8Array(analyser.frequencyBinCount);
  const update = () => {
    analyser.getByteTimeDomainData(samples);
    const rms = Math.sqrt(samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length);
    const level = Math.min(100, Math.round(rms * 300));
    ui.meterFill.style.width = `${level}%`;
    ui.micPercent.textContent = `${level}%`;
    ui.meter.setAttribute('aria-valuenow', String(level));
    ui.micStatus.textContent = level > 3 ? '入力中' : '許可済み';
    meterFrame = window.requestAnimationFrame(update);
  };
  update();
}

async function requestMicrophone() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setDiagnostic('getUserMediaに未対応です。音声認識の権限確認へ進みます。');
    return true;
  }
  try {
    microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    ui.micStatus.textContent = '許可済み';
    startMeter(microphoneStream);
    return true;
  } catch (error) {
    ui.micStatus.textContent = '未許可';
    setDiagnostic(`マイクを利用できません：${error.name}`);
    return false;
  }
}

function stopMicrophone() {
  window.cancelAnimationFrame(meterFrame);
  microphoneStream?.getTracks().forEach((track) => track.stop());
  microphoneStream = null;
  ui.micStatus.textContent = '停止';
  ui.meterFill.style.width = '0%';
  ui.micPercent.textContent = '0%';
  ui.meter.setAttribute('aria-valuenow', '0');
}

$('#audio-test').addEventListener('click', () => speak('Respect Talk AI 音声テストです'));
ui.toggle.addEventListener('click', async () => {
  if (active) {
    active = false;
    window.clearTimeout(restartTimer);
    if (recognitionRunning) recognition.stop();
    window.speechSynthesis?.cancel();
    stopMicrophone();
    ui.recognitionStatus.textContent = '待機';
    ui.speechStatus.textContent = '待機';
    setState(STATES.IDLE);
    ui.toggle.textContent = '対話サポート開始';
    setDiagnostic('対話サポートを停止しました。');
    return;
  }
  ui.note.hidden = true;
  if (!await requestMicrophone()) {
    ui.note.hidden = false;
    ui.note.textContent = 'iPhoneの設定でSafariのマイク使用を許可してください。';
    return;
  }
  if (!recognition && !configureRecognition()) {
    ui.note.hidden = false;
    ui.note.textContent = '音声認識に未対応です。手動解析テストをご利用ください。';
    stopMicrophone();
    return;
  }
  active = true;
  ui.toggle.textContent = '対話サポート停止';
  startListening();
});

$('#run-demo').addEventListener('click', () => {
  const text = $('#demo-input').value;
  const analysis = analyzeMessage(text);
  if (!analysis) {
    setDiagnostic('返答案を生成できませんでした');
    $('#speak-demo').disabled = true;
    $('#speak-candidate').disabled = true;
    return;
  }
  setState(STATES.PROCESSING);
  showResult(analysis);
  setDiagnostic('テスト文章をcoach.jsで解析しました。候補1を音声テストできます。');
  window.setTimeout(() => setState(active ? STATES.LISTENING : STATES.IDLE), 350);
});
$('#speak-demo').addEventListener('click', () => { if (lastAnalysis) speak(lastAnalysis.replies[0]); });
$('#speak-candidate').addEventListener('click', () => { if (lastAnalysis) speak(lastAnalysis.replies[0]); });

setState(STATES.IDLE);
loadVoices();
if ('speechSynthesis' in window) window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js'));
