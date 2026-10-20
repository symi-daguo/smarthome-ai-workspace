import { PrismaPg } from '@prisma/adapter-pg';

/**
 * 构造 Prisma 7 必需的 pg driver adapter。
 * 连接串统一经环境变量 DATABASE_URL 注入：
 * - 本地开发：ConfigModule 在模块元数据阶段从根目录 .env 载入 process.env
 * - 容器部署：compose environment 直接注入
 */
export function createPgAdapter(): PrismaPg {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL 未配置：请检查仓库根目录 .env 或容器环境变量');
  }
  return new PrismaPg({ connectionString });
}
