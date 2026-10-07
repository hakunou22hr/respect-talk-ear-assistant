import { ConversationSession, SPEAKERS, durationLabel, minutesInput, extractiveMinutes, formatMinutes } from './session.js';
import { SessionStore } from './storage.js';

const $ = (selector) => document.querySelector(selector);
export class SessionView {
  constructor(ai, engine) {
    this.ai = ai; this.engine = engine; this.store = new SessionStore(); this.session = null; this.recording = null; this.url = null;
    this.onChange = () => {};
    $('#save-session').onclick = () => this.save();
    $('#session-title').onchange = () => { if (this.session) this.session.title = $('#session-title').value.trim() || '会話'; };
    $('#participants').onchange = () => { if (this.session) { this.session.participants = $('#participants').value.trim() || '相手、私'; this.invalidate(); } };
    $('#create-minutes').onclick = () => this.summarize();
    $('#summary-level').onchange = () => this.invalidate();
    $('#add-utterance').onclick = () => {
      const text = $('#actual-input').value.trim(); if (!this.session || !text) return;
      // User-authored corrections are real speech, never the manual AI test or AI suggestions.
      const endedAt = this.session.endedAt; this.session.endedAt = null;
      this.session.add(text, $('#next-speaker').value, { confirmed: true, timestamp: endedAt ?? Date.now() });
      this.session.endedAt = endedAt;
      $('#actual-input').value = ''; this.render(); this.onChange();
    };
    this.refreshSaved();
  }
  message(text) { $('#session-message').textContent = text; }
  invalidate() { if (this.session) this.session.minutes = null; $('#minutes-output').textContent = ''; }
  set(session, recording = null) {
    this.session = session; this.recording = recording;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = recording?.size ? URL.createObjectURL(recording) : null;
    const player = $('#recording-player'); player.hidden = !this.url;
    if (this.url) player.src = this.url; else player.removeAttribute('src');
    this.render();
  }
  render() {
    const session = this.session; if (!session) return;
    $('#history-panel').hidden = false;
    $('#session-title').value = session.title;
    $('#participants').value = session.participants;
    $('#create-minutes').hidden = session.endedAt === null;
    $('#save-session').hidden = session.endedAt === null;
    $('#minutes-output').textContent = session.minutes?.text || '';
    $('#history-list').replaceChildren(...session.conversationSession.map((item) => {
      const li = document.createElement('li'); li.className = 'utterance';
      const meta = document.createElement('p'); meta.className = 'small';
      meta.textContent = `${new Date(item.timestamp).toLocaleTimeString('ja-JP')} ${SPEAKERS[item.speaker]}${item.confirmed ? '' : '（話者未確認）'}`;
      const text = document.createElement('textarea'); text.value = item.text; text.rows = 2; text.setAttribute('aria-label', '発言を修正');
      text.onchange = () => { session.edit(item.id, { text: text.value }); this.render(); this.onChange(); };
      const actions = document.createElement('div'); actions.className = 'entry-actions';
      for (const speaker of ['partner', 'self']) {
        const button = document.createElement('button'); button.textContent = SPEAKERS[speaker]; button.className = 'secondary';
        button.setAttribute('aria-pressed', String(item.speaker === speaker));
        button.onclick = () => { session.edit(item.id, { speaker }); this.render(); this.onChange(); }; actions.append(button);
      }
      const remove = document.createElement('button'); remove.textContent = '削除'; remove.className = 'secondary';
      remove.onclick = () => { session.remove(item.id); this.render(); this.onChange(); }; actions.append(remove);
      li.append(meta, text, actions); return li;
    }));
    $('#pending-list').replaceChildren(...session.pendingUtterances.map((item) => {
      const li = document.createElement('li'); const text = document.createElement('span'); text.textContent = `${new Date(item.timestamp).toLocaleTimeString('ja-JP')} ${item.text}`;
      li.append(text);
      for (const speaker of ['partner', 'self', null]) {
        const button = document.createElement('button'); button.className = 'secondary'; button.textContent = speaker ? `${SPEAKERS[speaker]}の実発言` : 'AI音声として除外';
        button.onclick = () => { session.resolve(item.id, speaker); this.render(); this.onChange(); }; li.append(button);
      }
      return li;
    }));
    $('#pending-panel').hidden = !session.pendingUtterances.length;
    $('#recording-gaps').textContent = session.recordingGaps.length ? `録音除外区間 ${session.recordingGaps.length}件：${session.recordingGaps.map((gap) => `${new Date(gap.startedAt).toLocaleTimeString('ja-JP')}〜${new Date(gap.endedAt).toLocaleTimeString('ja-JP')}`).join('、')}。この間の実発言は録音に含まれません。` : '';
  }
  async save() {
    if (!this.session || this.session.endedAt === null) return;
    try { await this.store.save(this.session, this.recording); this.message('この端末に保存しました。編集後は再度「保存」を押してください。'); await this.refreshSaved(); }
    catch (error) { this.message(`保存失敗：${error.message}。画面の記録は保持しています。`); }
  }
  async refreshSaved() {
    try {
      const saved = await this.store.list();
      $('#saved-sessions').replaceChildren(...saved.map((item) => {
        const li = document.createElement('li'); const text = document.createElement('span');
        text.textContent = `${new Date(item.startedAt).toLocaleString('ja-JP')} / ${durationLabel(item.endedAt - item.startedAt)} / ${item.title}`;
        const open = document.createElement('button'); open.className = 'secondary'; open.textContent = '開く';
        open.onclick = () => { if ($('#toggle-session').dataset.active === 'true' || $('#toggle-session').disabled) { this.message('現在の対話を終了してから開いてください。'); return; } this.set(ConversationSession.restore(item), item.recording); };
        const remove = document.createElement('button'); remove.className = 'secondary'; remove.textContent = '削除';
        remove.onclick = async () => {
          if (!window.confirm(`「${item.title}」の会話・録音を端末から削除しますか？`)) return;
          try {
            await this.store.delete(item.id);
            if (this.session?.id === item.id) { this.session = null; this.recording = null; if (this.url) URL.revokeObjectURL(this.url); this.url = null; $('#recording-player').pause(); $('#recording-player').removeAttribute('src'); $('#history-panel').hidden = true; }
            await this.refreshSaved(); this.message('保存済み会話と録音を削除しました。');
          } catch (error) { this.message(`削除失敗：${error.message}`); }
        };
        li.append(text, open, remove); return li;
      }));
    } catch (error) { this.message(`端末内保存を利用できません：${error.message}`); }
  }
  async summarize() {
    const session = this.session; if (!session || session.endedAt === null) return;
    const input = minutesInput(session), snapshot = JSON.stringify(input), level = $('#summary-level').value;
    const button = $('#create-minutes'); button.disabled = true; this.message('端末内で議事録を作成中…');
    let result = extractiveMinutes(input, level), timer;
    try {
      if (this.ai.ready && !this.engine.busy && input.utterances.length && JSON.stringify(input).length <= 12000) {
        this.engine.busy = true;
        const generation = this.ai.summarize(input, level).finally(() => { this.engine.busy = false; });
        result = await Promise.race([generation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('議事録の応答時間を超過')), 30000); })]);
      }
    } catch (error) { this.message(`AI要約失敗：${error.message}。実発言の抽出へ切り替えました。`); }
    finally { clearTimeout(timer); button.disabled = false; }
    if (this.session !== session || JSON.stringify(minutesInput(session)) !== snapshot || $('#summary-level').value !== level) { this.message('会話が変更されたため、議事録をもう一度作成してください。'); return; }
    session.minutes = { ...result, text: formatMinutes(input, result) };
    this.render(); this.message(`${result.source === 'local' ? 'ローカルAI' : '実発言抽出'}で作成しました。内容を確認して保存してください。未確認の話者・読み上げ重複は履歴で修正できます。`);
  }
}
