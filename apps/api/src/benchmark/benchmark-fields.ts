/**
 * 对标账号情报的**采集契约唯一事实源**。
 *
 * ## 为什么要有契约
 *
 * 采集动作发生在**带浏览器能力的 Agent 侧**（服务端不引无头浏览器：
 * 镜像会大几百 MB，且平台内容需要真实登录态，服务端 fetch 拿不到）。
 * 但「采什么字段、怎么算热门、怎么提交」必须有一份**可下载、可编程读取的规格**，
 * 否则每个 Agent 各采各的：字段名不一样、热门口径不一样、提交格式不一样，
 * 服务端只能靠猜，猜错整批被拒。
 *
 * ## 为什么这份文件是唯一事实源
 *
 * 界面上的「格式说明」、下载给 Agent 的 JSON、提交时的服务端校验，
 * **全部由这里生成**。改了这里的定义，三处同时变——
 * 不会出现「文档写的和实际要求对不上」。
 *
 * 平台名不在这里枚举：平台是用户自填的自由文本（`platform` 字段），
 * 不在代码里硬编码任何具体平台品牌。
 */

export type BenchmarkFieldType = 'string' | 'number' | 'datetime' | 'string[]';

export interface BenchmarkFieldSpec {
  /** 字段名（提交接口的 JSON 键） */
  key: string;
  /** 中文标签 */
  label: string;
  type: BenchmarkFieldType;
  /** 是否必填 */
  required: boolean;
  /** 采集要点（给采集端看） */
  note: string;
  /**
   * 是否属于**同业基线字段**。
   *
   * 取证结论（同业公开文档的字段表）：
   * - 基线（几乎每家都有）：标题/正文 + 链接 + 发布时间 + 互动总量
   *   （点赞/评论/转发/收藏各平台折算）+ 话题标签
   * - 非基线：封面图链接、视频时长（公开文档里没有一家把它们列为标准字段）
   * - 跨平台不统一：播放量（各家都是平台专属字段名），所以我们按统一口径折算
   * - 我们不在采集阶段取的：作者（账号本身就是作者）、情绪与影响力
   *   （留给分析阶段由模型从文案里归纳，省得采集端做主观判断）
   */
  baseline: boolean;
  /** 示例值 */
  example: string;
  /** 长度/取值上限 */
  maxLength?: number;
}

/**
 * 要采集的内容元数据字段。
 *
 * 只采**元数据与文案**，不下载视频本体：
 * - 版权风险（只引用不入库）
 * - 「热门信息映射学习比对」的对象本来就是元数据与文案，视频本体对分析无用
 */
export const BENCHMARK_FIELD_SPECS: BenchmarkFieldSpec[] = [
  {
    key: 'title',
    label: '内容标题',
    type: 'string',
    required: true,
    maxLength: 200,
    note: '内容没有独立标题时，取正文首句（不超过 60 字），不要自己概括',
    example: '全屋灯光，一键搞定',
    baseline: true,
  },
  {
    key: 'text',
    label: '正文文案',
    type: 'string',
    required: true,
    maxLength: 4000,
    note:
      '发布时的完整文案原文（含话题标签）。这是映射分析的主要输入，**不要摘要、不要改写**。' +
      '**平台的作品没有独立文案时**（文案本身就是标题），照实填标题原文 + 话题标签，不要留空、也不要编造。',
    example: '装修最怕的就是插座不够用…#智能家居 #全屋智能',
    baseline: true,
  },
  {
    key: 'sourceUrl',
    label: '内容链接',
    type: 'string',
    required: true,
    maxLength: 500,
    note: '该条内容的固定链接。**幂等键，必须唯一且能回访**，重复提交同一条不会重复入库',
    example: 'https://example.com/post/123456',
    baseline: true,
  },
  {
    key: 'publishedAt',
    label: '发布时间',
    type: 'datetime',
    required: false,
    note: 'ISO 8601 时间。拿不到就留空，**不要用采集时间冒充**（热度分按发布时间算时效衰减）',
    example: '2026-10-18T12:30:00+08:00',
    baseline: true,
  },
  {
    key: 'play',
    label: '播放量',
    type: 'number',
    required: false,
    note: '播放/浏览次数',
    example: '128000',
    baseline: true,
  },
  {
    key: 'like',
    label: '点赞数',
    type: 'number',
    required: false,
    note: '点赞/推荐数',
    example: '3200',
    baseline: true,
  },
  {
    key: 'comment',
    label: '评论数',
    type: 'number',
    required: false,
    note: '评论条数',
    example: '186',
    baseline: true,
  },
  {
    key: 'collect',
    label: '收藏数',
    type: 'number',
    required: false,
    note: '收藏/稍后看数',
    example: '540',
    baseline: true,
  },
  {
    key: 'share',
    label: '转发数',
    type: 'number',
    required: false,
    note: '分享/转发次数',
    example: '92',
    baseline: true,
  },
  {
    key: 'topics',
    label: '话题标签',
    type: 'string[]',
    required: false,
    note: '标签数组，**不带 # 号**；没有就留空数组',
    example: '["智能家居", "全屋智能", "装修避坑"]',
    baseline: true,
  },
  {
    key: 'coverUrl',
    label: '封面图链接',
    type: 'string',
    required: false,
    maxLength: 500,
    note: '封面直链，用于人工核对内容；拿不到就留空',
    example: 'https://example.com/cover/123456.jpg',
    baseline: false,
  },
  {
    key: 'durationSec',
    label: '时长（秒）',
    type: 'number',
    required: false,
    note: '视频时长，秒；拿不到就留空',
    example: '42',
    baseline: false,
  },
];

/**
 * 「热门/优秀」的**排序维度**。
 *
 * ## 为什么是「可切换的维度」而不是一个综合分
 *
 * 同业三家独立地做成了**可切换的单一维度**：
 * - Talkwalker Search API 的 `sort_by` 枚举：engagement / published / reach / views / trending_score…
 * - Brandwatch `orderBy` 枚举：impact / reachEstimate / impressions / date / 各平台互动量…
 * - Meltwater Listening Search 的 `sort_by` 枚举：date / reach / engagement / social_echo / prominence / views…
 *
 * 三家都**没有**公开一个「综合热度分」的权重公式，只给枚举值。
 * 所以本系统提供多个排序维度供切换，默认用 `hotScore`（我们自己算的综合分），
 * 因为「每天自动采集」这件事不能让人天天手动选维度。
 *
 * 口径由**服务端统一计算**（`computeHotScore`），不依赖采集端各自实现——
 * 否则不同 Agent 采回来的排序不可比，而「热门」恰恰是这套功能的核心。
 */
export const BENCHMARK_SORT_FIELDS = [
  {
    key: 'hotScore',
    label: '综合热度（默认）',
    desc: '加权互动 × 时效衰减，兼顾互动量与新鲜度',
  },
  { key: 'engagement', label: '互动总量', desc: '点赞 + 评论 + 收藏 + 转发' },
  { key: 'views', label: '播放量', desc: '只按播放/浏览次数排' },
  { key: 'published', label: '发布时间', desc: '最新的排前面' },
] as const;

export type BenchmarkSortKey = (typeof BENCHMARK_SORT_FIELDS)[number]['key'];

/** 热度统计时间窗：只看最近 N 天发布的内容 */
export const BENCHMARK_HOT_RULES = {
  windowDays: 14,
  /** 每个账号每次最多采多少条 */
  perAccountLimit: 20,
  /** 单次提交总数上限 */
  submitLimit: 500,
  /** 互动权重：评论与转发的「决策价值」高于点赞 */
  weights: {
    play: 0.02,
    like: 3,
    comment: 5,
    collect: 4,
    share: 6,
  },
  /** 时效衰减半衰期（天）：每过 7 天热度打 5 折 */
  decayHalfLifeDays: 7,
  /** 公式原文（界面与 Agent 下载的说明里直接给这句，避免各端自己推） */
  formula:
    'hotScore = (play×0.02 + like×3 + comment×5 + collect×4 + share×6) × 0.5^(发布距今天数 ÷ 7)',
  /** 低于这个分视为不够热门，提交后不入库 */
  minHotScore: 0,
};

/**
 * 情报数据保留期（天）。
 *
 * 为什么必须自己定：同业公开条款里**没有一家给出保留期天数**
 * （只写「服务终止后可删除」）。而内容权利归原主、平台有权因侵权或
 * 第三方协议要求而下架停供——所以「只做内部分析、不再分发、不落媒体本体」
 * 是风险最低的姿态；保留期则是我们自己必须兜住的那一环。
 *
 * 超期的内容不再参与分析，并可由 `POST /api/benchmark/prune` 清掉。
 */
export const BENCHMARK_RETENTION_DAYS = 90;

/** 提交规则（界面说明与 Agent 下载的说明共用） */
export const BENCHMARK_IMPORT_RULES: string[] = [
  '一次提交至少 1 条、最多 500 条；每个账号单次最多 20 条（按热度分取前 20）。',
  '必填字段：内容标题、正文文案、内容链接。缺任何一项该条整批拒绝。',
  '互动数（播放/点赞/评论/收藏/转发）拿不到就留空，不要用 0 冒充——0 会被当成「确实没人看」。',
  '发布时间拿不到就留空，不要用采集时间冒充：热度分按发布时间算时效衰减。',
  '内容链接是幂等键：同一条内容重复提交只会更新数据，不会重复入库；换个链接会被当成新内容。',
  '正文文案要**原文**，不要摘要、不要改写——映射分析学的是它怎么写，不是它写了什么。',
  '只采元数据与文案，**不要下载视频本体**：用途是分析与学习，不需要搬运素材。',
  '一批就是一次提交（batchId 相同）。提交后由服务端统一算热度分并排序。',
];
