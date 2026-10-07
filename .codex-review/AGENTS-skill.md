# 仓库约定（AGENTS.md）

- 端口：web dev 5173，api 3080；5174 / 3081 禁用
- 决策阶梯：YAGNI → 代码库复用 → 标准库 → 原生 → 已装依赖 → 一行 → 最少可工作
- 中文回复、无 emoji、英文术语保留
- 提交前：`pnpm typecheck && pnpm build && pnpm smoke`
- 新增依赖前要查许可证（MIT/Apache/BSD；GPL/AGPL 禁）
