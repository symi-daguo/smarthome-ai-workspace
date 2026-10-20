# Agent 接入指南

面向任何能发 HTTP 请求的外部 AI Agent（豆包、Trae、MiniMax、Claude Code、WorkBuddy、自研脚本……）。
本文只讲**怎么把本系统接进来并安全地用起来**；具体有哪些能力由
`GET /api/agent/manifest` 自描述，接入方不必照抄本文。

---

## 1. 三种接入方式

| 方式 | 端点 | 适合 |
|---|---|---|
| **能力清单**（推荐起点） | `GET /api/agent/manifest` | 所有平台。返回 138 条操作、权限、风险等级与用法说明 |
| **OpenAPI** | `GET /api/docs`（页面）<br>`GET /api/docs-json`（机器可读） | 需要自动生成客户端 / 补全 / 调试台 |
| **REST** | `http://<host>:3080/api/*` | 一切。API Key 即 Bearer token |

三者信息同源：清单里的每条操作都带 `p`（路径）、`risk`（风险）、`q`（注意事项）、
`d`（一句话说明），且与代码里的真实路由**由 smoke 双向校验**（漏声明和虚构路由都会让门禁失败）。

---

## 2. 认证

```
所有 /api/*（除 /api/auth/* 与 /api/public/*）都需要 Authorization: Bearer <token>
```

API Key **本身就是一枚 JWT**，不需要再换 token。

拿 Key 的流程：

1. 用管理员账号登录 `POST /api/auth/login {phone, password}`
2. 建一个服务账号：`POST /api/team/service-accounts {name, roleKey}`
3. 签发 Key：`POST /api/agent/api-keys {name, serviceAccountId, expiresInDays}`
4. 之后所有请求带 `Authorization: Bearer <key>`

**不要用真人账号的 token 跑自动化**——审计日志会把操作记到那个人头上，且权限是全的。

### 跨租户

默认用 Key 里的首个成员身份。跨租户时加 `X-Tenant-Id: <tenantId>`。

---

## 3. 权限模型

- 20 个 permission action，**读与写分离**（`content:read` / `content:generate`…）
- 清单支持 `?effective=1`：**按调用者权限过滤**，只返回这把 Key 真的能调的操作。
  - 只读 Key 拿到的清单里不会出现"删除产品"，Agent 不会照着错的能力反复撞 403
- 任务中心、团队等高危域对普通成员隐藏，与角色模板承诺一致

---

## 4. 会扣额度的接口：必须带 `clientRequestId`

**这是最容易踩的坑，务必读。**

以下三个接口**先扣额度再干活**：

| 接口 | 扣什么 |
|---|---|
| `POST /api/media/images` | 生图 / 局部重绘 |
| `POST /api/media/videos` | 生视频（单价最高） |
| `POST /api/plans` | 方案生成（按页数计，9~16 页） |

规则：

- 请求体带 `clientRequestId`（≤64 字符，任意字符串，建议 UUID）
- **同一个键重放 → 直接返回首次产物，带 `deduped: true`，不重复出图也不重复扣费**
- 生成中**结果未知**（超时 / 网络中断）时，**复用同一个键重试**
- 确认成功后**换新键**，表示这是一次新的生成意图

```bash
RID=$(uuidgen)
curl -X POST "$API/api/media/images" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"客厅灯光效果\",\"clientRequestId\":\"$RID\"}"
# 网络断了就用同一个 $RID 再发一次 —— 不会二次扣费
```

不带这个键也能调，但**弱网重试或用户重复点击会二次扣费**，这是客诉退款的高发原因。

> 注意与 `X-Request-Id` 区分：那是给**审计日志**串联用的，和防重复扣费是两件事。

---

## 5. 动数据前先打快照

```
POST /api/agent/snapshots {label}          → 拿 snapshotId
…执行操作，带 X-Snapshot-Id: <id>…
出问题：POST /api/agent/snapshots/{id}/restore {confirm:"<id 前 8 位>"}
```

清单里 `risk=destructive` 的操作若未带 `X-Snapshot-Id`，系统会**自动打一份快照**并放行，
事后去 `/api/agent/snapshots` 能找到。

**撤不回的**：已花掉的模型调用费、已生成的图片/视频、已发出的通知。快照只还原数据库行。

---

## 6. 错误处理

错误体统一为 `{ statusCode, message, error }`。
**`message` 是稳定的英文错误码**（如 `PLAN_NOT_FOUND`、`IMAGE_KEY_MISSING`），
请据此分支，不要去匹配中文文案——文案会改，码不会。

常见：

| 码 | 含义 | 该做什么 |
|---|---|---|
| 401 | Key 失效 / 过期 | 重新签发，**不要重试刷屏** |
| 403 | 权限不足 | 调 `?effective=1` 看这把 Key 到底能调什么 |
| 429 | 触发限流 | 退避重试，别并发打 |
| 503 + `IMAGE_EDIT_UNSUPPORTED` | 当前出图通道不支持遮罩重绘 | 切 OpenAI 兼容通道，或改用整图重绘 |
| 503 + `LLM_KEY_MISSING` | 模型 Key 未配 | 去「模型配置」页填 |

---

## 7. 各平台接入要点

平台差异只在"怎么写 HTTP 请求"，认证与幂等完全一致。

- **Trae / Claude Code / Cursor**：直接用 REST + 能力清单；也可把 `?index=1` 的 JSON
  存成 skill 文档，让模型按清单自选工具
- **豆包 / MiniMax 等带 MCP 的平台**：本项目目前提供 REST 与 OpenAPI；
  若平台强制要 MCP，可用一个薄 MCP server 包一层
  （清单已经自描述，映射是机械工作，不涉及业务逻辑）
- **自研脚本 / 定时任务**：务必用**服务账号 + API Key**，并遵守第 4 节的幂等约定

---

## 8. 自我校验

接入完成后跑一遍这三件事，就能确认是通的：

```bash
# 1) 认证 + 拿到清单（应看到 18 组、138 条）
curl -s "$API/api/agent/manifest?index=1" -H "Authorization: Bearer $KEY"

# 2) 权限感知（换一把只读 Key 再跑，结果应明显变少）
curl -s "$API/api/agent/manifest?effective=1" -H "Authorization: Bearer $KEY"

# 3) 幂等（同一个键发两次，第二次 deduped 应为 true，且只扣一次额度）
#    见第 4 节
```

本项目自身的 smoke 每次都会校验：能力清单与真实路由**双向零漂移**、
每条操作的声明权限与代码里的 `@RequirePermissions` 逐条一致。
**新增接口而忘了更新清单，门禁会直接失败**——所以能力清单不会悄悄过期。
