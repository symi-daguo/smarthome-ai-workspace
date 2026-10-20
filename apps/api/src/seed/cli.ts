/**
 * 种子 CLI 入口（编译产物：`dist/src/seed/cli.js`）。
 *
 * 桌面端首次启动要初始化数据库时用它：`node dist/src/seed/cli.js`。
 * 不走 prisma CLI —— 那会把整个 CLI（含多方言 wasm，约 40MB）打进安装包。
 */
import { PrismaClient } from '@prisma/client';
import { createPgAdapter } from '../prisma/prisma-adapter.js';
import { main } from './seed.js';

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
