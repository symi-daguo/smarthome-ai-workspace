import argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';
import { PERMISSIONS } from '../src/rbac/permissions.js';
import { PRESET_CATEGORIES } from '../src/layout/category-defs.js';
import { createPgAdapter } from '../src/prisma/prisma-adapter.js';

// tsx 直接运行不经过 Nest ConfigModule，显式加载 monorepo 根目录 .env
if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile('../../.env');
  } catch {
    // 根目录无 .env 时使用外部注入的环境变量（Docker / CI）
  }
}

const prisma = new PrismaClient({ adapter: createPgAdapter() });

const ROLE_DEFS: { key: string; name: string; scope: 'PLATFORM' | 'TENANT'; permissions: string[] }[] = [
  { key: 'super_admin', name: '超级管理员', scope: 'PLATFORM', permissions: [...PERMISSIONS] },
  {
    key: 'tenant_admin',
    name: '租户管理员',
    scope: 'TENANT',
    permissions: [
      'tenant:member:manage',
      'tenant:role:assign',
      'tenant:billing:view',
      'tenant:token:grant',
      // 开源自部署：每个部署者都要配置自己的 API Key/本地模型，
      // 模型配置中心默认对租户管理员开放（会员机制保留，权限不锁死）
      'platform:billing:manage',
      'content:generate',
      'content:extract',
      'knowledge:manage',
      'knowledge:read',
      'order:manage',
      'quote:manage',
      'publish:manage',
      'cs:manage',
    ],
  },
  {
    key: 'designer',
    name: '设计师',
    scope: 'TENANT',
    permissions: ['content:generate', 'content:extract', 'knowledge:manage', 'knowledge:read'],
  },
  {
    key: 'operator',
    name: '运营',
    scope: 'TENANT',
    permissions: ['order:manage', 'quote:manage', 'publish:manage', 'cs:manage', 'content:extract', 'knowledge:read'],
  },
  { key: 'viewer', name: '只读成员', scope: 'TENANT', permissions: ['knowledge:read'] },
];

async function main(): Promise<void> {
  for (const action of PERMISSIONS) {
    await prisma.permission.upsert({ where: { action }, update: {}, create: { action, description: action } });
  }
  const permissionMap = new Map(
    (await prisma.permission.findMany({ select: { id: true, action: true } })).map((p) => [p.action, p.id]),
  );

  const platformTenant = await prisma.tenant.upsert({
    where: { slug: 'platform' },
    update: {},
    create: { name: '平台运营', slug: 'platform', plan: 'ENTERPRISE', tokenBalance: 100_000 },
  });
  // 演示额度兜底：平台运营租户低于 ¥1000 时补到 100000 token（幂等，便于本地走查生图/生视频）
  if (platformTenant.tokenBalance < 100_000) {
    await prisma.tenant.update({
      where: { id: platformTenant.id },
      data: { tokenBalance: 100_000 },
    });
    await prisma.tokenLedger.create({
      data: { tenantId: platformTenant.id, delta: 100_000 - platformTenant.tokenBalance, reason: 'GRANT', meta: { note: '演示额度初始化' } },
    });
  }

  for (const def of ROLE_DEFS) {
    const role = await prisma.role.upsert({
      where: { key: def.key },
      update: { name: def.name, scope: def.scope },
      create: { key: def.key, name: def.name, scope: def.scope },
    });
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: def.permissions
        .map((action) => permissionMap.get(action))
        .filter((id): id is string => Boolean(id))
        .map((permissionId) => ({ roleId: role.id, permissionId })),
    });
  }

  const superAdminRole = await prisma.role.findUniqueOrThrow({ where: { key: 'super_admin' } });
  const phone = process.env.SEED_ADMIN_PHONE ?? '13800000000';
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'Admin@123456';
  const admin = await prisma.user.upsert({
    where: { phone },
    // 幂等种子：已存在的管理员不覆盖密码（避免管理员改密后容器重启被重置）
    update: { displayName: '平台管理员' },
    create: { phone, passwordHash: await argon2.hash(password), displayName: '平台管理员' },
  });
  await prisma.membership.upsert({
    where: { userId_tenantId: { userId: admin.id, tenantId: platformTenant.id } },
    update: { roleId: superAdminRole.id },
    create: { userId: admin.id, tenantId: platformTenant.id, roleId: superAdminRole.id },
  });

  // 品类字典种子（预置 24 类，覆盖市面主流智能家居品类；tenantId=null 公共）
  for (const c of PRESET_CATEGORIES) {
    const existing = await prisma.categoryDef.findFirst({ where: { tenantId: null, key: c.key } });
    if (existing) {
      await prisma.categoryDef.update({ where: { id: existing.id }, data: { label: c.label, color: c.color, icon: c.icon, sortOrder: c.sortOrder, active: true } });
    } else {
      await prisma.categoryDef.create({ data: { tenantId: null, ...c } });
    }
  }
  // 存量数据归并：旧 security 品类 -> camera（产品种子随后按新分类精确更新公共库行）
  await prisma.product.updateMany({ where: { category: 'security' }, data: { category: 'camera' } });

  // 产品目录种子（全局共享，按 name 幂等 upsert）：标准主数据口径
  // 价格三级：priceDealer 经销进货价 ≤ priceProject 工程价(=旧min) ≤ priceRetail 指导价(=旧max)
  // 条码一律 21 开头店内码（EAN 保留段，非真实商品条码）；SN 为自有前缀，不涉及第三方品牌
  const PRODUCT_DEFS: {
    name: string; category: string; priceMin: number; priceMax: number; perRoom: string;
    sku: string; sn: string; spec: string; warranty?: number;
  }[] = [
    { name: '智能中枢网关', category: 'gateway', priceMin: 699, priceMax: 999, perRoom: '全屋 1 台（客厅弱电箱附近）', sku: 'GW-1001', sn: 'SJ-GW-', spec: 'Zigbee 3.0/BLE Mesh/WiFi 三模 · 支持 200 子设备', warranty: 24 },
    { name: '多模态网关', category: 'gateway', priceMin: 329, priceMax: 499, perRoom: '大户型每层 1 台', sku: 'GW-1002', sn: 'SJ-MG-', spec: 'Zigbee/BLE 双模 · USB-C 供电 · 80 子设备', warranty: 24 },
    { name: '智能开关（零火版）', category: 'switch', priceMin: 89, priceMax: 159, perRoom: '每个灯位回路 1 个', sku: 'SW-2001', sn: 'SJ-SW-', spec: '零火双键 · 86 型暗装 · 单路 600W', warranty: 36 },
    { name: '无线场景开关', category: 'switch', priceMin: 55, priceMax: 99, perRoom: '床头/玄关各 1', sku: 'SW-2002', sn: 'SJ-WS-', spec: '无线四键 · CR2450 电池 · 免布线', warranty: 24 },
    { name: '中控智能屏', category: 'panel', priceMin: 1099, priceMax: 1999, perRoom: '客厅/玄关墙面 1 台', sku: 'PN-3001', sn: 'SJ-PN-', spec: '7 英寸 1024x600 · 三模网关内置 · DC 12V', warranty: 24 },
    { name: '人体存在传感器', category: 'presence', priceMin: 99, priceMax: 169, perRoom: '客厅/卫生间/走廊', sku: 'SN-4001', sn: 'SJ-PS-', spec: '5.8GHz 毫米波 · 顶装 · 探测半径 4m', warranty: 24 },
    { name: '门窗传感器', category: 'sensor', priceMin: 35, priceMax: 59, perRoom: '入户门+主要窗户', sku: 'SN-4002', sn: 'SJ-DC-', spec: '磁感应 · Zigbee · CR2032 续航 2 年', warranty: 24 },
    { name: '水浸传感器', category: 'water', priceMin: 45, priceMax: 69, perRoom: '厨房水槽下+卫生间', sku: 'SN-4003', sn: 'SJ-WL-', spec: 'IP67 探针 · 漏水/溢水双告警', warranty: 24 },
    { name: '温湿度传感器', category: 'climate', priceMin: 45, priceMax: 79, perRoom: '客厅/儿童房', sku: 'SN-4004', sn: 'SJ-TH-', spec: '±0.3℃/±2%RH · 大屏数显', warranty: 24 },
    { name: '智能灯带（彩光）', category: 'light', priceMin: 129, priceMax: 299, perRoom: '吊顶灯槽/柜体', sku: 'LT-5001', sn: 'SJ-LB-', spec: 'RGB+CCT 五合一 · 24V · 5m 可剪', warranty: 24 },
    { name: '智能吸顶灯', category: 'light', priceMin: 239, priceMax: 599, perRoom: '每个房间 1 盏', sku: 'LT-5002', sn: 'SJ-CL-', spec: '48W 色温 2700-6500K ·  Ra90 全光谱', warranty: 36 },
    { name: '智能筒射灯', category: 'light', priceMin: 59, priceMax: 129, perRoom: '客厅无主灯布局', sku: 'LT-5003', sn: 'JT-5003', spec: '7W 防眩 UGR<16 · 75mm 开孔 · 36°', warranty: 36 },
    { name: '电动窗帘电机', category: 'curtain', priceMin: 459, priceMax: 799, perRoom: '每个窗帘位 1 台', sku: 'CT-6001', sn: 'SJ-CT-', spec: '静音 30dB · 开合 50kg · 停电手拉', warranty: 60 },
    { name: '智能门锁', category: 'lock', priceMin: 1299, priceMax: 2499, perRoom: '入户门 1 把', sku: 'LK-7001', sn: 'SJ-LK-', spec: '3D 人脸识别+指纹+NFC · C 级锁芯 · 干电池 12 月', warranty: 36 },
    { name: '智能摄像头', category: 'camera', priceMin: 129, priceMax: 299, perRoom: '玄关/客厅/阳台', sku: 'CM-8001', sn: 'SJ-CM-', spec: '2.5K 云台 360° · 夜视 10m · 本地 TF 存储', warranty: 24 },
    { name: '可视门铃', category: 'camera', priceMin: 229, priceMax: 399, perRoom: '入户门 1 个', sku: 'CM-8002', sn: 'SJ-DB-', spec: '2K 门铃 · 人形侦测 · 变声对讲', warranty: 24 },
    { name: '智能插座', category: 'socket', priceMin: 35, priceMax: 79, perRoom: '按需（家电电源位）', sku: 'PL-9001', sn: 'SJ-SP-', spec: '10A 计量版 · 电量统计 · 过载保护', warranty: 24 },
    { name: '智能触屏音箱', category: 'audio', priceMin: 349, priceMax: 599, perRoom: '客厅+主卧各 1', sku: 'AU-1001', sn: 'SJ-SK-', spec: '5.5 英寸屏 · 双麦克风远场 · 蓝牙 Mesh 网关', warranty: 24 },
    { name: '空调伴侣', category: 'appliance', priceMin: 89, priceMax: 149, perRoom: '每台壁挂空调 1 个', sku: 'AP-1101', sn: 'SJ-AC-', spec: '16A 红外+电量 · 1.5P 内挂机适配', warranty: 24 },
    { name: '地暖/新风控制器', category: 'hvac', priceMin: 239, priceMax: 399, perRoom: '分集水器/新风机位', sku: 'HV-1201', sn: 'SJ-FH-', spec: '周定时 8 时段 · 外置温控探头', warranty: 24 },
    { name: 'WiFi 面板 AP', category: 'network', priceMin: 239, priceMax: 399, perRoom: '每 60-80㎡ 1 个（Mesh 组网）', sku: 'NW-1301', sn: 'SJ-AP-', spec: 'WiFi6 AX3000 · 86 型 PoE · 双频 160MHz', warranty: 36 },
  ];
  let productCount = 0;
  for (let i = 0; i < PRODUCT_DEFS.length; i++) {
    const d = PRODUCT_DEFS[i];
    // 多级返利按价位档位：大件 12/6/8，中件 10/5/6，小件 8/4/5（一级/二级/设计师，百分比）
    const rebate = d.priceMax >= 500
      ? { rebateL1: 12, rebateL2: 6, rebateDesigner: 8 }
      : d.priceMax >= 100
        ? { rebateL1: 10, rebateL2: 5, rebateDesigner: 6 }
        : { rebateL1: 8, rebateL2: 4, rebateDesigner: 5 };
    // 经销进货价约工程价 9 折；工程价取旧 min 与 95%指导价 的较小者，保证 dealer ≤ project ≤ retail
    const priceRetail = d.priceMax;
    const priceProject = d.priceMin;
    const priceDealer = Math.round((priceProject * 0.9) / 10) * 10;
    // 店内码：21 前缀（EAN-13 店内码保留段）+ 序号
    const barcode = `2${String(100000000001 + i).padStart(12, '0')}`;
    // 公共库种子按 name 幂等（name 不再全局 unique，应用层查重）
    const data = {
      category: d.category, perRoom: d.perRoom, sortOrder: i,
      priceMin: priceProject, priceMax: priceRetail,
      sku: d.sku, barcode, snRule: d.sn, spec: d.spec, warranty: d.warranty ?? 12,
      priceRetail, priceProject, priceDealer, ...rebate,
    };
    const existing = await prisma.product.findFirst({ where: { name: d.name, tenantId: null } });
    if (existing) {
      await prisma.product.update({ where: { id: existing.id }, data });
    } else {
      await prisma.product.create({ data: { name: d.name, tenantId: null, ...data } });
    }
    productCount++;
  }

  console.log(`seed done: roles=${ROLE_DEFS.length}, permissions=${PERMISSIONS.length}, categories=${PRESET_CATEGORIES.length}, products=${productCount}, admin=${phone}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
