# AI 画布（对话式生图）功能规格

> 来源：REA 静态逆向 `platform.gougezn.com` 的 `ai-canvas.js`（71,784 字节）。
> 证据边界：静态分析，未执行对方代码。本文档记录的是**交互形态与数据契约**，
> 实现为自有代码与自有视觉，不复制对方代码/文案/素材/商标。

## 1. 它解决什么问题

传统生图页是「一次一张」的表单：填提示词 → 生成 → 看结果 → 不满意再改。
AI 画布是**对话式多轮创作**：像聊天一样连续迭代，每一步都能回溯、换分支、重来。

## 2. 核心概念

| 概念 | 含义 | 逆向到的字段 |
|---|---|---|
| **对话线 conversation** | 一条独立的创作线，以根记录 ID 归组 | `rootId` / `activeRootId` |
| **轮次 record** | 一次「用户输入 + 生成结果」 | `id` / `parentId` / `createdAt` / `prompt` / `url` |
| **变体 variant** | 同一轮内的多个候选图，重新生成会追加而非覆盖 | `variants[]`（`url`/`index`/`label`） |
| **分支 branch** | 同一张图作为基底可派生出多条后续线，形成树 | `sourceImageId` + `childrenById` |
| **基底 base** | 当前这一轮是基于哪张图继续的 | `selectConversation(rootId, baseId, variantIndex)` |
| **参考附件** | 用户上传的参考图，逐轮记录 | `attachmentsByRecordId` |
| **选区 selection** | 在大图上涂鸦圈定的局部区域 | `selection` / `selectionDraftStrokes` / `mask` |

## 3. 关键机制

### 3.1 变体：重新生成是追加，不是覆盖

`recordVariants(record)` 归一化时：
- 兼容三种来源——纯字符串、含 `url` / `imageUrl` / `outputUrl` 的对象
- **按 url 去重**（同一张图不重复计数）
- 主图 `record.url` 会被 `unshift` 进变体列表
- 显式 `index` 优先；没有显式 index 时按顺序补号并避开已占用编号

→ 逆向结论：**用户点「重新生成」不会丢掉上一张**，历史变体可回看。

### 3.2 分支：基于某张图继续

- 每条 record 记 `sourceImageId`（它是从哪张图派生的）
- `childrenById: Map<父图id, 子record[]>` 构成分支树
- 同一张图有 ≥2 个子分支时，`appendBranchNavigator` 在轮次上渲染
  `‹ 分支 N / M ›` 导航条，点击 `switchBranch(parentId, currentChildId, ±1)` 循环切换
- `latestDescendant(record)`：沿当前选定分支一路走到叶子，切换后自动跳到该分支末端
- `branchChoiceByParent: Map<父id, 选中分支id>` 记住每个父节点当前选哪条

→ 逆向结论：**分支是树不是线**，切换分支要能看到整条后续链路，而不只是下一张。

### 3.3 异步作业 + 轮询

生成**不是同步等待**：
- 提交 → 拿任务 ID → `state.pendingTurn` 占位
- 轮询 `state.pollToken` 指向的任务
- 结果回来用 `mergeRecord(record)` 合并进 history（按 id 覆盖，否则追加），再 `rebuildHistoryMaps()`

→ 与我方现状差异：我方 `POST /api/media/images` 是**同步阻塞返回**。
   多轮画布下同步会长时间占用连接，异步作业制更合适。

### 3.4 轮次元信息与「基于此图」

- `createTurnMeta(record)`：渲染「质量 · 时间」元信息行
- `renderSourceTurn` / `renderBasisNote`：显式告诉用户这一轮是基于哪张图继续的
- `restoreTurnToComposer(record)`：把历史某一轮的提示词恢复到输入框继续改

→ 逆向结论：**来源可追溯**是这类工具的核心信任机制。

### 3.5 涂鸦选区（局部重绘）

- 灯箱大图上自由涂鸦（`paintStrokes` / `pointInPolygon` / `buildPath`）
- `buildSelectionAssets()` 产出两张图：
  - `mask`：白色笔迹的 PNG 遮罩（白=选中区）
  - `preview`：原图 + 彩色笔迹叠加（给用户看圈对没）
- `sizeSelectionCanvas` / `updateMobileViewport` 处理移动端画布尺寸

→ 依赖上游支持 mask/inpaint。我方 `/api/media/images` 不接受 mask，
   **本轮先不做涂鸦选区**，避免做出一个只能预览、不能真正局部重绘的假功能。

### 3.6 生成参数带价格

`selectedAspectRatio` / `selectedModel` / `selectedQuality` / `selectedPriceCents` / `formatPrice`
→ 选择质量档时**同时显示该档价格**。这一点值得抄：生成前就知道要花多少。

## 4. 状态机（逆向到的 25 个状态字段）

| 分组 | 字段 |
|---|---|
| 对话线 | `activeRootId` `activePath` `currentRecord` `currentVariantIndex` `history` `historyById` `draftRootId` |
| 分支 | `childrenById` `branchChoiceByParent` `activePath` |
| 附件 | `attachmentsByRecordId` `references` `referencesLoading` `referenceToken` |
| 选区 | `selection` `selectionDraftStrokes` `drawing` |
| 任务 | `pendingTurn` `pollToken` `busy` `suspended` `historyToken` |
| UI | `historyOpen` `lightbox` `autoScrollUntil` `documents` `transientByRoot` |

`historyToken` / `referenceToken` / `pollToken` 三个令牌的作用相同：**让过期响应作废**
（切换会话后旧请求返回不能污染新会话）。

## 5. 我方实现范围（0.1.44）

| 机制 | 本轮 | 说明 |
|---|---|---|
| 多轮对话线 | ✅ | 落库，跨会话保留 |
| 变体（追加不覆盖） | ✅ | 重新生成追加变体，可回看 |
| 分支树 + 分支切换 | ✅ | 基于任一历史图继续，‹ N/M › 导航 |
| 参考图附件 | ✅ | 逐轮记录 |
| 异步作业 + 轮询 | ✅ | 新增 generation job 表 + 轮询端点 |
| 质量档带价格展示 | ✅ | 复用 token 计费口径 |
| 来源可追溯（「基于此图」） | ✅ | 轮次显示基底缩略图 |
| 历史恢复编辑 | ✅ | 一键把某轮提示词拉回输入框 |
| 涂鸦选区局部重绘 | ⏸ 下一轮 | 需上游支持 mask，本轮不做假功能 |

## 6. 我方与参考站的差异（有意为之）

1. **不做「发送即跳转」**：工作台意图识别已给可点建议，画布内不做强制路由。
2. **不复制对方视觉**：沿用我方靛蓝视觉体系与自有图标。
3. **质量档价格显式展示**：抄的是「生成前告知成本」这个好设计，不是它的具体价格数字。
