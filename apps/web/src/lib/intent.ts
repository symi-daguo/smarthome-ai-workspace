/**
 * 工作台输入意图识别：用户随便打一句话，自动判断他真正想去哪个板块。
 *
 * 参考站是「发送即跳转」（route-loader 的 intent()），实测会在用户只是想聊天时被强行带走。
 * 这里改为「边输入边识别 + 给出可点的建议」，用户点一下才走，且随时可忽略——
 * 同样的识别能力，不劫持对话，交互更稳。
 *
 * 纯函数，无副作用，便于单测与后续扩展。
 */

export type IntentKey = 'image' | 'video' | 'plan' | 'quote' | 'knowledge' | 'assets' | 'chat';

export interface Intent {
  key: IntentKey;
  /** 建议板块名（用于按钮文案） */
  label: string;
  /** 跳转路由 */
  route: string;
  /** 命中的关键词，用于让用户知道为什么被建议 */
  hit: string;
}

/** 顺序即优先级：先匹配到的胜出。问句类统一落到对话，避免「怎么做海报」被当成生图。 */
const RULES: { key: IntentKey; label: string; route: string; words: string[] }[] = [
  // 知识库与资料库都用「资料」二字做泛称，这里用更具体的词区分：
  // 「文档/知识库/手册/企业资料」偏知识库；「我的资料/之前生成/以前做的」偏产物库。
  { key: 'knowledge', label: '我的知识库', route: '/knowledge', words: ['知识库', '文档', '企业资料', '产品手册', '说明书'] },
  { key: 'assets', label: '我的资料库', route: '/works', words: ['我的资料', '资料库', '之前生成', '之前做的', '以前做的', '以前生成', '历史作品', '上次做的'] },
  { key: 'quote', label: '智能报价', route: '/quote', words: ['报价', '算价', '多少钱', '价格单', '预算清单'] },
  { key: 'plan', label: '智能方案生成', route: '/plan', words: ['方案', '提案', '全屋智能规划', '设计稿', '施工图', '汇报'] },
  { key: 'video', label: 'AI 生视频', route: '/video', words: ['视频', '动画', '短片', '运镜', '延时'] },
  { key: 'image', label: 'AI 生图', route: '/image', words: ['生图', '出图', '图片', '海报', '效果图', '配图', '封面', '彩平图', '截图'] },
];

/** 问句/教程类：用户要的是答案，不是要去某个工具页 */
const QUESTION_WORDS = ['怎么', '如何', '教程', '为什么', '是什么', '什么是', '能不能', '可不可以', '区别', '哪个好'];

/**
 * 识别意图。入参过短（<2 字）不识别，避免「好」「嗯」这类被误判。
 * 问句优先：命中问句词直接返回 chat，不打扰用户。
 */
export function detectIntent(text: string): Intent | null {
  const t = text.trim();
  if (t.length < 2) return null;

  const question = QUESTION_WORDS.find((w) => t.includes(w));
  if (question) {
    return { key: 'chat', label: '直接对话', route: '/', hit: question };
  }

  for (const rule of RULES) {
    const hit = rule.words.find((w) => t.includes(w));
    if (hit) return { key: rule.key, label: rule.label, route: rule.route, hit };
  }
  return null;
}