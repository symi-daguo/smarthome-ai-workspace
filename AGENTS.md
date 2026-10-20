# AGENTS 指南

## 约定

- 语言：回复与代码注释使用中文，不使用 emoji，技术术语保留英文
- 端口：web dev 5173、api 3080；5174 与 3081 禁止使用
- 决策阶梯：YAGNI → 代码库复用 → 标准库 → 原生能力 → 已装依赖 → 一行实现 → 最少可工作代码

## 提交前检查

```bash
pnpm typecheck && pnpm build && pnpm smoke && pnpm check:docs && pnpm check:brand
```

**不要把这些命令接 `| tail -N`**：管道会缓冲输出并吃掉 pnpm 的退出码，
上次就是这样把「编译失败」读成了「通过」。要收尾输出就重定向到文件再看。

**`pnpm smoke` 跑的是 `dist/` 里的编译产物**（`apps/api` 的 script 是
`node dist/test/smoke.js`），不是 `test/smoke.ts` 源码。所以：

- 改了 `apps/api/test/smoke.ts` 之后**必须先 `pnpm build`**，否则跑的是旧断言
  （新加的断言一条都不会出现，条数与上次一模一样 —— 这是「断言没生效」的典型假象）
- 改了 `apps/api/src/**` 同样要先 build 再 smoke，否则测的是旧代码
- 断言总数不变时先怀疑「没重新 build」，而不是「新断言挂了」

**`pnpm check:docs` 查 GitHub 渲染问题**（`scripts/check-docs.mjs`）：
相对链接指向的文件/锚点是否存在、表格列数是否一致、代码块是否闭合、标题是否跳级。
这四类在编辑器里完全看不出来，渲染到 GitHub 上才发现。
写文档时用**仓库相对路径**（`apps/api/src/...`），
**不要写 `file:///Volumes/...` 这类本机绝对路径** —— GitHub 上点不开，还公开本机目录结构。

**`pnpm check:brand` 查第三方品牌痕迹**（`scripts/check-brand.mjs`）：
注册商标标记、第三方公司名、本机绝对路径链接、未登记的外链域名。
只扫 git 已跟踪文件（`git ls-files`），与 CI 口径一致。
**新增外链域名必须人工确认后加进脚本里的 `ALLOWED_DOMAINS`** ——
白名单只放公开服务（模型厂商 API / 包镜像 / 官方文档），第三方商业平台域名一律不进。
背景与完整证据见 [COMPLIANCE.md](./COMPLIANCE.md)。

## 前端纯逻辑回归（零新增依赖）

`apps/web/scripts/check-delivery-templates.mjs` 用 Node 24 原生类型剥离直接跑 TS：

```bash
node apps/web/scripts/check-delivery-templates.mjs
```

源码按 Vite 惯例写无扩展名相对导入，而 Node 的 ESM 要求完整扩展名，
脚本里用 `module.registerHooks` 补了一个解析钩子把 `../data/x` 映射到 `.ts`。
**不要为了跑脚本把源码改成 `.ts` 后缀**（TS 默认不允许 `allowImportingTsExtensions`）。

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
- apps/desktop：Electron 桌面端（内嵌 PostgreSQL + 本地 API + 前端），见下节
- 部署镜像：Node 24.22.0-alpine（当前 LTS 最新）、nginx 1.30-alpine（稳定线；奇数版是 mainline，不用于部署）
- 共享契约目前仅通过 HTTP API，暂不引入 shared package（YAGNI）

## 桌面端（apps/desktop）

方案与实测数据见《桌面打包方案.md》。门禁：

```bash
pnpm --filter @app/desktop build            # tsc -> dist/
pnpm --filter @app/desktop prepare:runtime   # 产出 runtime/（部署 + 裁剪，约 2 分钟）
pnpm --filter @app/desktop verify:runtime    # 运行时自证：起库→迁移→种子→登录
pnpm --filter @app/desktop verify:signature  # 签名闸门：每个 Mach-O 的签名 + bundle 封印
pnpm --filter @app/desktop dist:mac          # 出 .app / .dmg / .zip（已签名）
source ~/.symi/notary.env && npm run notarize   # 公证 + 装订
```

`verify:runtime` 是**必须**跑的：裁剪动作（去方言 wasm、去 sourcemap、摘孤儿依赖）
最容易出的错是「装的时候没事、真跑起来少个文件」。它只用自己的 runtime/，
不借用工作区的任何东西。

### 十四条实测踩过的坑

1. **Electron 里 `process.execPath` 是 Electron 可执行文件，不是 node。**
   用它跑 Node 脚本必须带 `ELECTRON_RUN_AS_NODE=1`，否则 Electron 会把脚本当成应用去打开
   （表现为命令静默挂起）。
2. **asar 里不要放依赖。** electron-builder 的依赖收集会顺着 pnpm 的软链
   把整个工作区的 devDependencies 卷进来（实测 asar 涨到 308MB）。
   现在 asar 只放主进程代码（约 32KB），`pg` 从 API 运行时目录用 `createRequire` 加载。
3. **`extraResources` 必须从上一级目录复制。** 复制器**硬编码排除复制源根目录下的
   `node_modules`**（`filter.js` 里 `if (relative === "node_modules") return false`），
   所以写 `from: runtime/api` 会让依赖目录整个消失（实测只复制到 2MB）。
   现在写 `from: runtime, to: .`。
4. **`@prisma/studio-core` 与 `@prisma/dev` 不能整包删。**
   Prisma CLI 启动时会饿汉 require 它们的子路径，删了直接 `MODULE_NOT_FOUND`。
   pnpm 的 `.pnpm/node_modules` 隐藏仓库会让「删掉链接」看起来还是好的，
   直到孤儿扫描把实体目录也清掉才暴露 —— 只裁内部用不到的部分（UI / metafile / runtime-assets）。
5. **`@prisma/engines` 的原生 `schema-engine-<platform>` 不能裁。**
   Prisma CLI 发现它缺失会**自动去下载**（设不可达代理仍能下载成功，说明不走代理）。
   裁掉它等于把「首次启动必须联网下载 24MB」写进产品。
6. **签名必须配 `mac.signIgnore`。** osx-sign 默认把 bundle 里**每个文件**都签一遍
   （每个文件一次 codesign + 一次 Apple 时间戳服务往返，16000 个文件要跑几小时）。
   用正则只签 Mach-O：`'/Contents/Resources/api/node_modules/.*\.(?!node$|dylib$|so$)[^./]+$'`
   —— 负向断言保住 `.node`/`.dylib`/`.so` 与**无扩展名**的可执行文件
   （`schema-engine-<platform>` 就是无扩展名的 Mach-O，漏了它公证会被拒）。

   ⚠️ 孤儿扫描删掉 `.pnpm` 条目后，`.pnpm/node_modules` 隐藏仓库里会留下**悬空软链**，
   打包器复制到一半会 `ENOENT` 失败 —— 扫描完必须清掉断链。
7. **`stapler` 不支持 zip。** `xcrun stapler --help` 写明只支持
   「UDIF 磁盘镜像、可执行 bundle、flat 安装包」。所以分发用 zip **只提交不装订** ——
   zip 里装的是**已装订的 app**，ticket 跟着 app 走，Gatekeeper 校验的也是 app。
8. **`electron-builder --prepackaged` 不会重新签名。**
   `app-builder-lib` 里两个 `doSignAfterPack` 调用点都在 `doPack()` 内，
   而 prepackaged 模式下 `doPack()` 第一行就 `return`。
   所以「用装订后的 app 重打 dmg」不会把 ticket 破坏掉 —— 这条是整个公证顺序成立的前提。
9. **`apps/desktop/release/` 与 `apps/desktop/build/` 的忽略边界不能一刀切。**
   `release/` 是安装包输出（.app 约 570MB + dmg 约 225MB），必须整体忽略；
   但 `build/` 里 `entitlements.mac.plist` 是 `electron-builder.yml` 引用的**源文件**，
   忽略掉的话新克隆的仓库编不出 mac 包 —— 只忽略 `build/` 下由 `make-icons.mjs` 生成的图标。
10. **已签名的 app bundle 在运行期不能被写入 —— 两个来源，都踩过。**
    codesign 的封印（CodeResources）记录了每个文件的哈希，运行期往 bundle 里写/改任何文件，
    封印就失效了，Apple 公证直接拒：
    - **Prisma CLI 会把 schema engine「恢复」成原始副本**：它启动时校验引擎校验和，
      发现和官方发布不一致就恢复。包内引擎被签了 Developer ID → 校验和不符 → 被恢复成 adhoc
      → Apple 报「not signed with a valid Developer ID certificate」「no secure timestamp」
      「no hardened runtime」，同时引擎内容变了又把主可执行文件拖成
      「The signature of the binary is invalid」。
      **解法**：启动时把引擎**复制到 bundle 之外**，用 `PRISMA_SCHEMA_ENGINE_BINARY` 指过去。
    - **jiti 会把 .ts 配置的转译缓存写进 `node_modules/.cache/jiti/`**：
      Prisma 用 jiti 加载 `prisma.config.ts`，缓存就落在 bundle 内部。
      **解法**：运行时改用纯 JS 的 `prisma.config.mjs`（jiti 不转译、不写缓存）。
    这两条都是「本地 codesign --verify 通过、只有 Apple 才拒」的问题，**必须用真机自证**。
11. **公证前必须过签名闸门**：`pnpm --filter @app/desktop verify:signature`。
    它检查「每个 Mach-O 都用 Developer ID 签名」+「bundle 封印有效」，
    上面那两类缺陷都能被它当场抓住。写这个脚本时自己也踩了两次坑：
    `readFileSync(path,{length:4})` 的 length 对路径无效（会整个读完，闸门「扫到 0 个」假通过），
    以及 `codesign -dv` 的结果**写在 stderr**（只看 stdout 会把每个文件都判成未签名）。
12. **孤儿扫描看不见 `.pnpm` 实体目录。** 扫描只认 `node_modules/<name>` 这一层的**软链**，
    pnpm 的实体目录 `node_modules/.pnpm/<pkg>@<ver>/` 它根本看不见 ——
    链接被摘掉后实体目录就成了「没人引用但还在」的孤儿
    （实测 `@electric-sql+pglite@0.4.3` 白占 20MB）。
    要回收必须**显式按 `.pnpm` 条目名删**，不能指望扫描。
13. **electron-builder 26.x 没有 `electronLanguages` 选项**（全量搜索无此字段），
    而 `files` 过滤器只作用于 app 自身目录，管不到 `Contents/Frameworks` 里
    从官方 zip 解出来的 Electron Framework。要裁那 220 个 `.lproj` 语言包（46.9MB）
    只能用 `afterPack` 钩子（`scripts/after-pack.mjs`）。
    **必须放在 afterPack（打包后、签名前）**：Electron Framework 的 `Resources/`
    本来就在 `signIgnore` 里（不签名），裁完再签，封印与最终内容才对得上；
    先签再裁，封印立刻失效。
14. **`pnpm-lock.yaml` 必须与 `package.json` 同步。** 删了依赖却没同步 lockfile，
    任何干净克隆执行 `pnpm install --frozen-lockfile` 都会直接失败：
    `specifiers in the lockfile don't match specifiers in package.json`。
    本机 node_modules 早就装好、日常又只跑 `pnpm build`（不做 install 校验），
    不一致能藏很久 —— **只有 CI 或干净克隆才会暴露**。
    改完依赖记得跑一次 `pnpm install` 并复测 `--frozen-lockfile`（全量与 filter 两种）。

### CI（GitHub Actions）

`.github/workflows/ci.yml`，两个 job：

- **gate**：`pgvector/pgvector:pg18` 服务 → `prisma generate` → `migrate deploy` → 灌种子
  → typecheck → build → smoke
- **desktop**：`ELECTRON_SKIP_BINARY_DOWNLOAD=1` → 只跑 tsc

两条要注意的：

- 数据库服务**必须用 pgvector 镜像**：历史迁移里有 `CREATE EXTENSION vector`，
  普通 postgres 镜像会失败。
- CI 环境变量用 `NODE_ENV=production`：用 development 跑等于把
  「生产环境拒绝弱默认密钥/密码」这道红线绕过去了，等于没测。

本地验证 CI 时要用**完全相同的命令序列**实跑一遍，不要「照着配置想当然」。

### 体积统计口径

运行时体积按 **inode 去重**统计（与 `du` 一致）。pnpm 的隔离布局里
`node_modules/<pkg>` 是指向 `.pnpm/<pkg>@<ver>/node_modules/<pkg>` 的软链：
按软链跳过会少算，按软链累加会重复算，只有按 inode 去重才对。

## 新增依赖

必须检查许可证（MIT / Apache-2.0 / BSD 优先；GPL / AGPL 禁止）与已知漏洞。
