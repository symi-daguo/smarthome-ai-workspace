# syntax=docker/dockerfile:1
# 构建上下文固定为仓库根目录：docker build -f apps/web/Dockerfile .

# ---- 构建阶段 ----
FROM node:24.19.0-alpine AS builder

WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@11.5.3 --activate

# registry 可覆盖：默认留空即走官方源（CI / 海外部署）。
# 国内网络构建时：NPM_REGISTRY=https://registry.npmmirror.com/ docker compose build web
# 刻意不写进项目 .npmrc —— 否则会连累 CI 与海外部署者。
ARG NPM_REGISTRY=
RUN if [ -n "$NPM_REGISTRY" ]; then \
      pnpm config set registry "$NPM_REGISTRY"; \
      echo "使用 registry: $NPM_REGISTRY"; \
    else \
      echo "使用默认 registry（官方源）"; \
    fi

COPY .npmrc pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/

# pnpm store 挂 BuildKit 缓存：与 api 用独立 cache id，避免并行构建时互相争锁。
# package-import-method=copy 是必须的——否则 node_modules 会是指向 /pnpm/store 的软链，
# 而该挂载在构建结束后即消失，运行期会找不到依赖。
RUN --mount=type=cache,id=pnpm-store-web,target=/pnpm/store,sharing=locked \
    pnpm config set store-dir /pnpm/store && \
    pnpm config set package-import-method copy && \
    pnpm install --frozen-lockfile --filter @app/web...

COPY apps/web apps/web
# API 走 nginx 同源反代，构建期使用相对路径（留空）
ENV VITE_API_BASE_URL=
RUN pnpm --filter @app/web build

# ---- 运行阶段 ----
FROM nginx:1.29-alpine

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /repo/apps/web/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
