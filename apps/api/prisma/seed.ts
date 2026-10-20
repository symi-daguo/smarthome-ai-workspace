/**
 * 种子入口（薄壳）。
 *
 * 真正的执行体在 src/seed/seed.ts —— 它要同时服务两端：
 * - 容器端：`prisma db seed` 用 tsx 直跑本文件（行为与从前完全一致）
 * - 桌面端：Electron 全内嵌版没有 tsx，跑编译产物 dist/src/seed/cli.js（同一份逻辑）
 */
import { PrismaClient } from '@prisma/client';
import { createPgAdapter } from '../src/prisma/prisma-adapter.js';
import { main } from '../src/seed/seed.js';

// tsx 直接运行不经过 Nest ConfigModule，显式加载 monorepo 根目录 .env
if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile('../../.env');
  } catch {
    // 根目录无 .env 时使用外部注入的环境变量（Docker / CI）
  }
}

const phone = process.env.SEED_ADMIN_PHONE ?? '13800000000';
const password = process.env.SEED_ADMIN_PASSWORD ?? 'Admin@123456';
const prisma = new PrismaClient({ adapter: createPgAdapter() });

main({ prisma, phone, password })
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
