/**
 * 生视频音轨设置
 *
 * 语义对标参考站 video-audio.js：音轨不是一个独立的上游参数，而是**编译成提示词片段**
 * 交给视频模型去理解。因此这里保持同样的纯函数形态（settings / describe / support），
 * 页面只负责采集与展示。
 *
 * 诚实边界：能否真正出声取决于「模型配置」页当前配的视频模型。多数通用视频模型只出画面，
 * 所以界面必须把这一点说清楚，不能让用户以为选了就一定有声。
 */

export type AudioMode = 'silent' | 'effects' | 'music' | 'both';

export const AUDIO_MODES: { value: AudioMode; label: string }[] = [
  { value: 'silent', label: '静音' },
  { value: 'effects', label: '仅音效' },
  { value: 'music', label: '仅音乐' },
  { value: 'both', label: '音效＋音乐' },
];

export const DEFAULT_EFFECTS = '仅保留动作本身带出的轻微环境声；没有动作发生的段落保持静音。';
export const DEFAULT_MUSIC = '低音量的纯器乐，无人声';
export const MAX_MUSIC_LEN = 120;
export const MAX_EFFECTS_LEN = 240;

export interface AudioSettings {
  audioMode: AudioMode;
  musicStyle: string;
  soundEffects: string;
}

const isMode = (v: string): v is AudioMode => AUDIO_MODES.some((m) => m.value === v);

/** 归一化并校验；长度超限直接抛错，由表单负责提示 */
export function normalizeAudio(mode: string, music?: string, effects?: string): AudioSettings {
  if (!isMode(mode)) throw new Error('请选择有效的声音模式');
  const needMusic = mode === 'music' || mode === 'both';
  const needEffects = mode === 'effects' || mode === 'both';
  const musicStyle = needMusic ? (music ?? DEFAULT_MUSIC).trim() : '';
  const soundEffects = needEffects ? (effects ?? DEFAULT_EFFECTS).trim() : '';
  if (musicStyle.length > MAX_MUSIC_LEN) throw new Error(`音乐风格请控制在 ${MAX_MUSIC_LEN} 字以内`);
  if (soundEffects.length > MAX_EFFECTS_LEN) throw new Error(`音效说明请控制在 ${MAX_EFFECTS_LEN} 字以内`);
  return {
    audioMode: mode,
    musicStyle: musicStyle || (needMusic ? DEFAULT_MUSIC : ''),
    soundEffects: soundEffects || (needEffects ? DEFAULT_EFFECTS : ''),
  };
}

/** 转成注入视频提示词的片段；静音返回空串（不污染提示词） */
export function describeAudio(s: AudioSettings): string {
  if (s.audioMode === 'silent') return '【声音设置】静音，不生成声音。';
  const lead = '【声音设置】声音以本段选择为准，不添加旁白、解说或歌词。';
  if (s.audioMode === 'effects') {
    return `${lead}仅环境和动作音效：${s.soundEffects}不添加背景音乐。灯光渐变本身不配咔哒声、电子音或爆闪音效。`;
  }
  if (s.audioMode === 'music') {
    return `${lead}仅背景音乐：${s.musicStyle}。不加入设备动作声、电视原声或其他音效；音乐轻柔进入并在片尾自然淡出。`;
  }
  return `${lead}环境和动作音效：${s.soundEffects}背景音乐：${s.musicStyle}。音乐音量低于主要音效，片尾自然淡出。灯光渐变本身不配咔哒声、电子音或爆闪音效。`;
}

/**
 * 能力判断：返回空串表示该模式下无阻塞；返回文案表示需要提示/禁用。
 *
 * 每条判据都必须有出处，不能靠「大概率」蒙——蒙错会让用户以为能出声却拿到哑片，
 * 或者选了静音却拿到有声视频（MiniMax H3 就是后者）。
 *
 * 依据：
 * ① 必带原生音频（静音做不到，必须切模型）：gemini-omni、veo、MiniMax H3 / Hailuo 03。
 *    H3 每条视频都自带 32kHz 立体声（对白、音效、音乐），音频是模型输出的一部分而非附加项。
 * ② 明确无声：MiniMax 第一代 T2V/I2V（Director）只输出画面；OpenAI Sora 同样只出画面。
 * ③ 可选声音：seedance 系列支持原生音轨，也能配无音轨变体。
 * ④ 其它：不做无根据的断言，返回「需实测确认」而不是「大概率不出声」。
 */
export function audioSupportHint(provider: string, model: string, mode: AudioMode): string {
  const m = (model || '').toLowerCase().replace(/[\s_]+/g, '-');
  const p = (provider || '').toLowerCase();

  // ① 必带原生音频：静音模式物理上做不到
  const alwaysAuds = m.startsWith('gemini-omni') || m.startsWith('veo') || /(^|-)h3(-|$)/.test(m) || m.includes('hailuo-03');
  if (alwaysAuds) {
    return mode === 'silent'
      ? '当前模型每条视频都自带原生音轨（对白/音效/音乐），静音做不到；请改选有声模式，或换用无音轨的视频模型。'
      : '';
  }

  // ② 明确无声：可以放心选静音，也别指望选了音效/音乐会生效
  const silentOnly = m.includes('sora') || p === 'sora' || /(^|-)(t2v|i2v)(-|$)/.test(m) || m.includes('director');
  if (silentOnly) {
    return mode === 'silent' ? '' : '当前模型只输出画面、不生成声音。声音设置仅会写入提示词，不会出现在成片里。';
  }

  // ③ 明确支持可选音轨
  if (m.includes('seedance')) return '';

  // ④ 未收录的模型：说明如何自证，而不是替用户下「不出声」的结论
  return mode === 'silent'
    ? ''
    : '未收录该模型的音轨能力：声音设置会写入提示词，是否成声取决于模型本身。建议先用一小段确认成片有无声音。';
}

/** 把音轨片段拼到用户提示词后面 */
export function withAudioPrompt(prompt: string, s: AudioSettings): string {
  const frag = describeAudio(s);
  if (!frag || s.audioMode === 'silent') return prompt;
  return `${prompt}\n${frag}`;
}
