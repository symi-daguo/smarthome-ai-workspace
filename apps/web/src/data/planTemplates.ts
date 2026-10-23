/**
 * 交付模版定义（PPT / 分享页 / 点位编辑器共用，单一数据源）。
 *
 * 为什么要模版化 —— 两条外部依据，都不是拍脑袋：
 *
 * 1) 「交付版式」做成 contentLayout 三选一
 *    （classic / presales-v1 / residence-v1），并按版式套不同的页数公式。
 *    对应字段是 `edition`（standard / presale / private），已实装。
 *
 * 2) 行业对「给客户的点位图」有硬要求。小米 MICA 数字家庭工程师课程的公开讲义
 *    写得很直接：看方案图先盯三件——**点位、线路、图例**，「每张规范的图纸都有
 *    符号说明，先花两分钟看懂图例，后面的阅读就顺了」；交付物里要含**点位表**。
 *    而信号热力图模块的实现也印证了这点：它给每个设备
 *    画「图标 + 右上角编号 + 名称标签」，灯光场景模块的标记点是
 *    `<div class="dot">序号</div><div class="lbl">名称</div>` —— 都是编号 + 标签。
 *
 *    改前只有「品类色块图标 + 名称」，**既没有编号也没有图例**，
 *    客户拿到那张图无法把某个标记对应回清单里的某一台设备。
 */

export type FloorplanTemplate = 'annotated' | 'compare' | 'render';
export type MarkerTemplate = 'numbered' | 'icon' | 'dot';

/** 户型图设计模版：决定「户型页在 PPT 上长什么样」 */
export const FLOORPLAN_TEMPLATES: {
  key: FloorplanTemplate;
  name: string;
  desc: string;
  /** 给门店看的选择依据 */
  hint: string;
}[] = [
  {
    key: 'annotated',
    name: '点位标注图',
    desc: '户型底图叠加编号点位 + 品类图例 + 点位清单',
    hint: '行业标准交付样式。客户能按编号把图上的标记对回清单里的具体设备，适合正式报价与施工交底。',
  },
  {
    key: 'compare',
    name: '原图对照',
    desc: '左原始户型 / 右 AI 精装修效果图并排对照',
    hint: '突出「改造前后」的直观感受，适合第一次沟通就建立信任，但点位信息弱，需要配合清单页。',
  },
  {
    key: 'render',
    name: '单张效果图',
    desc: '只放 AI 精装修效果图，不叠加点位',
    hint: '偏视觉展示，适合方案后期的朋友圈/朋友圈式传播；不含任何设备标注，不可用于施工。',
  },
];

/** 产品放置模版：决定「点位标记本身怎么画」 */
export const MARKER_TEMPLATES: {
  key: MarkerTemplate;
  name: string;
  desc: string;
  hint: string;
}[] = [
  {
    key: 'numbered',
    name: '编号',
    desc: '圆形徽章只写编号，名称在右侧点位清单里',
    hint: '默认。图上不挂名称牌，点位再密也不会糊成一片；编号与清单逐条对应，客户按编号对回设备。',
  },
  {
    key: 'icon',
    name: '产品图标',
    desc: '徽章内贴品类图标（自绘 SVG），名称在右侧点位清单里',
    hint: '想一眼看出装的是什么设备时用。图标是本项目自绘的品类图形，不引用任何第三方图片素材。',
  },
  {
    key: 'dot',
    name: '色点',
    desc: '按品类配色的小实心点 + 编号',
    hint: '最干净。户型图本身线条密或点位极多时用它。',
  },
];

export function floorplanTemplate(k: string | null | undefined): FloorplanTemplate {
  return FLOORPLAN_TEMPLATES.some((t) => t.key === k) ? (k as FloorplanTemplate) : 'annotated';
}

export function markerTemplate(k: string | null | undefined): MarkerTemplate {
  return MARKER_TEMPLATES.some((t) => t.key === k) ? (k as MarkerTemplate) : 'numbered';
}

/**
 * 模版 → 交付件里那几张图分别用哪一张。
 *
 * 为什么要有这个函数：三个模版对应三种**完全不同的画面**，
 * 而它们的差别不是「配图风格」，是「图上有什么」：
 *
 * | 模版 | 主图 | 叠点位吗 | 用途 |
 * |---|---|---|---|
 * | annotated | 客户原图 | 叠 | 施工交底：点位要落在客户真实的户型上 |
 * | compare | 左客户原图 / 右 AI 效果图 | 都不叠 | 改造前后对照，直观但不含点位 |
 * | render | AI 效果图 | 不叠 | 纯展示传播 |
 *
 * **compare 不叠点位**是刻意的：AI 精装修图是模型重画的，
 * 构图与客户原图有出入（改了布局、加了边距、挪了开口），
 * 点位坐标是按**客户原图**标的，叠到 AI 图上必然错位 ——
 * 而点位图是施工交底的依据，位置错了比没有图更糟。
 * 所以 compare 的点位信息靠右侧清单页给，不靠图上的徽章。
 *
 * **底图一律用客户原图**（annotated 的叠点位底图、compare 的左栏、动线页主图）：
 * AI 效果图只出现在「该出现的地方」（compare 右栏、render 模版），
 * 绝不拿去当叠点位的底图 —— 那是点位错位的根源。
 *
 * 抽成纯函数的原因同 `deliverPages`：**PPT / 分享页 / 预览必须同一口径**。
 * 以前 compare 只在 PPTX 里实现，前端预览完全没有这个分支；
 * 而 PPTX 里的 compare 又有自己的内联口径 —— 实测导出的 PPT
 * 右栏画的是客户原图（不是 AI 效果图），标签却写着「AI 精装修效果 · 点位同步」，
 * 两处都在撒谎：客户拿到的是「原图 vs 原图+点位」，模版承诺的改造前后对照根本没兑现。
 */
export interface FloorplanImages {
  /** 主图（空间动线页 + 户型页整页）：客户原图 */
  main: string | null;
  /** 主图上叠不叠点位 */
  overlayPoints: boolean;
  /** 主图标签（PPTX 与预览共用同一份文案，避免两处说法不一致） */
  mainLabel: string;
  /** compare 左栏：客户原图（不叠点位） */
  compareLeft: string | null;
  /** compare 右栏：AI 精装修效果图（不叠点位） */
  compareRight: string | null;
  /** compare 右栏标签：没有真实效果图时必须说实话 */
  compareRightLabel: string;
}

/** compare 左栏标签（恒定） */
export const COMPARE_LEFT_LABEL = '原始户型（客户户型图）';

/**
 * 户型页的文案：随模版变。
 *
 * 为什么不能一份文案通吃：三个模版的画面完全不同 ——
 * annotated 图上**有**编号徽章，compare / render 图上**没有**。
 * 沿用同一段「把中控、面板、传感与窗帘电机的落位逐一点出」，
 * 等于当着客户的面说图上有、图上却没有 —— 文案在撒谎，
 * 而且是交付件上最显眼的一处（页标题 + 页眉 + 正文 + 引言 + 讲稿）。
 *
 * 口径跟着画面走：图上有点位 → 讲点位；图上没有 → 讲效果与清单。
 */
export interface FloorplanPageCopy {
  /** 页眉里的页型标签 */
  typeLabel: string;
  heading: string;
  subtitle: string;
  body: string;
  quote: string;
  narration: string;
}

export function floorplanPageCopy(tpl: FloorplanTemplate): FloorplanPageCopy {
  if (tpl === 'compare') {
    return {
      typeLabel: '户型改造前后对照',
      heading: '户型改造前后对照',
      subtitle: '左边是您家现状，右边是智能精装后的样子',
      body: '左边是您上传的真实户型平面图，右边是同一套户型的智能精装效果参考。对照着看，装修风格与智能设备怎么融在一起，一目了然。每一台设备具体装在哪、装多少台，设备清单里逐条列明。',
      quote: '先看见效果，再谈细节',
      narration: '这一页把改造前后的效果放在一起给您看。左边是您家现在的户型，右边是按智能精装的效果图。风格方向您认可了，我们再逐台设备对点位。',
    };
  }
  if (tpl === 'render') {
    return {
      typeLabel: '智能精装效果示意',
      heading: '智能精装效果示意',
      subtitle: '全屋智能装进去，大概是这个样子',
      body: '这是本方案户型对应的智能精装效果参考，灯光、窗帘与暖通的搭配都在里面。装了哪些设备、各多少台，设备清单里逐条列明。',
      quote: '效果先看，细节逐项对',
      narration: '这是您家户型做完智能精装之后的效果参考。觉得方向对，我们再一项一项对设备。',
    };
  }
  return {
    typeLabel: '户型与设备点位',
    heading: '户型与设备点位',
    subtitle: '每一台设备装在哪，一张图说清',
    body: '以您家的实际户型为底图，把中控、面板、传感与窗帘电机的落位逐一点出。施工前会与您和装修方再核对一次水电预留位置。',
    quote: '点位落定，水电一次做对',
    narration: '这张图是按您家户型做的点位图。每个图标对应一台设备，我们会按施工顺序进场。点位如果有调整，随时在图上标出来就行。',
  };
}

export function floorplanImages(
  plan: {
    floorplanUrl?: string | null;
    renderedFloorplanUrl?: string | null;
    floorplanTemplate?: string | null;
    layoutPoints?: unknown[] | null;
  },
): FloorplanImages {
  const tpl = floorplanTemplate(plan.floorplanTemplate);
  const original = plan.floorplanUrl ?? null;
  const rendered = plan.renderedFloorplanUrl ?? null;
  const hasPoints = Boolean(plan.layoutPoints?.length);
  if (tpl === 'compare') {
    return {
      // 主图就是左栏那张客户原图；没有原图时才用效果图兜底
      main: original ?? rendered,
      overlayPoints: false,
      mainLabel: original ? '客户户型图（不含设备点位）' : 'AI 精装修效果图（不含设备点位）',
      compareLeft: original,
      // 效果图缺失时右栏回落成原图，但标签必须写明「没有效果图」
      compareRight: rendered ?? original,
      compareRightLabel: rendered ? 'AI 精装修效果图' : '暂无 AI 精装修效果图',
    };
  }
  if (tpl === 'render') {
    return {
      main: rendered ?? original,
      overlayPoints: false,
      mainLabel: 'AI 精装修效果示意（不含设备点位）',
      compareLeft: null,
      compareRight: null,
      compareRightLabel: '',
    };
  }
  // annotated：主图用客户原图，叠点位。
  return {
    main: original ?? rendered,
    overlayPoints: true,
    mainLabel: hasPoints ? '客户户型 · 设备点位图' : '客户户型图',
    compareLeft: null,
    compareRight: null,
    compareRightLabel: '',
  };
}

/** 交付文件名里的版式后缀（edition 命名） */
export const EDITION_LABEL: Record<string, string> = {
  standard: '标准完整方案',
  presale: '售前定制提案',
  private: '私宅设计提案',
};
