# AGENTS 指南

## 约定

- 语言：回复与代码注释使用中文，不使用 emoji，技术术语保留英文
- 端口：web dev 5173、api 3080；5174 与 3081 禁止使用
- 决策阶梯：YAGNI → 代码库复用 → 标准库 → 原生能力 → 已装依赖 → 一行实现 → 最少可工作代码

## 提交前检查

```bash
pnpm typecheck && pnpm build && pnpm smoke
```

**不要把这些命令接 `| tail -N`**：管道会缓冲输出并吃掉 pnpm 的退出码，
上次就是这样把「编译失败」读成了「通过」。要收尾输出就重定向到文件再看。

## 技术栈版本纪律

**依赖一律用当前最新稳定版**，且必须联网核对，不能凭印象：

```bash
# 拉某个包的当前稳定版（dist-tags.latest 才是真相）
curl -s https://registry.npmjs.org/<包名> | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['dist-tags']['latest'])"
```

**`dist-tags.latest` 不等于稳定版**。Prisma 的 `latest` 当时指向 `8.0.0-rc.23`，
稳定版是 `prev` 标签的 `7.10.1`。判断依据：看 `versions` 里有没有同号的非预发布版本，
拿不准就对比 `latest` 与 `prev` 两个标签。

跨大版本升级前必须实跑全量门禁再决定升或不升，升不了的要在文档里写清理由与证据。

## 间接依赖漏洞修复

漏洞基本都来自间接依赖，**不新增依赖**，用 `pnpm-workspace.yaml` 的 `overrides` 顶上去：

- 用**精确版本选择器**（`lodash@3.2.0: 4.18.1`）而不是整包覆盖 ——
  整包覆盖会把项目里已修好的解析一起降级，反而倒退
- overrides 放在 `pnpm-workspace.yaml`，**不是 package.json**（pnpm 11 起不再读该字段，放错位置会被静默忽略）
- 选择器不支持 `>=` 形式（`lodash>=3.2.0` 会报 `Cannot parse the "=3.2.0" selector`）

审计命令必须显式指定官方 registry，走国内镜像时该端点不存在：

```bash
pnpm audit --registry=https://registry.npmjs.org
```

**审计建议的修复版可能根本不存在**：sprintf-js 的 advisory 写「>= 1.1.4 已修复」，
但官方 dist-tags 最新仍是 1.1.3（2023 年后无更新）——属上游无修复，
顶到现存最新版并在文档登记，不要反复尝试不存在的版本。

## 新增依赖

必须检查许可证（MIT / Apache-2.0 / BSD 优先；GPL / AGPL 禁止）与已知漏洞。

## 结构

- apps/api：NestJS 12，ESM，相对导入必须带 `.js` 后缀
- apps/web：React 19 + Ant Design 6，Vite 8
- 部署镜像：Node 24.22.0-alpine（当前 LTS 最新）、nginx 1.30-alpine（稳定线；奇数版是 mainline，不用于部署）
- 共享契约目前仅通过 HTTP API，暂不引入 shared package（YAGNI）

## 新增依赖

必须检查许可证（MIT / Apache-2.0 / BSD 优先；GPL / AGPL 禁止）与已知漏洞。
