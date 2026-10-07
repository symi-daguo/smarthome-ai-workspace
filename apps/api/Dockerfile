# 构建上下文固定为仓库根目录：docker build -f apps/api/Dockerfile .
FROM node:24.19.0-alpine

# argon2 原生模块构建工具链 + 运行时 libstdc++
RUN apk add --no-cache python3 make g++ libstdc++

WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@11.5.3 --activate

# 先拷贝清单文件以利用层缓存
COPY .npmrc pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

# 拷贝源码并生成 Prisma Client、编译
COPY apps/api apps/api
RUN pnpm --filter @app/api prisma:generate && pnpm --filter @app/api build

EXPOSE 3080

# 启动时：应用迁移（prisma migrate deploy）-> 幂等种子 -> 启动服务
CMD ["sh", "-c", "pnpm --filter @app/api prisma:deploy && node apps/api/dist/prisma/seed.js && node apps/api/dist/src/main.js"]
