const RULES = [
  { emotion: '落ち込み', intent: '気持ちを受け止めてほしい', action: '共感', words: ['失敗', '落ち込', 'つら', '辛', '悲し', 'しんど', '疲れ'], replies: ['それは大変だったね。', 'つらかったね。', 'もう少し聞いてもいい？'] },
  { emotion: '喜び', intent: 'うれしい出来事を共有したい', action: '共有', words: ['嬉し', 'うれし', '成功', 'できた', '合格', '楽しかった'], replies: ['それは嬉しいね。', 'よかったね！', 'どんなところが嬉しかった？'] },
  { emotion: '不安', intent: '安心や助言を求めている', action: '今は聞く', words: ['不安', '心配', '怖', 'どうしよう', '悩ん'], replies: ['そっか、不安なんだね。', 'ゆっくり聞かせて。', '何がいちばん心配？'] },
  { emotion: '怒り', intent: '不満をわかってほしい', action: '共感', words: ['怒', 'むかつ', '腹が立', '許せない'], replies: ['それは腹が立つよね。', 'そう感じるのも無理ないよ。', '何があったか聞いてもいい？'] },
  { emotion: '迷い', intent: '考えを整理したい', action: '質問', words: ['迷って', 'どっち', '決められ', 'どう思う'], replies: ['どこで迷っているの？', '一緒に整理してみようか。', '今はどちらに惹かれてる？'] }
];

export function analyzeMessage(rawText) {
  const text = rawText.trim();
  if (!text) return null;
  const rule = RULES.find((item) => item.words.some((word) => text.includes(word)));
  if (rule) return { text, emotion: rule.emotion, intent: rule.intent, action: rule.action, replies: [...rule.replies] };
  if (/[？?]$/.test(text) || /教えて|知ってる|かな/.test(text)) {
    return { text, emotion: '関心', intent: '答えや意見を聞きたい', action: '確認', replies: ['なるほど、確認してみるね。', 'もう少し詳しく聞いてもいい？', 'つまり、こういうことかな？'] };
  }
  return { text, emotion: '穏やか', intent: '出来事や考えを共有したい', action: '相槌', replies: ['そうなんだ。', 'なるほど、そういうことか。', 'それで、どうなったの？'] };
}

export const STATES = Object.freeze({ IDLE: 'idle', LISTENING: 'listening', PROCESSING: 'processing', SPEAKING: 'speaking' });
