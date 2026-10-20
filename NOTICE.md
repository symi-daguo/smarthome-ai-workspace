# 开源说明

本项目以 **MIT 许可**免费开源（见 [LICENSE](./LICENSE)），供伙伴自部署使用。

## 部署定位

开源自部署，**注册即租户管理员、默认最高权限**：模型配置、额度发放、成员管理均可自助操作。
本项目不设付费墙、不做功能锁定（与部分同类产品的会员分级机制不同，这是刻意的定位差异）。

## Clean-room 复刻声明

本项目参考了同类智能家居 AI 工作站的**功能形态与交互模式**，但：

- **未复制对方任何源代码**；
- **未使用对方的图片、图标、文案、商标等素材**——`apps/web/public/images/` 下所有图片均为
  本项目自行 AI 生成或自行绘制；
- 全部实现为自有代码，自有视觉体系（靛蓝主色 + 自有阴影/转角体系），不复制对方品牌标识与配色。

> 这一点不是口头承诺：仓库里跑得起来的
> **`pnpm check:brand`** 会扫每一个已跟踪文件，查第三方商标标记、公司名、
> 本机绝对路径链接与未登记的外链域名；新增域名必须人工确认后才能加白名单。
> 完整证据与核查方法见 [COMPLIANCE.md](./COMPLIANCE.md)。

`replica/` 目录下的对标基线文档（`recon.md` / `features.csv` / `ai-canvas-spec.md` /
`full-parity-matrix.md`）记录的是**功能形态与差距分析**，不含对方代码。
参考站原始截图（`.ref-site/`、`replica/screens/`、`replica/diffs/`）遵循 clean-room 原则
**仅本地留存、不入库**，`.gitignore` 已明确排除。

## 第三方依赖

全部依赖均为宽松许可，与 MIT 兼容：

| 许可 | 主要依赖 |
|---|---|
| MIT | NestJS、React、Ant Design、Vite、Prisma CLI、zod、pg、argon2、exceljs、pptxgenjs、dayjs、react-router-dom、ws |
| Apache-2.0 | pdfjs-dist、Prisma Client、Prisma CLI、reflect-metadata、rxjs |
| BSD-2-Clause | mammoth |
| ISC | lucide |

无 GPL / AGPL / SSPL / 商业限制类依赖。

## 数据与密钥

- 仓库内**不含任何密钥**：`.env` 已被 `.gitignore` 排除，`.env.example` 仅提供占位值。
- 部署前请务必修改 `JWT_SECRET` 与 `SEED_ADMIN_PASSWORD`（生产模式下未修改会**拒绝启动**）。
- 用户上传的图片、视频与导出文件落在 `uploads` 卷，**不在版本控制内**。

## 贡献

欢迎提交 Issue 与 PR。请在提交前确保门禁全绿：

```bash
pnpm typecheck && pnpm build && pnpm smoke
```
