# syntax=docker/dockerfile:1
# 构建上下文固定为仓库根目录：docker build -f apps/api/Dockerfile .
FROM node:24.19.0-alpine

# argon2 原生模块构建工具链 + 运行时 libstdc++
RUN apk add --no-cache python3 make g++ libstdc++

WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@11.5.3 --activate

# registry 可覆盖：默认留空即走官方源（CI / 海外部署）。
# 国内网络构建时：NPM_REGISTRY=https://registry.npmmirror.com/ docker compose build api
# 刻意不写进项目 .npmrc —— 否则会连累 CI 与海外部署者。
ARG NPM_REGISTRY=
RUN if [ -n "$NPM_REGISTRY" ]; then \
      pnpm config set registry "$NPM_REGISTRY"; \
      echo "使用 registry: $NPM_REGISTRY"; \
    else \
      echo "使用默认 registry（官方源）"; \
    fi

# 先拷贝清单文件以利用层缓存
COPY .npmrc pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

# pnpm store 挂 BuildKit 缓存：首次下载后持久保留，重试或重建时命中缓存不必全量重下。
# package-import-method=copy 是必须的——否则 node_modules 会是指向 /pnpm/store 的软链，
# 而该挂载在构建结束后即消失，运行期会找不到依赖。
#
# --filter @app/api... 只装 API 及其依赖；尾部 ... 表示连带装上它依赖的 workspace 包。
# 不加的话会把 apps/web 的 React + antd 一起装进 API 镜像（实测多占约 0.5GB），
# 而这个容器运行时根本不碰前端。
RUN --mount=type=cache,id=pnpm-store-api,target=/pnpm/store,sharing=locked \
    pnpm config set store-dir /pnpm/store && \
    pnpm config set package-import-method copy && \
    pnpm install --frozen-lockfile --filter @app/api...

# 拷贝源码并生成 Prisma Client、编译
COPY apps/api apps/api
RUN pnpm --filter @app/api prisma:generate && pnpm --filter @app/api build

EXPOSE 3080

# 启动时：应用迁移（prisma migrate deploy）-> 幂等种子 -> 启动服务
CMD ["sh", "-c", "pnpm --filter @app/api prisma:deploy && node apps/api/dist/prisma/seed.js && node apps/api/dist/src/main.js"]