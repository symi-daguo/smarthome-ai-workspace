# AGENTS 指南

## 约定

- 语言：回复与代码注释使用中文，不使用 emoji，技术术语保留英文
- 端口：web dev 5173、api 3080；5174 与 3081 禁止使用
- 决策阶梯：YAGNI → 代码库复用 → 标准库 → 原生能力 → 已装依赖 → 一行实现 → 最少可工作代码

## 提交前检查

```bash
pnpm typecheck && pnpm build && pnpm smoke
```

## 结构

- apps/api：NestJS 12，ESM，相对导入必须带 `.js` 后缀
- apps/web：React 19 + Ant Design 6，Vite 8
- 共享契约目前仅通过 HTTP API，暂不引入 shared package（YAGNI）

## 新增依赖

必须检查许可证（MIT / Apache-2.0 / BSD 优先；GPL / AGPL 禁止）与已知漏洞。
