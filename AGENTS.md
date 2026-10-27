# AGENTS 指南

## 约定

- 语言：回复与代码注释使用中文，不使用 emoji，技术术语保留英文
- 端口：web dev 5173、api 3080；5174 与 3081 禁止使用
- 决策阶梯：YAGNI → 代码库复用 → 标准库 → 原生能力 → 已装依赖 → 一行实现 → 最少可工作代码

## 提交前检查

```bash
pnpm typecheck && pnpm build && pnpm smoke && pnpm check:docs && pnpm check:brand \
  && pnpm check:templates && pnpm check:pptx
```

**这道清单必须与 CI 的 gate job 完全一致** —— 少一道就会变成
「本地全绿、CI 全红」，而 CI 是唯一能证明仓库真的能构建的地方。
CI 的 gate job 跑的是：typecheck → check:docs → check:brand →
**check:templates && check:pptx** → build → smoke。
2026-10-26 本地清单少了 `check:templates` / `check:pptx` 两道，
删掉 `/vip` 路由后那条「关键入口都在生效代码里」的断言失效，
本地没报错、CI 直接把 job 打红 —— 提交前检查漏一道，等于没检查。

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

**前端另外两条**（提交前必跑；改 PPTX 相关代码时再加跑第三条）：

```bash
pnpm check:templates        # 交付模板纯逻辑回归（零新增依赖，Node 24 原生类型剥离）
pnpm check:pptx            # 阴影参数的 XML 层检查
pnpm --filter @app/web check:pptx-render   # 前两页的**本机真实渲染**自证
```

`check:templates` 的触发范围**不止 PPTX**：它还断言「关键入口都在生效代码里」
（扫 `apps/web/src` 全目录）。所以**删改任何关键入口都要跑它** ——
删了入口却没同步删掉 `apps/web/scripts/check-delivery-templates.mjs` 里
`REQUIRED_ENTRIES` 的对应行，那条断言会一直要求已废弃的功能存在，
CI 直接把 job 打红（2026-10-26 删 `/vip` 就踩到了）。

`check:pptx-render` 用**生产代码**（`exportPlanPptx`）生成前两页，
再用本机真实渲染器（LibreOffice → PDF → PNG）出图，
检查渲染结果**不是空白页**（数与背景色不同的像素占比）。
只查 XML 参数是不够的 —— **参数合法 ≠ PowerPoint / WPS 能正常打开并显示**：
「形状整块不显示」的缺陷，XML 层面完全查不出来，渲染出来才看得见。
渲染器缺失时脚本**明确跳过并返回非零退出码**，不假装通过。

## 改公开文档后的自查（四步，缺一不可）

两道机器闸门只能挡住**格式与关键词**，挡不住下面这四类 —— 2026-10 的公开前审查
就是闸门全绿之后，又靠这四步查出 20 多处真问题：

1. **数字与实现对账**：文档里每个数字都要能对回代码/数据库/API。
   实际抓到的错：manifest 操作数（138 → 实为 150）、权限 action 数（15 → 20）、
   备份表数（28 与 33 自相矛盾）、依赖许可计数（766 无法复现）、
   token 量级（估的，改成响应体字节数才可复现）、日志轮转（10MB×3 → 实为 10MB×2）、
   prune 保留期（7 天 → 实为 24 小时）。**用真实请求/脚本核实，不要凭印象**。
2. **与现状一致**：文档不能停留在旧版本。抓到的错：桌面端已交付却仍列在「未做」里、
   「备份恢复未实现」但代码里早已有 restore 端点、知识库写成 pgvector 向量检索
   （实际是中文 bigram 关键词召回，schema 里根本没有 vector 列）。
3. **死路径引用**：指向未入库目录（`replica/`、`.ref-site/`）的引用在公开仓库是死链。
   写脚本扫一遍「md 里提到的相对路径是否真实存在」。
4. **人工通读**：关键词扫描清零 ≠ 文档干净。仍需逐份读，揪出
   截断的 `…`、自曝式内部叙述、emoji 标记符、语病与别扭的替换痕迹。

> 顺带：仓库里的内部工作笔记目录已移出版本控制 ——
> 内部记录里的措辞与命名不适合出现在公开仓库里。

## 前端纯逻辑回归（零新增依赖）

`apps/web/scripts/check-delivery-templates.mjs` 用 Node 24 原生类型剥离直接跑 TS：

```bash
node apps/web/scripts/check-delivery-templates.mjs
```

源码按 Vite 惯例写无扩展名相对导入，而 Node 的 ESM 要求完整扩展名，
脚本里用 `module.registerHooks` 补了一个解析钩子把 `../data/x` 映射到 `.ts`。
**不要为了跑脚本把源码改成 `.ts` 后缀**（TS 默认不允许 `allowImportingTsExtensions`）。

## 前端注释隐藏：JSX 注释块不能嵌套

把整块 JSX 收进 `{/* ... */}` 注释时，有两个必须避开的坑：

1. **块内原有的 `{/* ... */}` 会提前闭合外层注释** —— 编译期报
   `TS1381: Unexpected token`。解法：把块内的内层注释删掉（信息并进外层说明）。
2. **说明文字自己不能写 `*/`** —— 写了它就自成一对，代码块末尾的 `*/}` 会变成孤立语法错误。
   正确写法：说明文字**不闭合**，由代码块末尾统一收口。

被注释掉代码里的变量会变成未使用，但 `apps/web/tsconfig.json` **没有开**
`noUnusedLocals`，所以不会报类型错误 —— 可以放心「藏起来而不删掉」。

用 `/* ... */` 注释代码、用 `{/* ... */}` 注释 JSX，两者在 JSX 表达式上下文里都能用，
但**嵌套时都只会认第一个 `*/`**。

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

## 清理测试数据（smoke 跑完必做）

`pnpm smoke` 每跑一次都会造一批多租户测试数据（租户、成员、产品、日志…）。
**发版前必须清干净**，否则交付出去的库是脏的。

**铁律：TRUNCATE 只能用于「纯日志 / 任务 / 凭据」表。**

带租户业务数据的表（`Product` / `MediaAsset` / `CategoryDef` / `PlanProject`…）
**必须**用带 `tenantId` 条件的 `DELETE`：

```sql
-- 对：只删非 platform 租户的行，platform 的正式数据留着
DELETE FROM "MediaAsset"
 WHERE "tenantId" IS NOT NULL
   AND "tenantId" <> (SELECT id FROM "Tenant" WHERE slug='platform');

-- 错：TRUNCATE 不看 tenantId，整表清空
TRUNCATE "MediaAsset" ...;
```

**踩过的坑**：把 `MediaAsset` 误放进 TRUNCATE 列表 ——
它里面有 platform 租户的**正式素材**（示例方案的底图与渲染图），
一清空方案就残缺（`floorplanAssetId` 与 `renderAssetIds` 指向的素材全没了）。
事后从 `pg_dump` 备份恢复：

```bash
docker exec -i aisaas-db-1 pg_restore -U smarthome -d smarthome \
  --data-only --table=MediaAsset < /tmp/aisaas-backup-2.dump
```

**`--table` 的名字不要带引号**：写 `--table='"MediaAsset"'` 会**匹配不到、静默恢复 0 行、
还不报错** —— 差点误判成「备份里没数据」。

另外两个坑：

- **删除顺序**：`Role` 被 `Membership` 外键引用、`User` 被 `Membership` 引用，
  必须**先删 `Membership`** 再删别的
- **条件别写反**：`"tenantId" IS DISTINCT FROM platform` 会把 `tenantId IS NULL` 的
  **系统预置角色**（11 个）与公共产品一起误删，要写成
  `"tenantId" IS NOT NULL AND "tenantId" <> platform`

**清空「日志/任务/凭据」类表时用 `DELETE` 不用 `TRUNCATE`**：
`TRUNCATE` 的外键检查**不看行内容**，只要有表引用就整个拒绝
（`cannot truncate a table referenced in a foreign key constraint`）。
要过就得加 `CASCADE` —— 而 `CASCADE` 会连带清掉别的表，风险不可控。
`DELETE` 没有这个限制，顺序也不敏感（先删引用方即可）。

**有些表没有自己的 `tenantId`**（`OrderNote` / `ExtractedField` /
`ExtractionDeficiency` / `ReviewConfirmation`），它们通过父表关联租户，
要写成 `WHERE "父表外键" IN (SELECT id FROM "父表" WHERE "tenantId" <> platform)`。

**在 platform 租户里做的验证数据，租户条件清不掉**：走查时用管理员账号
（属于 platform 租户）造的产品/方案/布局/素材会留在库里，
只能按 id 精确删。清完要**逐项核对计数**，
光看总数会漏（「产品 142 vs 基线 139」就是平台租户里残留 3 条自建产品）。

**清完必须核对计数**（对照干净基线，2026-10-26 实测）：租户 1 / 用户 2 / 成员关系 2 /
角色 11 / 权限 26 / 预置分类 39 / 产品 139（其中导入产品 115）/ 素材 35 / 方案 1 /
审计 4 / 变更快照 0 / 抽取作业 0 / 抽取文档 0 / 额度账本 8 / ApiKey 1 / 工单 0；
uploads 卷 35 个文件 / 17.2MB（与库里的素材引用逐条对账，无孤儿、无悬空引用）。

> 「用户 2、成员关系 2、审计 4」不是残留，是正式痕迹：
> 桌面端真机自证要在 platform 租户里登录一次，必然留下管理员用户与审计。
> 清成 0 反而说明把正式数据也删了。

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
pnpm --filter @app/desktop verify:zip        # zip 闸门：非 ASCII 文件名的 UTF-8 标志
pnpm --filter @app/desktop dist:mac          # 出 .app / .dmg / .zip（已签名）
source ~/.symi/notary.env && npm run notarize   # 公证 + 装订
```

`verify:runtime` 是**必须**跑的：裁剪动作（去方言 wasm、去 sourcemap、摘孤儿依赖）
最容易出的错是「装的时候没事、真跑起来少个文件」。它只用自己的 runtime/，
不借用工作区的任何东西。

### 三十二条实测踩过的坑

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

   **注意**：孤儿扫描删掉 `.pnpm` 条目后，`.pnpm/node_modules` 隐藏仓库里会留下**悬空软链**，
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
15. **公证上传会断流，两个 S3 端点表现不一样 —— 而且顺序会随链路变化。**
    2026-10-22 发 1.0.3 时实测：`--s3-acceleration` 连传两次都在 25 分钟后被判死
    （`abortedUpload`，Apple 侧探不到该记录），换 `--no-s3-acceleration` 一次过。

    **2026-10-23 发 1.0.4 把两个端点各试了一遍，结论与上次一致** ——
    在 **notarytool 这条路径**上，加速端点是「快但必断」：
    11:17 那次提交后 **2 分钟内**就 `abortedUpload`；
    常规端点是「慢但能成」：当天 09:28 那次 6 分钟就 Accepted，
    10:16 那次传满 30 分钟才断（同样的 `abortedUpload`，属于链路抖动）。
    所以端点顺序保持**常规端点优先**（`notarize.mjs` 的 `variants`）。

    **别拿 `curl -T` 的测速数字套到 notarytool 上**：curl 走的是它自己的代理配置，
    实测加速端点 3s、常规端点 100s 仍未传完 —— 与 notarytool 的表现**正好相反**。
    要判断 notarytool 走哪个端点快不快，只能看 notarytool 自己的提交结果。
    （测速方法本身也有坑：必须去掉 curl 的 `Expect:` 头，
    否则 S3 在校验签名的瞬间就返回错误、body 根本没传，
    测出来是「1 秒传完 20MB」的假数据。）

    **教训：链路会变，每次都要实测再定，不能照抄上一轮的结论** ——
    照抄的代价是 30 分钟上传白费。
    另：公证进程**中途不要杀** —— 杀掉一个正在传字节的 `notarytool submit`，
    会在 Apple 侧留下一条永远 `In Progress` 的死记录，
    只能等宽限期（30 分钟）判死后重传。
16. **公证脚本可幂等续跑，中断后重跑即可。** 它会跳过「app 已有 Accepted 提交
    且当前 app 已带有效签章」与「dmg 已有 Accepted 提交」的部分，只补做没做完的步骤
    （装订 dmg、生成分发用 zip）。所以**跑挂了直接重跑，不要从头再来**。
    但注意 `notarytool submit --wait` 超过 30 分钟会被外层超时砍掉，
    这时 dmg 可能已提交但没等结果 —— 查 `notarytool history` 确认状态再决定是否重跑。
    读 history 的 JSON 时结构是 `{"history": [...], "message": ...}`，
    **不是顶层数组** —— 当数组遍历会拿到空结果，白以为「没有提交记录」。
17. **dmg 本身没有代码签名，这是正常的。** `codesign -dv <dmg>` 会报
    `code object is not signed at all`，因为签名在 dmg **里面的 app** 上；
    dmg 上挂的是公证票据，用 `xcrun stapler validate <dmg>` 验证。
    验 app 才用 `spctl -a -vvv -t exec <app>`（应看到 `accepted / Notarized Developer ID`）。
18. **CI 里的命令必须自己带超时。** Windows job 的「运行时自证」曾连续三轮
    挂满 60 分钟整被 job 超时取消，**且日志拿不到** —— job 被取消时 GitHub
    不归档那一步的输出（`gh run view --log` 与 `/actions/jobs/<id>/logs` 都是 0 字节），
    等于白等一轮且毫无线索。
    根因是 `execFileSync` 不设 `timeout`：子进程不退出，父进程就一直等。
    修法在**统一入口** `tryRun` 里一次解决（所有外部命令都走它）：
    - 传 `timeout`（Node 原生支持，超时会杀掉子进程并抛错）
    - 执行前打印是哪条命令 → 卡住时日志最后一行就是卡点
    - 再加一条**自检**：故意跑一个 60 秒不退出的子进程，确认 2 秒内被终止。
      超时要是形同虚设，后面每一步还是会无声地挂住，所以这个机制本身要能被验
    **教训**：CI 上出问题时，「让脚本自己说话」比「猜」快得多 ——
    一条时间戳/命令名的打印，往往比三轮盲猜省时间。
19. **Windows 上 `pg_ctl` 的输出不能接管道，必须写文件。**
    这是 Windows CI 挂满 60 分钟的**真正根因**（连挂三轮才定位到）：
    `pg_ctl start -w` 在 Windows 上会启动 postgres 并继承 pg_ctl 的 stdout 句柄
    （`-l` 参数在 Windows 上不生效，日志不会落到文件），
    于是 pg_ctl 打印完 `waiting for server to start.... done` **自己退出了**，
    管道却因为 postgres 还持着句柄而不 EOF ——
    `spawnSync` 一直等到超时（实测 300 秒），job 被取消时日志还没归档，线索全丢。
    **表现极具误导性**：PG 其实已经起来了，卡的是「等进程输出结束」这一步。
    修法：pg_ctl 的 `stdio` 用文件 fd（`['ignore', fd, fd]`）而不是 `'pipe'`。
    写文件就没有管道，`spawnSync` 只等 pg_ctl 本身退出。
    - 文件要放在临时目录**外面**：postgres 会一直持有它，放在 work 里会导致 work 删不掉
    - 加一条自检盯住「输出确实进了文件」，谁把 `stdio` 改回 pipe，脚本立刻变红
    - 清理失败（`rmSync` 撞上被占用的文件）**不能**让验收失败 ——
      残留一个临时目录不影响结论，抛出去反而把「验收通过」变成「验收中断」
    **同源教训**：`Get-ChildItem -Recurse` 扫 `release/` 会把 `win-unpacked\` 里的
    app 主程序（`智能家居AI工作台.exe`）和内嵌 PostgreSQL 的 `initdb.exe` 一起扫进来，
    那些是**程序内部文件、名字带中文是正常的** —— 一扫就误判「产物名含非 ASCII」。
    校验产物名只看 `release/` **顶层**（`-File` 不带 `-Recurse`），
    真正的安装包由 `win.artifactName` 命名，天然是 ASCII。
20. **「已完成」的判据要落在数据上，不能落在配置标记上。**
    桌面端首启原本用 `desktop-config.json` 里的 `migrated` 标记决定要不要跑种子。
    标记与数据库的实际状态可能对不上 —— pgdata 被重建、种子中途失败、
    异常退出把库搞空，这几种情况下标记都还写着「已完成」。
    一旦对不上，种子被**永远跳过**：用户装完打开应用，库里一个用户都没有，
    **根本登不进去**（实测：`migrated: true` 而 `"User"` 表为空）。
    现在改成查库：库里有管理员才跳过种子，查不到就按「没有」处理（宁可重跑一次幂等种子）。
    - 查库用主进程里现成的 `loadPg`（`createRequire` 从 API 运行时目录加载 pg）
    - 同一份配置里的 `dbInitialized` 也和实际对不上（写着 `false` 而 pgdata 早就在了），
      **配置标记不可信**这条是通用的
    **教训**：状态标记只在「写入与读取在同一事务域」时才可靠。
    跨进程、跨崩溃点（配置写文件 vs 数据库提交）就不成立了 ——
    这类判据要么改查数据，要么让写入与判据同源。
21. **桌面端首次启动的迁移偶尔会慢到几分钟（原因未定位）。**
    实测：桌面端由 app 自己拉起 PostgreSQL 后紧接着跑 `prisma migrate deploy`，
    正常 1 秒，**偶发一次 2 分 56 秒**（同一份代码、同一份运行时）。
    排查过并**排除**的：
    - Prisma CLI 的更新检查 —— 把 `HTTPS_PROXY` 指向不可达地址也不慢，
      且带不带 `CHECKPOINT_DISABLE=1` 都一样快（`PRISMA_HIDE_UPDATE_MESSAGE`
      只管「不显示提示」，请求照发）
    - schema engine 副本 —— 单独执行 `--version` 毫秒级返回
    - 管道 / stdio —— 用宿主 node 完整复现主进程的 spawn 方式，1 秒完成
    - 数据库锁 —— `pg_stat_activity` 里连 Prisma 的连接都没有，它卡在连库之前
    抓到的现场栈停在 `node::fs::FileHandle::CloseReq::Resolve()`（关文件句柄）。
    **现状**：`prisma()` 已有 `timeout: 300_000`，最坏 5 分钟后报错退出，
    不会永久卡死；实测第二次启动就恢复到 1 秒。
    **遇到时的做法**：先重试一次（大概率秒过），别急着改代码；
    真要定位就把 `prisma()` 的 stdout/stderr 落盘，别只看 `execFileAsync` 的返回。
22. **「已公证过」这类判据要落在内容上，不能只看「同名 + 记录存在」。**
    公证脚本原先判断「同名的 dmg 有条 Accepted 记录 + 本地文件存在」→ 复用，不重打。
    本轮踩中：09:34 那条 Accepted 的 dmg 是用**当时的 app** 打的；
    后来 10:01 重打 mac 产物（`electron-builder dist:mac`）把那个 dmg **整个覆盖**了 ——
    新 dmg 里的 app 还没装订。而三个条件全中，于是脚本把没票的 dmg 当成已公证的那一份。
    后果很隐蔽：dmg 本身会被 staple 上票（验 dmg 过得去），
    但**从 dmg 拖出来的 app 自己没有电子签章**，Gatekeeper 照样拦。
    现在多加一条判据：本地 dmg 必须**已经带着电子签章**（`stapler validate` 通过）——
    只有被 staple 过的那一份，才可能与 Apple 侧已公证的内容是同一份字节。
    **同源教训**：见第 20 条 —— 判据要落在数据（字节、库里查得到的东西）上，
    不能落在「名字对得上 + 文件在」这种间接证据上。
23. **zip 的中文名要改「标志位」，不要重压。**
    app bundle 目录名是中文（`智能家居AI工作台.app`），electron-builder 打 zip 时
    **没在文件名含非 ASCII 时置 0x800 标志**（general purpose bit flag），
    Windows 资源管理器按 CP437 解读 → 解压出乱码目录。
    - 字节**本来就是标准 UTF-8**，缺的只是一个标志位 → 不用重压、不用改目录名
    - 改目录名会让访达里显示英文名，是产品体验倒退，**不要改**
    - 重压 603MB 会改掉产物**全部字节** → 已公证 app 的票据按字节算，
      改了就可能要重新公证，代价与收益不成比例
    - **只改 header 里的标志位，数据区一个字节不动** → 票据继续有效
    - 落地：`scripts/fix-zip-utf8.mjs` 走 central directory
      （那里记着每个条目的 local header 偏移），**local header 与 central 两处都改**
      （读工具优先看 central，但有的解压器只读 local）
    - **踩过的坑**：不能顺序扫 local header —— 42658 个条目里 36002 个置了 bit 3
      （数据描述符），描述符长度在 zip64 下还会变，手工跳偏移必然错位
      （报「local header 签名不对」）。走 central directory 的偏移记录才稳。
    - 挂在 electron-builder 的 **`artifactBuildCompleted`** 钩子
      （`afterPack` 时 zip 还没生成，只有产物生成后才有 zip）→ 下次打包自动带上
    - **但公证流程会把它覆盖掉（2026-10-23 发 1.0.5 实测）**：
      公证脚本为了让 zip 装的是**已装订的 app**，会用 `ditto` **重新生成**一份分发 zip，
      覆盖掉打包时修好的那份 —— `ditto` 与 electron-builder 一样不置 0x800 标志。
      实测最终发出去的 zip 里 42652 个非 ASCII 条目**全部**缺标志（Windows 上必然解出乱码目录）。
      **修法**：`notarize.mjs` 在 `ditto` 之后调用 `fixZipUtf8Flags` 并回读自检，
      缺标志就 `fail`（不装订的 zip 不该发出去）。
      **教训**：钩子只覆盖「生成它的那一步」，**后续步骤覆盖产物时必须重跑修复** ——
      判据是「最终产物」而不是「某一步的产物」。
    - 配套 `scripts/verify-zip-utf8.mjs`：判据落在**内容**上
      （真读一遍 zip 数缺标志的条目数），不落在「配置写了没有」上
    **验证过的结果**：42657 个非 ASCII 条目缺标志从 42657 降到 0；
    37063 个文件逐条比对内容差异 **0 个**；`unzip -t` 无错；
    解压出目录名是 `智能家居AI工作台.app`；`codesign` / `spctl` / `stapler` 全部依然通过。
24. **模型的「思考 token」也占 `max_tokens` 预算。**
    写死 `maxTokens: 12000` 时 15 页方案**稳定失败**（JSON 说到一半被截 → 括号不配平
    → 报「模型返回格式异常」），而 9 页刚好够 —— 看起来像「页数太多不支持」，
    实际是**输出预算不够**。
    - 实测取证：在容器内直连上游看 `usage`，
      一次输出 7976 token 里有 **4415 是思考**（占 55%），正文只用了 7580 字符
    - 15 页正文 + 讲稿本身就要约 9000 token，叠加思考撞上限 → 截断
    - 模型上限够用（M3.1 Flash 最大输出 524,288 token），
      `max_tokens=32000` 同样能跑完 → **不是模型限制，是我们给少了**
    - 修法：按内容规模给预算，**不改提示词**（提示词没问题）
    - **两种失败必须分开报**：`LLM_JSON_TRUNCATED`（有 `{`/`[` 但配不平 = 被截断，
      要加预算或减页数）与 `LLM_JSON_PARSE_FAILED`（连开始符都没有 = 没输出 JSON，
      要改提示词或换模型）。以前都报「格式异常」，运维只能靠猜
    - 判据抽成纯函数 `classifyJsonFailure()`，两处调用点（`chatObject` / `chatJson`）
      共用同一份 —— 两处各写一遍正则，早晚会长歪
    **同源教训**：见第 20、22 条 —— 报错信息要能直接指向动作，
    「格式异常」这种话等于让人猜。

25. **`spctl` 一评估，app bundle 就被内核冻结 —— 公证票据会凭空消失。**
    macOS 给被 Gatekeeper 评估过的 app 逐文件打上 `com.apple.provenance` +
    `com.apple.macl`，**内核层冻结内容**：往 bundle 里新建/修改任何文件都
    `Operation not permitted`（EPERM）。触发条件：跑过 `spctl -a -vvv -t exec`、
    或被双击打开过。
    - 后果：`stapler staple` 的动作序列是「先 unlink 旧票、再写新票」，
      第一步成功、第二步被 EPERM 拒 → **旧票没了、新票没写成**，
      票据凭空消失（exit 73，报错只说 `Could not remove existing ticket`）。
    - 迷惑点：`spctl` 说 `accepted / Notarized Developer ID`（它走联网查询，
      本来就不需要本地票据），`stapler validate` 说没票 —— **两个结论同时成立**。
    - 判据落在数据上：bundle 里 `touch` 任意文件得到 EPERM = 被冻结；
      `xattr -l <bundle>/Contents` 里有 `com.apple.provenance` = 同上。
    - 解法：已带票（`stapler validate` 通过）就**跳过 staple**，别再碰它；
      要装订就换干净副本（`xattr -dr com.apple.provenance,com.apple.macl`
      之后 staple），复制时用 `ditto --noextattr`。被冻结的原件改不了也删不掉，
      但**可以整目录改名**（rename 只需父目录写权限），移走后用 `rmSync` 清。
    - 连带：`ditto --sequesterRsrc` 打包会把 provenance 存进 zip，
      **解出来仍带标记** —— 「从 zip 解出就是干净的」是错的，解完必须清。
    - 验证签名用 `codesign --verify --deep --strict` 与 `verify-signature.mjs`
      （两者都不调 `spctl`），`spctl` 留到最后或留到另一份副本上跑。
    **同源教训**：见第 20、22 条 —— 「已装订 / 已公证」这类判据必须落在
    文件内容上（`stapler validate`），不能落在「跑过一次没报错」上；
    而**任何要写 bundle 的操作，动之前先确认 bundle 没被冻结**。

26. **闸门会自我印证：校验清单的那道闸门，抽出来的路由本身就是错的。**
    `apps/api/test/smoke.ts` 里有一道「能力清单与真实路由逐条比对」的闸门。
    它的路由抽取器按文件扫 `@Controller`，**一个文件只取第一个**。
    而 `plans.controller.ts` 里放了 **4 个** `@Controller` —— 后 3 个压根没进抽取结果。
    于是「真实路径 `/api/public/plans/:token`」被抽成了 `/api/plans/:token`，
    清单照抄这个错值，闸门比对「一致」→ **放行**。
    4 条幽灵路径（清单与实现不符）能长期存在，根因就在这里。
    - 修法：抽取器改为按 `@Controller` **逐个分块扫描**（`matchAll`），
      并纳入 `*.module.ts` 里内联的 controller。
    - **只改清单不改抽取器，门禁仍然是绿的假象** —— 这两件事必须同批做。
      改完清单跑一遍闸门看到「全绿」就以为修好了，而那道绿灯来自同一个 bug。
    - 通用教训：任何「用 X 校验 Y」的闸门，**X 的抽取逻辑本身就是被校验对象的一部分**。
      改了 Y 必须回头看 X 的抽取口径，否则闸门只是在证明「Y 和 X 一致」，
      而 X 本身可能是错的。
    - 同源教训：见第 24 条 —— 「只判断 `res.ok`、从不解析响应体」的调用
      是连通性探测，不是「拿到清单」；两者不能混为一谈。

27. **electron-builder 用 `got` 发请求，不读 macOS 系统代理。**
    它只认 `ELECTRON_PROXY` / `HTTPS_PROXY` / `HTTP_PROXY` **环境变量**，
    读不到「系统设置 → 网络 → 代理」里的配置。
    - 表现：`downloaded label=electron progress=100%`（electron 本身下载完了），
      紧接着 build 阶段报 `AggregateError / internalConnectMultiple`。
      看起来像「网络不通」，实际是**代理没传进子进程**。
    - 解法：打包命令必须自带 `ELECTRON_PROXY`/`HTTPS_PROXY`/`HTTP_PROXY`。
    - 判别：electron 都下完了，说明链路通、不是完全没网 —— 优先查代理传参，
      别急着怀疑网络或重试。
    - 同源教训：见第 15 条 —— 「走不走代理」在这台机器上是**每个工具各一套规则**
      （curl 读系统代理、`got` 只读环境变量、`stapler`/`notarytool` 各有端点约束），
      换工具就要重新核对，不能照抄上一次的结论。

28. **门禁的等待条件必须覆盖全部相关状态 —— 只等一半就是 flaky。**
    2026-10-26 实测：冒烟里「出图失败路径：作业 failed + error 非空，
    轮次同步 failed 且原因一致」这条断言，**本地连跑全绿，CI 上偶发红**（639/640）。
    - 根因：出图作业（`GenerationJob`）与出图轮次（`ImageTurn`）是**两次独立的落库**，
      而等待函数一看到作业落终态就返回 —— 那一刻轮次可能还没同步。
      本地快、CI 慢，差的就是这几十毫秒。**与功能无关，是断言自己的等待条件不全。**
    - 同一模式共三条断言（成功路径 / 幂等路径 / 失败路径），一起修：等**两侧**都落定再比对。
    - 同时给这几条断言补上**失败时的实际值**（`check` 的第三个参数 `detail`）：
      原来红了只看到「FAIL xxx」，分不清是作业没过还是轮次没同步。
      **断言失败时要能自解释** —— 否则一次 CI 失败只能靠猜。
    - 通用教训：**「上一轮 CI 是绿的」不等于这条断言可靠**，它可能只是上轮运气好。
      凡是「等 A 状态 → 读 B 状态」这种跨表断言，都要确认 B 也落定了。
    - 同源教训：见第 26 条 —— 校验器自身的口径就是被校验对象的一部分；
      等待条件是校验口径的一部分，缺一不可。

29. **长流程里的「只读探测」必须比「写操作」更耐操。**
    2026-10-26 实测：公证脚本崩在中途 —— dmg 上传断流后，脚本在轮询提交历史时
    撞上 `notarytool history` 的 TLS 错误（`-1200`，代理链路抖动），
    **直接抛异常终止**，把已经 Accepted 的票据成果留在半路，225MB 还得再传一遍。
    - 根因：**探测与操作用了同一条链路，却只有操作有容错**。
      `history` 与上传走同一个端点（`appstoreconnect.apple.com`）、同一条代理，
      一次**与公证内容无关**的抖动就能让整个流程中断。
    - 修法：读取历史重试 4 次，仍失败就**返回空**（当作「暂时查不到」），
      调用方走「还没成功」的分支 —— 最坏是多一轮，而不是整个任务死掉。
    - 通用判据：**探测失败本该只是「这次没问着」，不该是「整个任务死了」。**
      长流程脚本里每个只读探测点都要单独确认容错 ——
      本项目就有个漏网的（`notarytool log` 包了 try/catch，`history` 没包）。
    - 同源教训：见第 18 条 —— CI 上出问题时「让脚本自己说话」比「猜」快得多；
      而「让脚本自己说话」的前提是**它得能活到说话的时候**。

30. **「本地全绿」可能是一份过期日志 —— 门禁跑完之后又改了文件，绿是假的。**
    2026-10-26 实测：CI 门禁 job 红在「品牌与合规检查」，报文档里出现一个未登记域名。
    本地同一份代码跑 `pnpm check:brand` 却全绿 —— 因为本地门禁日志的时间是 16:32，
    而引入那个域名的文档提交在 17:32：**门禁跑完之后又改了文件**。
    - 根因：**「我跑过门禁」是事实，「门禁覆盖的是当前这份内容」是另一件事**，
      两件事被当成了一件。改完任何文件（哪怕只改一段文档）都要重跑受影响的门禁。
    - 判据落在数据上：**门禁日志的时间戳必须晚于最后一次内容改动的时间戳**。
      跑完门禁就立刻提交，别留「跑过但改过」的窗口；隔了很久再提交前，
      先看一眼日志时间（或直接重跑一遍）。
    - 反过来也成立：**CI 红了先在本地复现**。能立刻复现 → 不是环境差异，
      改完重跑门禁即可确认修好；复现不了 → 才往「CI 环境差异」方向查。
    - 修法还有一条纪律：**未登记域名一律改文档，不许加白名单** ——
      白名单只放公开服务（模型厂商 API / 包镜像 / 官方文档），
      第三方商业平台域名进白名单等于把「借鉴痕迹」合法化。
    - 同源教训：见第 26 条 —— 判据要落在**被校验的那一份内容**上，
      不是落在「跑过一次」这个动作上。

31. **「job 报成功，但事情根本没做」—— 静默跳过是最难发现的失败。**
    2026-10-26 实测：发布 Windows 产物的 CI job **四个全绿**，
    但 Release 上只有两个 mac 资产。日志里只有一句：
    ```
    Release v1.1.0 不存在，跳过
    ```
    同一个 Release 在本机 `gh release view v1.1.0` 查得到。
    - 根因：**`gh` 靠 git remote 推断仓库**（还要剥掉 checkout 写进去的凭据），
      在 CI 里这层推断失败 → `gh` 报「查不到」→ 脚本把「查不到」理解成「不存在」
      → **跳过并退出 0**。退出码是绿的，日志有正常输出，只有回头核对产物才发现没做。
    - 纪律一：**凡是「本该做某件事」的脚本，必须回显它到底做了什么**，
      不能只靠退出码。跳过的分支也要打印**为什么**跳。
    - 纪律二：**查不到的时候把原始响应打出来**，别 `2>&1` 吞掉 ——
      吞掉的错误让排查从「猜」变成「读」。
    - 纪律三：**CI 里别用靠推断的封装**。`gh release view` 会推断仓库，
      `curl https://api.github.com/repos/$GH_REPO/...` 不会 ——
      显式路径少一层猜，而且 `GH_REPO` 是 CI 自己注入的，天然可靠。
    - 同源教训：见第 18 条 —— CI 上出问题时「让脚本自己说话」比「猜」快得多；
      而「让脚本自己说话」的前提是**它得真的做了那件事**。
    - 配套：**上传走 `uploads.github.com` 的一步到位端点**
      （`POST .../assets?name=xxx` 直接传二进制，不必先建 asset 条目）。
      注意 `name` 是 **query 参数**，放 body 里会 404。

32. **「直连还是走代理」要按域名分别判断，别照抄上一次的结论。**
    2026-10-26 实测（同一台机器、同一个代理配置）：
    - **下载**走 `objects.githubusercontent.com`：直连 20MB 都传不完（超时），
      走代理只有 42~62 KB/s。600MB 产物取回来要 2.6 小时。
    - **上传**走 `uploads.github.com`：**直连 5.0 MB/s**（32MB 实测 6.7 秒），
      走代理反而只有几十 KB/s 且频繁断流。
    - 根因：**这是两条不同的 CDN 链路**，不能用「下载要挂代理」推出「上传也要挂」。
    - 通用判据：**先量链路，再决定挂不挂**。测法要小步快验：
      用一个几 MB 的文件直传一次，看 `speed_upload`，别拿 600MB 去试。
    - 配套推论：**能由 CI 产出的产物就别在本机取回再传** ——
      CI runner 在 GitHub 内网，直传是秒级。mac 产物因为签名与公证只能用本机证书做，
      仍留在本机上传（直连，472MB 用了 1 分 54 秒）。
    - 同源教训：见第 15 条 —— 这台机器上**每个工具各有一套规则**，
      换域名、换工具都要重新核对。

33. **并发提交会双扣额度：幂等必须「抢占」，不能「先查后插」。**
    出图/生视频原本靠 `clientRequestId` 去业务表查「有没有已有产物」，
    查到了就返回、查不到就出图。**并发下两个请求会同时查到空** ——
    然后双双扣额度、双双打上游，用户只拿到一张图却被扣了两次。
    金额按 `IMAGE_TOKENS=300` / `VIDEO_TOKENS=1500` 计，这是**钱的问题，不是体验问题**。
    - 修法：改用 `IdempotencyService.claim()` **抢占** ——
      靠 `(tenantId, key)` 唯一约束原子判定「谁能真跑」，抢不到的直接去重或回 409。
      位置很讲究：**所有校验之后、扣额度之前**（校验失败不该占住幂等键，
      用户改对了参数还得能重来）。
    - 释放规则：**扣额度失败要释放**（钱没扣出去，允许重来）；
      **扣额度之后的失败不释放**（钱已经花了，重试不能再扣一次），
      要重来必须换一个提交键。
    - 顺带修掉：生视频原本是**先扣额度再查 API Key**，Key 没配也照扣。
      现在校验全部前移到扣费之前（与生图口径一致）。
    - 断言写法：**判据落在可数的量上** ——
      假上游 `/prompt` 被打了几次（只打一次上游）、
      租户额度少了多少（只扣一次额度）。
      「一次出图的成本」先单发一次量出来再比，别把 `BILLING_IMAGE_TOKENS` 写死在断言里
      （部署方可以改这个环境变量）。

34. **「已扣额度」的补跑必须有次数上限，否则就是白烧上游的口子。**
    画布作业状态 `unknown` = 额度已扣但没拿到结果。此时补跑**不再扣用户额度**
    （用户已经付过这一笔），但上游 API 是实打实的成本 ——
    不设上限，「反复点补跑」就成了一条平台白烧额度的路。
    - 修法：用同一张幂等表做**一次性抢占**（键 `canvas-free-rerun:<jobId>`），
      抢不到就明确回 `FREE_RERUN_ALREADY_USED` 并说明「要再出图请重新发起（会重新计费）」。
    - 配套：免费补跑要**换一个提交幂等键**（`canvas-job:<id>:rerun`）——
      上一把键的幂等记录还占着（那笔钱已经花掉了，不能让它再跑一次）；
      **免扣靠 `alreadyCharged` 标志，不靠换键**。

35. **CSS Grid 的 `gap` 只管同一个网格内部，跨网格的间距要靠 `margin`。**
    首页「快捷卡」和「板块卡」是**两个并列的 grid**，
    各自内部 `gap: 14px` 都正常，但两个 grid **之间**的间距是 0 ——
    底部那排卡片直接贴上顶部那排，看起来「挤在一起」。
    - 判据要**量**，别看：`getBoundingClientRect()` 取两个 grid 的
      `bottom` 与 `top`，`gapBetweenGrids = 下一个.top − 上一个.bottom`。
      本例实测 765 − 765 = **0**，一眼看不出来的是「两个 grid 各自内部 gap 正常」。
    - 修法：给上面的 grid 容器加 `marginBottom`（与另一个 grid 的 margin 节奏对齐），
      并在注释里写明「gap 管网格内、margin 管网格间」。

36. **迁移文件被写坏过：本地库里可能躺着一条 failed 迁移记录。**
    `20261013102000_image_canvas` 当初的 SQL 写成了
    `CREATE TABLE "ImageTurn_conversationId_fkey" FOREIGN KEY ...`（语法错误），
    后来把文件改对了，但**库里的 failed 记录没清**。
    - 判据：**不要只看 `finished_at IS NULL`**（那只是「有残留」）。
      要看**结构对不对**：`pg_dump --schema-only` 本地库与
      「空库跑完全部迁移」的库逐行 diff —— 本轮实测**零差异**，
      说明结构是全的，failed 记录只是历史残留。
    - 另一步：拿**空库**跑一遍 `prisma migrate deploy`，确认**全新部署一次跑通**。
      本轮实测 40 条迁移在空库上全部成功 —— 这才是「新用户部署会不会炸」的答案。

37. **页序映射不能靠「几段数组快照的下标拼起来」。**
    方案视图页由「真实页 + 虚拟页（户型/点位/报价）」拼成，
    视图下标 → 真实页下标的映射（`virtualAt`）原先是把
    「户型插入位置」「点位插入位置」「报价插入位置」三段快照的下标**拼起来再排序**。
    三段快照各自是在**不同中间状态**下算出来的，拼起来的下标会整体错位 ——
    实测 14332 种枚举里有 204 种点卡片会改到**相邻的真实页**
    （点「预算规划」改的是封面）。
    - 修法：映射改成**由最终页序的页型重算**（遍历最终视图，
      数到第几个真实页就是它在 `plan.pages` 里的下标）。
      改后 8192 与 62784 两个枚举空间**错映射均为 0**。
    - 教训：**映射关系要能从「最终结果」推出来，不能从「中间步骤的快照」拼**。
      这类下标映射没有自检就一定会错，而错了不报错、只是改错东西。
    - 断言写法：**穷举枚举**（所有页型子集 × 有无户型图 × 模版 × 点位数 × 报价品类数），
      判据是「算出的下标是否等于真值」，并同时跑改前公式做对照 ——
      对照数字（138 → 0）比「改完了看起来对」有说服力得多。

### CI（GitHub Actions）

`.github/workflows/ci.yml`，四个 job：

- **gate**：`pgvector/pgvector:pg18` 服务 → `prisma generate` → `migrate deploy` → 灌种子
  → typecheck → build → smoke
- **desktop**：`ELECTRON_SKIP_BINARY_DOWNLOAD=1` → 只跑 tsc
- **desktop-windows**：`windows-latest` → 装依赖 → 探活引擎源 → generate → 编译
  → 裁运行时 → **运行时自证** → `electron-builder --win` → 产物名 ASCII 校验 → 上传
- **release-windows**：取回上一 job 的产物 → 推送到 Release（版本号取自仓库变量
  `vars.RELEASE_TAG`，同名资产已存在则跳过）

四条要注意的：

- Windows job 的第 11–13 步（打包 / 校名 / 上传）都带 `if: always()`：
  **运行时自证失败时也要把包装出来**。job 该红还是红（门禁语义不变），
  但产物留着才能当场比对「装不上」到底卡在哪 —— 没产物就只剩一条红叉，
  连问题长什么样都看不见。
- 数据库服务**必须用 pgvector 镜像**：历史迁移里有 `CREATE EXTENSION vector`，
  普通 postgres 镜像会失败。
- CI 环境变量用 `NODE_ENV=production`：用 development 跑等于把
  「生产环境拒绝弱默认密钥/密码」这道红线绕过去了，等于没测。

本地验证 CI 时要用**完全相同的命令序列**实跑一遍，不要「照着配置想当然」。

但**「完全相同的命令」不等于「完全相同的平台」** —— mac 上跑通的 `verify:runtime`
不代表 Windows 上也跑得通（内嵌 PG 的启动方式、路径分隔符、Prisma CLI 的行为
都随平台变）。跨平台的 CI 步骤只能在真平台上验，
本地跑通只能证明「脚本逻辑没坏」，证不了「那个平台上不会挂」。
所以这类脚本必须**自带超时与步骤日志**：让失败在几分钟内变成一句可读的话，
而不是让整个 job 沉默地耗满预算、最后连日志都拿不到。

### 体积统计口径

运行时体积按 **inode 去重**统计（与 `du` 一致）。pnpm 的隔离布局里
`node_modules/<pkg>` 是指向 `.pnpm/<pkg>@<ver>/node_modules/<pkg>` 的软链：
按软链跳过会少算，按软链累加会重复算，只有按 inode 去重才对。

## 新增依赖

必须检查许可证（MIT / Apache-2.0 / BSD 优先；GPL / AGPL 禁止）与已知漏洞。
