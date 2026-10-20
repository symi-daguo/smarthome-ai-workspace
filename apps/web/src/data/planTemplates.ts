/**
 * 交付模版定义（PPT / 分享页 / 点位编辑器共用，单一数据源）。
 *
 * 为什么要模版化 —— 两条外部依据，都不是拍脑袋：
 *
 * 1) 参考站（app.js:3343-3349）把「交付版式」做成 contentLayout 三选一
 *    （classic / presales-v1 / residence-v1），并按版式套不同的页数公式。
 *    我方对应字段是 `edition`（standard / presale / private），已实装。
 *
 * 2) 行业对「给客户的点位图」有硬要求。小米 MICA 数字家庭工程师课程的公开讲义
 *    写得很直接：看方案图先盯三件——**点位、线路、图例**，「每张规范的图纸都有
 *    符号说明，先花两分钟看懂图例，后面的阅读就顺了」；交付物里要含**点位表**。
 *    而参考站自己的实现也印证了这点：wifi-heatmap.js 的 `drawDevices()` 给每个设备
 *    画「图标 + 右上角编号 + 名称标签」，lighting-scene.js 的 marker 是
 *    `<div class="dot">序号</div><div class="lbl">名称</div>` —— 都是编号 + 标签。
 *
 *    改前的我方只有「品类色块图标 + 名称」，**既没有编号也没有图例**，
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
    name: '编号 + 名称',
    desc: '圆形徽章内写编号，右侧带设备名称',
    hint: '默认。编号与点位清单一一对应，是图纸「可核对」的前提；点位超过 20 个也仍然读得清。',
  },
  {
    key: 'icon',
    name: '产品图 + 名称',
    desc: '徽章内贴产品主图或品类图标，右侧带设备名称',
    hint: '视觉最直观，一眼看出装的是什么；但同一品类多台设备时标记外观接近，需要靠名称区分。',
  },
  {
    key: 'dot',
    name: '色点 + 编号',
    desc: '按品类配色的小实心点 + 编号，不带名称标签',
    hint: '最干净。户型图本身线条密或点位极多时用它，名称全部收到右侧清单里看。',
  },
];

export function floorplanTemplate(k: string | null | undefined): FloorplanTemplate {
  return FLOORPLAN_TEMPLATES.some((t) => t.key === k) ? (k as FloorplanTemplate) : 'annotated';
}

export function markerTemplate(k: string | null | undefined): MarkerTemplate {
  return MARKER_TEMPLATES.some((t) => t.key === k) ? (k as MarkerTemplate) : 'numbered';
}

/** 交付文件名里的版式后缀（对齐参考站 p2DownloadFilename 的 edition 命名） */
export const EDITION_LABEL: Record<string, string> = {
  standard: '标准完整方案',
  presale: '售前定制提案',
  private: '私宅设计提案',
};
