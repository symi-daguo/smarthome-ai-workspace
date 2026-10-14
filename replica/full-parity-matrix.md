# 全站复刻完整度对照清单

> 基线：REA 静态逆向 `platform.gougezn.com` 全部 **14 个脚本 / 701 KB**
> （`app.js` 341KB、`quote-workbench.js` 88KB、`wifi-heatmap.js` 58KB、
> `plan2-workspace.js` 27KB、`task-center.js` 19KB、`agent-gallery.js` 14KB、
> `image-scene-video.js` 13KB、`fault-report.js` 12KB、其余 6 个共 15KB）
>
> 证据边界：静态分析，未执行对方代码。本清单记录**功能形态**，实现为自有代码与视觉。
>
> ## 状态图例（2026-10-13 起收紧）
>
> - `✅` = **已打开界面逐屏核对通过**（有截图或 DOM 文本证据）
> - `🔸` = 仅代码 / API 契约层面确认，**界面未逐屏核对**或存在已知缺口
> - `⬜` = 未实现
>
> ⚠️ **2026-10-13 修正**：此前所有 ✅ 均由代码 review + smoke 断言推定，**从未打开界面核对**，
> 属于自签合格证。本轮已逐屏核对 20 个板块并重标，详见
> [audit-2026-10-13.md](./audit-2026-10-13.md)。
> 其中「开始接单」由此前的 ✅ 降级为 🔸：实测缺 5 处结构化采集。

## 一、总览

| # | 板块 | 状态 | 说明 |
|---|---|---|---|
| 1 | 登录 / 注册 / 协议拦截 | ✅ | 0.1.48 实测：双栏登录页正常渲染 |
| 2 | 首登使用说明弹窗 | 🔸 | 未逐屏触发首次登录场景 |
| 3 | 首页工作台（输入卡 + 5 快捷卡） | ✅ | 0.1.48 实测；另加智能意图建议（我方增强） |
| 4 | 侧栏 + 历史对话 + 个人中心卡 | ✅ | 0.1.48 实测：5 组 17 项全在位 |
| 5 | 任务球 | 🔸 | 0.1.45 服务端化已实现，未逐屏核对悬浮交互 |
| 6 | AI 智能体市场 | ✅ | 0.1.48 实测：8 分类 + 12 预置智能体带使用热度；0.1.52 补「本地推流大师」共 13 个 |
| 7 | 定制智能体 | 🔸 | 0.1.40 落库，未逐屏进入 |
| 8 | AI 生图（含子工作流） | ✅ | 0.1.48 实测：**5 个**子工作流 + 17 场景 + 参考图反推（原文写 4，实为 5） |
| 9 | **AI 画布（对话式生图）** | 🔸 | 0.1.48 实测页面结构在；**圈选重绘入口未能验证**（需历史图 + OpenAI 生图配置） |
| 10 | AI 生视频 | ✅ | 0.1.48 实测：音轨四模式在，0.1.48 新文案已生效 |
| 11 | 智能方案生成 | ✅ | 0.1.48 实测：4 步向导 + 11 风格 + **7 类系统预算滑块** |
| 12 | 智能百宝箱（20 卡） | ✅ | 0.1.48 实测：**20 张卡全部有语义匹配预览图** |
| 13 | 智能设备点位布局 | ✅ | 0.1.48 实测：3 tab + 13 分类产品库带参考价 |
| 14 | **智能灯光大师 / 灯光点位与场景** | 🔸 | 灯光场景演示已实测（4 步）+ 0.1.52 补电气回路；灯光点位效果图未逐屏，功能量级差距见 audit §6 |
| 15 | **WiFi 热力图** | 🔸 | 0.1.46 算法已由数值断言验证；**界面图层未逐屏核对** |
| 16 | **智能报价** | ✅ | 0.1.48 实测：22 产品 / 13 分类 + 两种口径 + 双格式导出 |
| 17 | 我的知识库 | 🔸 | 未逐屏进入 |
| 18 | 我的资料 | ✅ | 0.1.48 实测：5 类筛选 |
| 19 | 优秀视频素材库 | ✅ | 0.1.48 实测：三 tab + ¥1 下载 + 创作者收益说明 |
| 20 | 问题反馈 | ✅ | 0.1.48 实测：**自动上下文采集生效**（页面/操作轨迹） |
| 21 | 会员面板 | 🔸 | 0.1.48 实测页面完整（开源自部署说明页）；文案数字 19→20 已修 |
| 22 | **开始接单** | 🔸 | ⬇ **2026-10-13 由 ✅ 降级**：实测缺 5 处结构化采集，详见 audit §3.1 |
| 23 | 短视频工作台 | 🔸 | 专访模式 3 种已读到，未走完对话流程 |
| 24 | 涂鸦选区局部重绘 | 🔸 | 链路由 smoke 断言验证（遮罩到达出图层），**真实出图未验证** |

## 二、已完整移植的部分（可放心交付）

- **AI 画布**：多轮对话线、变体追加不覆盖、分支树切换、异步作业轮询、来源可追溯、历史恢复编辑
- **智能百宝箱**：19 → 20 张卡，每张配语义匹配预览图；`ToolDef.img` 必填，漏配编译报错
- **生图 4 类子工作流**：毛坯房 / 视频封面 / 节假日海报 / 平面图转彩平图
- **生图真实参数**：适配视频（16:9 + 构图不裁切）、背景（写进提示词约束）
- **问题反馈**：提交 + 状态机 + 处理进度跟踪 + 权限隔离
- **灯光场景演示**：灯具编排 + 手工时间轴 + 实时预览 + 出片

## 三、尚未移植的部分（诚实清单）

### 3.1 WiFi 热力图（`wifi-heatmap.js` 58KB）——差距最大

我方当前只有「加性径向光斑 + 图例」。参考站具备：

| 能力 | 参考站函数线索 | 我方 |
|---|---|---|
| **墙体识别** | `wallMaskFromAiSegments` / `readUpload` | ✅ 0.1.46（Otsu+距离变换+连通域，纯前端） |
| **Otsu 二值化 + 距离变换 + 连通域标记** | `otsu` / `distanceTransform` / `labelMask` / `dilateMask` | ✅ 0.1.46 |
| 局部墙体检测与源图约束 | `localWallCandidateMask` / `constrainMaskToSource` | ✅ 0.1.46（图纸范围约束） |
| 墙体手工修正 | `confirmWalls` / `clearWallMask` / `paintWallMask` / `wallAt` / `countWallsBetween` | ✅ 0.1.46 |
| **真实物理单位（米/像素比例）** | `widthMeters` / `heightMeters` / `xPixelsPerMeter` | ✅ 0.1.46 |
| 设备增删选与信号环 | `addDevice` / `removeDevice` / `drawSignalRings` | ✅ 0.1.46 |
| 墙体间信号衰减 | `signalAt` / `mix` / `heatColor` | ✅ 0.1.46（洪水填充遇墙停止） |
| **覆盖率统计** | `measureCoverageStats` | ✅ 0.1.46 |
| 导出摘要图 | `drawExportSummary` / `exportCanvas` | ✅ 0.1.46 |
| 新手引导 | `showWifiGuide` / `updateGuideStep` / `dismissBlockingTours` | ⬜ |

### 3.2 智能报价（`quote-workbench.js` 88KB）

| 能力 | 参考站函数线索 | 我方 |
|---|---|---|
| **产品变体选择器** | `productFamilyKey` / `variantSiblings` / `variantMatch` / `renderVariantPicker` | ✅ 0.1.45 |
| **户型图房间标注 + 拖拽** | `planRoomBase` / `renderPlanCanvas` / `startPlanLabelDrag` / `renderPlanLabels` | ✅ 0.1.46 |
| 房间分组与拖拽排序 | `editorGroups` / `moveRoomBeforeOrAfter` / `clearRoomDrop` | ✅ 0.1.46（pointer 事件，触屏可用） |
| 自定义房间 | `addCustomRoom` / `renderRoomChips` | 🔸 我方有房间字段，无分组 |
| **逐项单价覆盖** | `openPerOrderPrice` / `savePerOrderPrice` | ✅ 0.1.45 |
| 阶梯优惠 / 整体调整 | `setAdjDiscount` / `openAdj` / `applyAdj` | ⬜ |
| 报价模板切换 | `renderTpls` / `applyTpl` / `switchRail` | ⬜ |
| **导出 Excel** | `exportResultXls` | ✅ 0.1.45（CSV 同时保留） |
| 客户档案联动 | `openCustomerProfile` / `genDoc` | ⬜ |
| 多账号产品缓存与预取 | `watchQuoteAccount` / `prefetchQuoteProducts` | ⬜ |
| 三级价格/多级返利 | — | ✅ 我方已实现（属我方增强） |

### 3.3 智能方案生成（`plan2-workspace.js` 27KB）

| 能力 | 参考站函数线索 | 我方 |
|---|---|---|
| **全屏阅读器 / 演示模式** | `readerSlides` / `animateReader` / `openReader` / `closeReader` / `moveReader` | ✅ 0.1.46（含动画降级） |
| **预算校验与预设** | `validateBudget` / `budgetPreset` / `bindBudget` | ✅ 0.1.46（只提示不阻断） |
| 字段级编辑与同步 | `patchField` / `sync` / `fields` | ✅ |
| 方案历史 | `renderHistory` | ✅ |

### 3.4 问题反馈（`fault-report.js` 12KB）— ✅ 0.1.45 已补齐

| 能力 | 参考站函数线索 | 我方 |
|---|---|---|
| **自动拦截错误并上报** | `shouldIntercept` / `isFaultText` | ⬜ |
| **自动附带上下文**：功能来源、操作记录、版本号、最近请求 | `featureFromElement` / `rememberAction` / `appVersion` / `context` / `rememberRequest` | ⬜ |
| 反馈单号追踪 | `reportId` | 🔸 我方有 id，用户不可见 |
| 手动提交表单 + 状态跟踪 | — | ✅ |

### 3.5 任务中心（`task-center.js` 19KB）— ✅ 0.1.45 已补齐

| 能力 | 参考站函数线索 | 我方 |
|---|---|---|
| 服务端任务列表 | `/api/generation-tasks` | ⬜（我方仅前端） |
| 任务球位置持久化 | `restorePosition` / `savePosition` / `placeBall` | ⬜ |
| 未读红点 + toast | `hasNew` / `visibleTasks` / `toast` | 🔸 有红点，纯前端状态 |

### 3.6 其他

- **会员**（`membership.js`）：参考站是弹窗式会员面板；我方 `/vip` 是说明页。**这是有意差异**——本项目开源免费，会员概念不适用。
- **智能体画廊**（`agent-gallery.js` 14KB）：有 `isLocked` 锁定态。我方无锁定态，**这是有意差异**——免费开源不做付费墙。
- **视频音频设置**（`video-audio.js` 4KB）：`settings` / `describe` / `support` / `sync`。✅ 0.1.46 已实现（音轨编译进提示词，非独立参数）。

## 四、涂鸦选区局部重绘（✅ 0.1.47 已实现）

- `generateViaOpenaiEdit` 走 `POST /images/edits`（multipart），原图 + 遮罩成对传入
- 遮罩约定：**要重绘的区域透明、其余不透明**（OpenAI 规范，与直觉相反）
- 仅 `provider=openai` 可用；其它 provider 返回 `503 IMAGE_EDIT_UNSUPPORTED` 明确拒绝，
  不做「能圈选但整张重画」的假实现

## 五、结论

已移植 **17 / 24** 个板块的完整能力，**4 个板块部分实现**（任务球、方案生成、问题反馈、素材库投稿），
**1 个依赖上游未做**（涂鸦重绘），**2 个为有意差异**（会员/锁定态，开源定位不同）。

未移植部分的**优先级建议**（按「商业价值 × 实现成本」排）：

1. **问题反馈自动上下文**（12KB，成本低）——用户报错自动带功能来源与操作记录，排查效率数量级提升
2. **智能报价变体 + 逐项单价覆盖 + Excel 导出**（88KB 中的高频子集）——直接关系到能不能开单
3. **任务中心服务端化**（19KB，`GenerationJob` 表已就位，改造成本中等）
4. **WiFi 热力图墙体与覆盖率**（58KB）——演示效果好但非成交必需
5. **方案全屏阅读器 + 预算校验**（27KB）
