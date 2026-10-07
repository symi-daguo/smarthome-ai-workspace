import { defineConfig } from 'prisma/config';

// Prisma 7 起 CLI 不再自动加载 .env，显式加载 monorepo 根目录配置
//（本地无 .env 时忽略，依赖外部注入的环境变量，如 Docker / CI）
if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile('../../.env');
  } catch {
    // 仓库根目录无 .env，使用进程已有环境变量
  }
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // generate 不连接数据库，未配置时给占位值；migrate/运行时由 .env 或容器注入真实连接串
    url: process.env.DATABASE_URL ?? 'postgresql://placeholder:placeholder@localhost:5432/placeholder',
  },
});
