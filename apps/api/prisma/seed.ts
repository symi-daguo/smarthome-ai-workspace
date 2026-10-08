import argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';
import { PERMISSIONS } from '../src/rbac/permissions.js';
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

  // 产品目录种子（全局共享，按 name 幂等 upsert）：智能设备点位布局/设备清单用
  const PRODUCT_DEFS: { name: string; category: string; priceMin: number; priceMax: number; perRoom: string }[] = [
    { name: '智能中枢网关', category: 'gateway', priceMin: 599, priceMax: 999, perRoom: '全屋 1 台（客厅弱电箱附近）' },
    { name: '多模态网关', category: 'gateway', priceMin: 299, priceMax: 499, perRoom: '大户型每层 1 台' },
    { name: '智能开关（零火版）', category: 'switch', priceMin: 79, priceMax: 159, perRoom: '每个灯位回路 1 个' },
    { name: '无线场景开关', category: 'switch', priceMin: 49, priceMax: 99, perRoom: '床头/玄关各 1' },
    { name: '人体存在传感器', category: 'sensor', priceMin: 89, priceMax: 169, perRoom: '客厅/卫生间/走廊' },
    { name: '门窗传感器', category: 'sensor', priceMin: 29, priceMax: 59, perRoom: '入户门+主要窗户' },
    { name: '水浸传感器', category: 'sensor', priceMin: 39, priceMax: 69, perRoom: '厨房水槽下+卫生间' },
    { name: '温湿度传感器', category: 'sensor', priceMin: 39, priceMax: 79, perRoom: '客厅/儿童房' },
    { name: '智能灯带（彩光）', category: 'light', priceMin: 99, priceMax: 299, perRoom: '吊顶灯槽/柜体' },
    { name: '智能吸顶灯', category: 'light', priceMin: 199, priceMax: 599, perRoom: '每个房间 1 盏' },
    { name: '智能筒射灯', category: 'light', priceMin: 49, priceMax: 129, perRoom: '客厅无主灯布局' },
    { name: '电动窗帘电机', category: 'curtain', priceMin: 399, priceMax: 799, perRoom: '每个窗帘位 1 台' },
    { name: '智能门锁', category: 'security', priceMin: 999, priceMax: 2499, perRoom: '入户门 1 把' },
    { name: '智能摄像头', category: 'security', priceMin: 99, priceMax: 299, perRoom: '玄关/客厅/阳台' },
    { name: '可视门铃', category: 'security', priceMin: 199, priceMax: 399, perRoom: '入户门 1 个' },
    { name: '智能插座', category: 'appliance', priceMin: 29, priceMax: 79, perRoom: '按需（家电电源位）' },
    { name: '小爱触屏音箱', category: 'audio', priceMin: 299, priceMax: 599, perRoom: '客厅+主卧各 1' },
    { name: '空调伴侣', category: 'hvac', priceMin: 79, priceMax: 149, perRoom: '每台壁挂空调 1 个' },
    { name: '地暖/新风控制器', category: 'hvac', priceMin: 199, priceMax: 399, perRoom: '分集水器/新风机位' },
    { name: 'WiFi 面板 AP', category: 'gateway', priceMin: 199, priceMax: 399, perRoom: '每 60-80㎡ 1 个（Mesh 组网）' },
  ];
  let productCount = 0;
  for (let i = 0; i < PRODUCT_DEFS.length; i++) {
    const d = PRODUCT_DEFS[i];
    await prisma.product.upsert({
      where: { name: d.name },
      update: { category: d.category, priceMin: d.priceMin, priceMax: d.priceMax, perRoom: d.perRoom, sortOrder: i },
      create: { ...d, sortOrder: i },
    });
    productCount++;
  }

  console.log(`seed done: roles=${ROLE_DEFS.length}, permissions=${PERMISSIONS.length}, products=${productCount}, admin=${phone}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
