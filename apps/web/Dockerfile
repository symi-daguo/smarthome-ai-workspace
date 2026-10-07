# 构建上下文固定为仓库根目录：docker build -f apps/web/Dockerfile .

# ---- 构建阶段 ----
FROM node:24.19.0-alpine AS builder

WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@11.5.3 --activate

COPY .npmrc pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @app/web...

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
