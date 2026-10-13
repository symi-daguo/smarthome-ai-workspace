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

export const DEFAULT_EFFECTS = '只保留画面中实际动作的轻微环境音效；没有发声动作时保持安静。';
export const DEFAULT_MUSIC = '轻柔、低音量的无歌词器乐';
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
 * 判定依据只有模型名里能确证的前缀，不猜——猜错会让用户以为能出声却拿到哑片。
 */
export function audioSupportHint(provider: string, model: string, mode: AudioMode): string {
  const m = (model || '').toLowerCase();
  const p = (provider || '').toLowerCase();
  // 已知自带音频的模型：静音做不到，必须切模型
  if (m.startsWith('gemini-omni') || m.startsWith('veo')) {
    return mode === 'silent' ? '当前模型为自带声音的版本，静音做不到；请换用无音轨模型或改选有声模式。' : '';
  }
  // 明确支持声音的模型
  if (m.includes('seedance') || p === 'sora' || m.startsWith('gpt-4o-audio')) return '';
  // 其它：多数只出画面
  return mode === 'silent' ? '' : '当前模型大概率只输出画面、不出声。选了也有声设置也不代表成片会有声音，建议先试一小段确认。';
}

/** 把音轨片段拼到用户提示词后面 */
export function withAudioPrompt(prompt: string, s: AudioSettings): string {
  const frag = describeAudio(s);
  if (!frag || s.audioMode === 'silent') return prompt;
  return `${prompt}\n${frag}`;
}
