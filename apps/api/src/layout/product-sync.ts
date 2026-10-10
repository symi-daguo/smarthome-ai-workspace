import type { PrismaClient } from '@prisma/client';

/**
 * 知识库产品资料 -> 产品中心同步（内容提取 confirm / 自动确认 两条路径共用）。
 * 纯函数直接操作 prisma，content 模块零依赖 layout 模块（避免循环 import）。
 * 按 name + tenantId 查重：已存在则更新（品牌/型号/价格/布置提示取非空新值），否则创建到我的库。
 * 失败由调用方捕获降级，绝不阻塞提取入库主链路。
 */

/** 品类关键词推断（按预置 24 类；命中顺序即优先级） */
const CATEGORY_KEYWORDS: [string, string[]][] = [
  ['gateway', ['网关', '中枢', '中控主机']],
  ['network', ['路由', 'AP', 'Mesh', '交换机', '全屋WiFi', 'Wi-Fi']],
  ['panel', ['中控屏', '控制面板', '触控屏', '智能屏']],
  ['switch', ['开关', '旋钮', '按键']],
  ['presence', ['存在传感器', '人体存在', '毫米波']],
  ['sensor', ['传感器', '门磁', '门窗传感']],
  ['water', ['水浸', '漏水', '溢水']],
  ['climate', ['温湿度', '温度计', '湿度计']],
  ['light', ['灯带', '吸顶灯', '筒灯', '射灯', '台灯', '落地灯', '灯头', '灯光', '球泡']],
  ['curtain', ['窗帘', '卷帘', '百叶', '轨道']],
  ['lock', ['门锁', '指纹锁', '门禁', '猫眼']],
  ['camera', ['摄像头', '摄像机', '门铃', '监控']],
  ['alarm', ['报警器', '安防', '烟感', '燃气']],
  ['socket', ['插座', '插排', '通断器', '智能插头']],
  ['appliance', ['空调伴侣', '遥控', '家电', '电视盒']],
  ['kitchen', ['冰箱', '洗衣机', '热水器', '油烟机', '灶具', '马桶', '浴霸']],
  ['cleaner', ['扫地机', '拖地机', '吸尘器']],
  ['laundry', ['晾衣', '晒被']],
  ['audio', ['音箱', '音响', '功放', '回音壁']],
  ['visual', ['投影', '幕布', '影院']],
  ['hvac', ['地暖', '新风', '分集水器', '温控器', '空调', '暖气']],
  ['fresh', ['净化器', '循环扇', '加湿', '除湿']],
  ['irrigation', ['灌溉', '浇花', '喷灌']],
  ['pet', ['喂食', '宠物', '猫砂']],
];

export function inferCategory(text: string): string {
  for (const [key, words] of CATEGORY_KEYWORDS) {
    if (words.some((w) => text.includes(w))) return key;
  }
  return 'appliance';
}

/** 价格解析："¥1299 元" / "1299-1599" / "1,299" -> {min,max}；解析失败 0 */
export function parsePrice(text: string): { min: number; max: number } {
  const clean = text.replace(/[¥￥,，\s]/g, '');
  const range = clean.match(/(\d+(?:\.\d+)?)[-~–](\d+(?:\.\d+)?)/);
  if (range) return { min: Math.round(Number(range[1])), max: Math.round(Number(range[2])) };
  const single = clean.match(/(\d+(?:\.\d+)?)/);
  if (single) {
    const v = Math.round(Number(single[1]));
    return { min: v, max: v };
  }
  return { min: 0, max: 0 };
}

export interface ProductDocFields {
  name?: string;
  brand?: string;
  model?: string;
  price?: string;
  specs?: string;
  sellingPoints?: string;
}

export async function syncProductFromDocument(
  prisma: PrismaClient,
  tenantId: string,
  fields: ProductDocFields,
  rawContent: string,
): Promise<{ created: boolean; id: string }> {
  const name = (fields.name ?? '').trim().slice(0, 60);
  if (!name) throw new Error('PRODUCT_NAME_REQUIRED');
  const haystack = `${name} ${fields.specs ?? ''} ${fields.sellingPoints ?? ''} ${rawContent.slice(0, 300)}`;
  const category = inferCategory(haystack);
  const { min, max } = parsePrice(fields.price ?? '');
  // 卖点/规格摘要进布置提示（限 60 字）
  const perRoom = (fields.sellingPoints ?? fields.specs ?? '').trim().slice(0, 60);

  // 标准价格口径：资料里的区间价 → 工程价(min)/指导价(max)；单值 → 指导价
  const spec = (fields.specs ?? '').trim().slice(0, 120);

  const existing = await prisma.product.findFirst({ where: { name, tenantId } });
  if (existing) {
    await prisma.product.update({
      where: { id: existing.id },
      data: {
        category: existing.category || category,
        brand: (fields.brand ?? '').trim().slice(0, 40) || existing.brand,
        model: (fields.model ?? '').trim().slice(0, 40) || existing.model,
        priceMin: min || existing.priceMin,
        priceMax: max || existing.priceMax,
        perRoom: perRoom || existing.perRoom,
        spec: spec || existing.spec,
        ...(max ? { priceRetail: max } : {}),
        ...(min ? { priceProject: min } : {}),
      },
    });
    return { created: false, id: existing.id };
  }
  const created = await prisma.product.create({
    data: {
      tenantId,
      name,
      category,
      brand: (fields.brand ?? '').trim().slice(0, 40),
      model: (fields.model ?? '').trim().slice(0, 40),
      priceMin: min,
      priceMax: max,
      perRoom,
      spec,
      priceRetail: max,
      priceProject: min,
    },
  });
  return { created: true, id: created.id };
}
