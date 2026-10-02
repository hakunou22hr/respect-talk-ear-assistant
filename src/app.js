import { analyzeMessage, STATES } from './coach.js';

const $ = (selector) => document.querySelector(selector);
const ui = {
  icon: $('#status-icon'), label: $('#status-label'), help: $('#status-help'), toggle: $('#toggle-session'), note: $('#support-note'),
  result: $('#result'), transcript: $('#transcript'), emotion: $('#emotion'), intent: $('#intent'), action: $('#action'), badge: $('#category-badge'), suggestions: $('#suggestions')
};
const STATUS = {
  [STATES.IDLE]: ['🎙', '開始前です', 'イヤホンを確認して、会話サポートを開始してください'],
  [STATES.LISTENING]: ['🎙', '聞いています', '相手の話が終わると、自動で提案します'],
  [STATES.PROCESSING]: ['🧠', '考えています', '気持ちと会話の意図を整理しています'],
  [STATES.SPEAKING]: ['👂', '耳元に提案しています', '読み上げ中は音声認識を停止しています']
};
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let state = STATES.IDLE;
let active = false;
let lastAnalysis = null;

function setState(next) {
  state = next;
  const [icon, label, help] = STATUS[next];
  ui.icon.textContent = icon; ui.label.textContent = label; ui.help.textContent = help;
  document.body.dataset.state = next;
}

function showResult(analysis) {
  lastAnalysis = analysis;
  ui.result.hidden = false;
  ui.transcript.textContent = `「${analysis.text}」`;
  ui.emotion.textContent = analysis.emotion; ui.intent.textContent = analysis.intent; ui.action.textContent = analysis.action; ui.badge.textContent = analysis.action;
  ui.suggestions.replaceChildren(...analysis.replies.map((reply, index) => {
    const li = document.createElement('li'); li.textContent = reply; if (index === 0) li.className = 'best'; return li;
  }));
}

function speak(text, resumeListening = false) {
  if (!('speechSynthesis' in window)) { ui.note.hidden = false; ui.note.textContent = 'このブラウザは音声読み上げに対応していません。'; return; }
  if (recognition) { try { recognition.stop(); } catch {} }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'ja-JP'; utterance.rate = 1.02;
  utterance.onstart = () => setState(STATES.SPEAKING);
  utterance.onend = () => { if (resumeListening && active) startListening(); else setState(active ? STATES.LISTENING : STATES.IDLE); };
  utterance.onerror = () => { if (resumeListening && active) startListening(); else setState(STATES.IDLE); };
  window.speechSynthesis.speak(utterance);
}

function processText(text, shouldSpeak = true) {
  setState(STATES.PROCESSING);
  const analysis = analyzeMessage(text);
  if (!analysis) { if (active) startListening(); return; }
  showResult(analysis);
  window.setTimeout(() => shouldSpeak ? speak(analysis.replies[0], true) : setState(active ? STATES.LISTENING : STATES.IDLE), 350);
}

function startListening() {
  if (!active || !recognition) return;
  setState(STATES.LISTENING);
  try { recognition.start(); } catch { /* already active */ }
}

function configureRecognition() {
  if (!Recognition) return false;
  recognition = new Recognition(); recognition.lang = 'ja-JP'; recognition.continuous = false; recognition.interimResults = true;
  recognition.onresult = (event) => {
    let finalText = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) if (event.results[i].isFinal) finalText += event.results[i][0].transcript;
    if (finalText) processText(finalText);
  };
  recognition.onend = () => { if (active && state === STATES.LISTENING) window.setTimeout(startListening, 250); };
  recognition.onerror = (event) => { if (event.error === 'not-allowed') { active = false; setState(STATES.IDLE); ui.note.hidden = false; ui.note.textContent = 'マイクの使用を許可してください。'; ui.toggle.textContent = '会話サポートを開始'; } };
  return true;
}

$('#audio-test').addEventListener('click', () => speak('Respect Talk AIを開始します'));
ui.toggle.addEventListener('click', () => {
  if (active) { active = false; recognition?.stop(); window.speechSynthesis?.cancel(); setState(STATES.IDLE); ui.toggle.textContent = '会話サポートを開始'; return; }
  if (!recognition && !configureRecognition()) { ui.note.hidden = false; ui.note.textContent = '音声認識に未対応です。デモ会話テストをご利用ください。'; return; }
  active = true; ui.note.hidden = true; ui.toggle.textContent = 'サポートを終了'; startListening();
});
$('#run-demo').addEventListener('click', () => { const analysis = analyzeMessage($('#demo-input').value); if (!analysis) return; showResult(analysis); setState(STATES.PROCESSING); $('#speak-demo').disabled = false; window.setTimeout(() => setState(STATES.IDLE), 350); });
$('#speak-demo').addEventListener('click', () => { if (lastAnalysis) speak(lastAnalysis.replies[0]); });

setState(STATES.IDLE);
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js'));
