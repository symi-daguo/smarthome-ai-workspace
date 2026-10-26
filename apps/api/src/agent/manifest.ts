/**
 * Agent 能力清单（0.1.53）
 *
 * 为什么要有它：Agent 要摸清「这个系统能干什么」，最省钱的办法不是读源码（几十万 token），
 * 而是先读一份结构化的清单。设计目标是**按需取**：
 *   GET /api/agent/manifest            → 索引（分组 + 危险操作清单），实测约 2.8 KB
 *   GET /api/agent/manifest?group=quote → 只取报价这一组的详细操作，实测约 3.8 KB
 *   GET /api/agent/manifest?effective=1 → 按调用者权限过滤，实测约 24 KB
 * 全量取（?full=1，实测约 28 KB）只在需要通盘了解时用。
 *
 * 操作条数与分组数不写在这里 —— 那是会漂的重复数字。
 * 唯一来源是 README 与《Agent接入指南》，由 apps/api/test/smoke.ts 的
 * 「README 数字与实现对账」断言逐个校验，漂了门禁会 FAIL。
 *
 * 漂移防护：apps/api/test/smoke.ts 会用真实路由表逐条比对，
 * 新增接口忘了写进清单 → 门禁 FAIL。清单漏项不会被静默放过。
 *
 * risk 含义：
 *   write       会改数据
 *   destructive 会删数据或不可逆。调用前应先打快照（见 notes.snapshotProtocol）
 */

/** 跨接口通用约定，写一次、在每组开头重复引用，避免 Agent 逐条重读 */
export const COMMON_NOTES = {
  auth: '所有 /api/*（除 /api/auth/* 与 /api/public/*）都需要 `Authorization: Bearer <token>`。Agent 用 API Key 即可，它本身就是一枚 JWT。',
  tenant: '多租户：默认用 token 里的首个成员身份；跨租户时带 `X-Tenant-Id: <tenantId>`。',
  errors: '错误体 `{ statusCode, message, error }`。message 是稳定的英文错误码，可据此分支，不要匹配中文文案。',
  idempotency: '写操作建议带 `X-Request-Id`，审计日志按它串联成一次动作，便于回溯。',
  // 防重复扣费与审计串联是两件事：前者防「用户/agent 重试导致重复出图重复扣额度」，
  // 后者只是把日志串起来。不写清楚的话，agent 重试会静默多扣一次额度。
  chargeIdempotency: [
    '**会扣额度的生成接口，务必带 `clientRequestId`（请求体字段，≤64 字符）**：',
    '  `POST /api/media/images`（生图/局部重绘）、`POST /api/media/videos`（生视频）、`POST /api/plans`（方案生成）。',
    '同一个键重放会直接返回首次产物并带 `deduped: true`，**不重复出图、不重复扣额度**。',
    '生成时请用随机 id（如 UUID）并在**结果未知（超时/网络中断）时复用同一个键重试**；',
    '确认成功后换一个新键，表示这是一次新的生成意图。',
    '不带这个键的调用仍可用，但弱网重试或重复提交会二次扣费。',
  ].join('\n'),
  snapshotProtocol: [
    '动数据前：`POST /api/agent/snapshots {label}` 拿 id（label 写清楚这一步要干什么）。',
    '破坏性操作（risk=destructive）若未带 `X-Snapshot-Id`，系统会自动打一份 auto 快照，仍会放行但请去 /api/agent/snapshots 确认。',
    '出问题：`POST /api/agent/snapshots/{id}/restore {confirm:"<id前8位>"}` 还原到操作前。',
    '撤不回：已花掉的模型调用费、已生成的图片/视频、已发出的通知。',
  ].join('\n'),
} as const;

export type Risk = 'read' | 'write' | 'destructive';

/**
 * 每个能力需要哪项权限才能调用。
 *
 * 为什么要有这张表：能力清单原本对所有调用者返回**全部**路由，一个只读 Key 读到的清单
 * 也会显示「可以删产品」「可以改模型配置」—— 清单在骗它，Agent 就会照着错的预期反复撞 403，
 * 既浪费 token 又浪费轮次。清单必须如实反映「以你的权限，你实际能做什么」。
 *
 * 口径与 PermissionsGuard 保持一致：`required` 为空表示所有登录用户都能调（公开读）。
 * 这里显式声明而不是运行时反射守卫，是因为守卫装饰器无法在不启动应用的情况下被可靠遍历；
 * 声明与守卫不一致时，下面 smoke 的「清单不得承诺调用者做不到的操作」会抓到。
 */
/** 按调用者权限过滤清单时用；未列出的操作视为无额外要求 */
export const OP_PERMISSIONS: Record<string, string[]> = {
  'POST /api/auth/register': [],
  'POST /api/auth/login': [],
  'GET /api/auth/me': [],
  'POST /api/auth/refresh': [],
  'PATCH /api/auth/profile': [],
  'POST /api/auth/change-password': [],
  // 改自己账号的手机号：与改密同口径，不挂额外权限。
  // 现有 19 个 action 全是租户业务资源（报价/接单/内容/知识库/对标/客服/团队/平台），
  // 没有任何一个覆盖「本人账号设置」；硬套业务权限反而会让 viewer 改不了自己的号码。
  'POST /api/auth/change-phone': [],

  'GET /api/team/role-templates': ['tenant:member:manage'],
  'GET /api/team/members': ['tenant:member:manage'],
  'POST /api/team/members': ['tenant:member:manage'],
  // 改成员角色 = 分配角色：成员管理权与角色分配权都要有（守卫是「全都要」的关系）
  'PATCH /api/team/members/{userId}': ['tenant:member:manage', 'tenant:role:assign'],
  'DELETE /api/team/members/{userId}': ['tenant:member:manage'],
  'GET /api/team/service-accounts': ['tenant:member:manage'],
  'DELETE /api/team/service-accounts/{userId}': ['tenant:member:manage'],
  // 角色目录（建/改/删自定义角色）决定「谁能干什么」这一份清单，
  // 因此除成员管理权外还要显式要 tenant:role:assign —— 否则这个 action 只是个勾选项
  'POST /api/team/roles': ['tenant:member:manage', 'tenant:role:assign'],
  'PATCH /api/team/roles/{id}': ['tenant:member:manage', 'tenant:role:assign'],
  'DELETE /api/team/roles/{id}': ['tenant:member:manage', 'tenant:role:assign'],

  'POST /api/agent/service-accounts': ['tenant:member:manage'],
  'GET /api/agent/service-accounts': ['tenant:member:manage'],
  'POST /api/agent/keys': ['tenant:member:manage'],
  'GET /api/agent/keys': ['tenant:member:manage'],
  'POST /api/agent/keys/{id}/revoke': ['tenant:member:manage'],
  'GET /api/agent/audit': ['platform:audit:view'],

  'GET /api/products': ['quote:read'],
  'POST /api/products/mine': ['quote:write'],
  'PATCH /api/products/{id}': ['quote:write'],
  'DELETE /api/products/{id}': ['quote:write'],
  'POST /api/products/{id}/copy-to-mine': ['quote:write'],
  'GET /api/categories': ['quote:read'],
  'POST /api/categories/mine': ['quote:read'],
  'DELETE /api/categories/{id}': ['quote:write'],
  'POST /api/products/ai-process': ['content:generate'],
  'GET /api/products/export': ['quote:read'],
  'GET /api/products/import-format': ['quote:read'],
  'POST /api/products/import': ['quote:write'],
  'POST /api/products/fetch-brand': ['quote:write'],

  'GET /api/orders': ['order:read'],
  'POST /api/orders': ['order:write'],
  'GET /api/orders/{id}': ['order:write'],
  'PATCH /api/orders/{id}': ['order:read'],
  'DELETE /api/orders/{id}': ['order:write'],
  'POST /api/orders/intake': ['order:read'],
  'PATCH /api/orders/{id}/status': ['order:write'],
  'POST /api/orders/{id}/notes': ['order:write'],
  'POST /api/orders/{id}/followup': ['order:write'],

  'GET /api/plans': ['content:read'],
  'POST /api/plans': ['content:generate'],
  'GET /api/plans/{id}': ['content:read'],
  'GET /api/plans/{id}/preflight': ['content:read'],
  'PATCH /api/plans/{id}/floorplan': ['content:generate'],
  'PATCH /api/plans/{id}/pages/{index}': ['content:generate'],
  'PATCH /api/plans/{id}/templates': ['content:generate'],
  'POST /api/plans/{id}/review': ['content:generate'],
  'POST /api/plans/{id}/render-floorplan': ['content:generate'],
  'PATCH /api/plans/{id}/videos': ['content:generate'],
  'PATCH /api/plans/{id}/assets': ['content:generate'],
  'POST /api/plans/{id}/package': ['content:generate'],
  'GET /api/plans/package/download': [],
  // 讲解音频：读状态与取文件是读权限，合成是写权限（会调外部语音服务）
  'GET /api/plans/{id}/narration-audio': ['content:read'],
  'POST /api/plans/{id}/narration-audio': ['content:generate'],
  'GET /api/plans/{id}/narration-audio/file': ['content:read'],
  'DELETE /api/plans/{id}': ['content:generate'],
  // 客户分享页：真实前缀是 /api/public/plans（PublicPlansController）。
  // 写成 /api/plans 会被主控制器的 @Get(':id') 抢先匹配 → Agent 拿不到分享页内容。
  'GET /api/public/plans/{token}': [],
  'GET /api/public/plans/{token}/floorplan': [],
  'GET /api/public/plans/{token}/rendered-floorplan': [],
  'GET /api/public/plans/{token}/video/{index}': [],

  // 页型配图（各页面的固定配图，导出交付件时用）
  'GET /api/plans/page-images': ['content:read'],
  'PUT /api/plans/page-images/{pageType}': ['content:generate'],
  'DELETE /api/plans/page-images/{pageType}': ['content:generate'],

  'GET /api/layouts': ['content:read'],
  'POST /api/layouts': ['content:generate'],
  'GET /api/layouts/{id}': ['content:read'],
  'PATCH /api/layouts/{id}': ['content:read'],
  'DELETE /api/layouts/{id}': ['content:generate'],
  'GET /api/layouts/{id}/summary': ['quote:read'],
  'POST /api/floorplan/detect': ['content:generate'],

  'GET /api/lighting': ['content:read'],
  'POST /api/lighting': ['content:read'],
  'GET /api/lighting/{id}': ['content:read'],
  'PATCH /api/lighting/{id}': ['content:read'],
  'DELETE /api/lighting/{id}': ['content:generate'],
  'GET /api/lighting/diagnose/modes': ['content:read'],
  'POST /api/lighting/diagnose': ['content:generate'],

  'GET /api/canvas/conversations': ['content:read'],
  'POST /api/canvas/conversations': ['content:read'],
  'GET /api/canvas/conversations/{id}': ['content:read'],
  'PATCH /api/canvas/conversations/{id}': ['content:read'],
  'DELETE /api/canvas/conversations/{id}': ['content:generate'],
  'POST /api/canvas/conversations/{id}/turns': ['content:generate'],
  'PATCH /api/canvas/turns/{id}': ['content:generate'],
  'DELETE /api/canvas/turns/{id}': ['content:generate'],
  'GET /api/canvas/jobs/{id}': ['content:read'],
  'POST /api/canvas/jobs/{id}/run': ['content:read'],
  'GET /api/canvas/tasks': ['content:read'],
  'DELETE /api/canvas/tasks/finished': ['content:read'],

  'POST /api/media/uploads': ['content:generate'],
  'GET /api/media/assets': ['content:read'],
  'GET /api/media/assets/{id}/file': ['content:read'],
  'PATCH /api/media/assets/{id}': ['content:read'],
  'DELETE /api/media/assets/{id}': ['content:generate'],
  'POST /api/media/images': ['content:generate'],
  'POST /api/media/images/reverse-prompt': ['content:generate'],
  'POST /api/media/videos': ['content:generate'],
  'POST /api/media/materials/upload': ['content:generate'],

  'GET /api/agents': ['content:read'],
  'POST /api/agents': ['content:read'],
  'PATCH /api/agents/{id}': ['content:generate'],
  'DELETE /api/agents/{id}': ['content:generate'],

  'GET /api/knowledge/external': ['knowledge:manage'],
  'PUT /api/knowledge/external': ['knowledge:manage'],
  'DELETE /api/knowledge/external': ['knowledge:manage'],
  'POST /api/knowledge/external/search': ['knowledge:manage'],
  'POST /api/knowledge/external/test': ['knowledge:manage'],
  'GET /api/knowledge/docs': ['knowledge:manage'],
  'POST /api/knowledge/docs/upload': ['knowledge:manage'],
  'POST /api/knowledge/docs/{id}/toggle': ['knowledge:manage'],
  'DELETE /api/knowledge/docs/{id}': ['knowledge:manage'],
  'POST /api/knowledge/docs/search': ['knowledge:read'],

  'GET /api/benchmark/accounts': ['benchmark:read'],
  'POST /api/benchmark/accounts': ['benchmark:write'],
  'PATCH /api/benchmark/accounts/{id}': ['benchmark:write'],
  'DELETE /api/benchmark/accounts/{id}': ['benchmark:write'],
  'GET /api/benchmark/collect-spec': ['benchmark:read'],
  'POST /api/benchmark/contents': ['benchmark:write'],
  'GET /api/benchmark/contents': ['benchmark:read'],
  'POST /api/benchmark/prune': ['benchmark:write'],
  'POST /api/benchmark/analyze': ['benchmark:write'],
  'GET /api/benchmark/insights': ['benchmark:read'],

  'GET /api/content/extractions': ['content:extract'],
  'GET /api/content/extractions/{id}': ['content:extract'],
  'POST /api/content/extractions/upload': ['content:extract'],
  'POST /api/content/extractions/transcript': ['content:extract'],
  'POST /api/content/extractions/url': ['content:extract'],
  'POST /api/content/extractions/{id}/confirm': ['content:extract'],
  'GET /api/content/extractions/documents': ['content:extract'],
  'DELETE /api/content/extractions/documents/{id}': ['content:extract'],

  'GET /api/feedback': ['cs:read'],
  'POST /api/feedback': ['cs:write'],
  'GET /api/feedback/{id}': ['cs:read'],
  'GET /api/feedback/{id}/issue-link': ['cs:read'], // 生成「提交到作者仓库」的预填 issue 链接
  'PATCH /api/feedback/{id}': ['platform:billing:manage'], // 管理员回复，不是普通提反馈
  'DELETE /api/feedback/{id}': ['cs:write'],

  'POST /api/llm/chat': ['content:generate'],

  'GET /api/tenants/current': [],
  'PATCH /api/tenants/current': ['tenant:member:manage'], // 改工作台名称，显示在侧栏顶部
  // 额度余额与流水是租户级财务数据：以前任何登录成员都能读全租户的账，
  // 现在要 tenant:billing:view（财务与管理员角色自带）
  'GET /api/tenants/current/tokens': ['tenant:billing:view'],
  'GET /api/tenants/current/tokens/ledger': ['tenant:billing:view'],
  'POST /api/tenants/current/tokens/grant': ['tenant:token:grant'],
  'GET /api/tenants/mine': [],

  'GET /api/admin/backup': ['platform:billing:manage'],
  'POST /api/admin/backup/restore': ['platform:billing:manage'],
  'GET /api/admin/storage': ['platform:billing:manage'],
  'POST /api/admin/storage/cleanup': ['platform:billing:manage'],
  'GET /api/admin/model-config': ['platform:billing:manage'],
  'PUT /api/admin/model-config/chat': ['platform:billing:manage'],
  'PUT /api/admin/model-config/image': ['platform:billing:manage'],
  'PUT /api/admin/model-config/video': ['platform:billing:manage'],
  'GET /api/admin/model-config/profiles': ['platform:billing:manage'],
  'POST /api/admin/model-config/profiles/save': ['platform:billing:manage'],
  'POST /api/admin/model-config/profiles/{id}/activate': ['platform:billing:manage'],
  'DELETE /api/admin/model-config/profiles/{id}': ['platform:billing:manage'],
  'POST /api/admin/model-config/test-chat': ['platform:billing:manage'],
  'POST /api/admin/model-config/test-image': ['platform:billing:manage'],
  'POST /api/admin/model-config/test-video': ['platform:billing:manage'],
  'POST /api/admin/model-config/test-comfy': ['platform:billing:manage'],
  'GET /api/admin/model-config/agent-skillpack': ['platform:billing:manage'],
  'DELETE /api/admin/model-config/{scope}': ['platform:billing:manage'],
  'POST /api/admin/model-config/chat/models': ['platform:billing:manage'],
  'GET /api/desktop/config': ['platform:billing:manage'],
  'PUT /api/desktop/config': ['platform:billing:manage'],

  // 自身机器接入里无守卫的部分（快照与还原走成员身份，不额外要权限）
  'GET /api/agent/manifest': [],
  'POST /api/agent/snapshots': [],
  'GET /api/agent/snapshots': [],
  'POST /api/agent/snapshots/{id}/restore': [],

  // 两个免鉴权的部署级只读端点：探活与品牌信息。
  // 清单必须写出来 —— Agent 拿到的是「本系统能做什么」，这两个是它上手的第一步
  'GET /api/health': [],
  'GET /api/public/branding': [],
};

export interface ManifestOp {
  m: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  p: string;
  /** 一句话：这条接口干什么 */
  d: string;
  risk: Risk;
  /** 只列「容易填错」的关键参数，其余靠 DTO 校验 */
  q?: Record<string, string>;
}

export interface ManifestGroup {
  id: string;
  name: string;
  /** 这组解决什么业务问题 */
  about: string;
  ops: ManifestOp[];
}

const R = 'read' as const;
const W = 'write' as const;
const D = 'destructive' as const;

export const MANIFEST: ManifestGroup[] = [
  {
    id: 'agent',
    name: 'Agent 自身（机器接入）',
    about: '签发/吊销 API Key、管理服务账号、打快照与还原、看审计。你用这套接入本系统。',
    ops: [
      { m: 'GET', p: '/api/agent/manifest', d: '本清单。?index=1 取索引，?group=xxx 取单组详情', risk: R },
      { m: 'POST', p: '/api/agent/service-accounts', d: '建机器账号（无可用密码，只能用 Key 登录）', risk: W, q: { name: '展示名', roleKey: 'super_admin|tenant_admin|designer|operator|viewer' } },
      { m: 'GET', p: '/api/agent/service-accounts', d: '列本租户的机器账号', risk: R },
      { m: 'POST', p: '/api/agent/keys', d: '签发 API Key。只返回一次，平台不留存密钥材料', risk: W, q: { name: '用途标签', ttlDays: '1-365，默认 90', serviceAccountId: '不给则给当前用户自己建' } },
      { m: 'GET', p: '/api/agent/keys', d: '列 Key（只有前 12 位与状态，无明文）', risk: R },
      { m: 'POST', p: '/api/agent/keys/{id}/revoke', d: '吊销 Key，立即生效', risk: W },
      { m: 'POST', p: '/api/agent/snapshots', d: '动数据前打快照，整租户相关表存 JSON', risk: W, q: { label: '写清这一步要干什么', trigger: 'manual|auto' } },
      { m: 'GET', p: '/api/agent/snapshots', d: '列快照（不拉数据体）', risk: R },
      { m: 'POST', p: '/api/agent/snapshots/{id}/restore', d: '还原到该快照。撤不回已花掉的额度与已生成的媒体', risk: D, q: { confirm: '必须是快照 id 前 8 位，防手滑', dropNewer: '默认 true，连快照后新增的数据一起删' } },
      { m: 'GET', p: '/api/agent/audit', d: '查审计。?actorKind=agent 只看机器操作', risk: R, q: { requestId: '精确追一次动作', limit: '默认 100' } },
      { m: 'GET', p: '/api/health', d: '服务健康检查（免鉴权）。接入前先探活', risk: R },
      { m: 'GET', p: '/api/public/branding', d: '部署级品牌信息（免鉴权）：产品名与图标地址。生成文案/方案落款用产品名', risk: R },
    ],
  },
  {
    id: 'auth',
    name: '登录与身份',
    about: '人用的登录接口。Agent 不要走这里，用 /api/agent/keys。',
    ops: [
      { m: 'POST', p: '/api/auth/register', d: '注册新租户（开箱即用的第一条路）', risk: W },
      { m: 'POST', p: '/api/auth/login', d: '手机号+密码换 JWT', risk: R },
      { m: 'GET', p: '/api/auth/me', d: '当前身份与权限列表', risk: R },
      { m: 'POST', p: '/api/auth/refresh', d: '用旧 token 换新 token', risk: R },
      { m: 'PATCH', p: '/api/auth/profile', d: '改昵称/头像底色', risk: W },
      { m: 'POST', p: '/api/auth/change-password', d: '改密码。会自增令牌版本，旧 token 全部立即失效', risk: W },
      { m: 'POST', p: '/api/auth/change-phone', d: '改登录手机号（不校验旧密码）。会自增令牌版本，旧 token 全部立即失效', risk: W },
    ],
  },
  {
    id: 'tenant',
    name: '租户与额度',
    about: '额度账本。你在界面上看到的「¥xxx」就是这个余额。',
    ops: [
      { m: 'GET', p: '/api/tenants/current', d: '当前租户信息', risk: R },
      { m: 'PATCH', p: '/api/tenants/current', d: '★ 改工作台名称与安装调试费率，显示在侧栏顶部与分享页', risk: W, q: { name: '1-24 字', installRate: '安装调试费率 0-100（百分比），按设备参考零售合计计取' } },
      { m: 'GET', p: '/api/tenants/mine', d: '我加入的所有租户', risk: R },
      { m: 'GET', p: '/api/tenants/current/tokens', d: '额度余额（需 tenant:billing:view）', risk: R },
      { m: 'GET', p: '/api/tenants/current/tokens/ledger', d: '额度流水（发放/消耗，需 tenant:billing:view）', risk: R },
      { m: 'POST', p: '/api/tenants/current/tokens/grant', d: '发放额度', risk: W },
    ],
  },
  {
    id: 'quote',
    name: '智能报价',
    about: '从产品库选品配单、算总价、导出报价单。门店报价主流程。',
    ops: [
      { m: 'GET', p: '/api/products', d: '产品库列表（可按分类/关键词过滤）', risk: R },
      { m: 'POST', p: '/api/products/mine', d: '加一个自建产品', risk: W },
      { m: 'PATCH', p: '/api/products/{id}', d: '改产品', risk: W },
      { m: 'DELETE', p: '/api/products/{id}', d: '删产品', risk: D },
      { m: 'POST', p: '/api/products/{id}/copy-to-mine', d: '把公共库产品复制一份到我的库（可改价改规格）', risk: W },
      { m: 'POST', p: '/api/products/ai-process', d: '用 AI 从一段描述抽取产品参数并落库', risk: W },
      { m: 'GET', p: '/api/categories', d: '品类字典', risk: R },
      { m: 'POST', p: '/api/categories/mine', d: '加自定义品类', risk: W },
      { m: 'DELETE', p: '/api/categories/{id}', d: '删自定义品类', risk: D },
      {
        m: 'GET',
        p: '/api/products/export',
        d: '导出产品库（?scope=mine|all&format=csv|json），返回文件下载',
        risk: R,
      },
      {
        m: 'GET',
        p: '/api/products/import-format',
        d: '取导入格式契约：字段清单与约束、当前可用的品类字典、CSV 模板表头、JSON 示例、导入规则。'
          + '要往产品库灌数据，先取这份契约照着填 —— 品类字典是租户可自定义的，不能自己编',
        risk: R,
      },
      {
        m: 'POST',
        p: '/api/products/import',
        d: '导入产品库（rows 传 JSON 行，或 csv 传 CSV 文本）。同名同品牌按更新处理，整批校验不过则整批不落库',
        risk: W,
      },
      {
        m: 'POST',
        p: '/api/products/fetch-brand',
        d: '从品牌官网抓产品列表并转成我们的格式（mode=preview 只看不写 / mode=import 直接落库）。'
          + '入参 {siteUrl, brand, mode, updateExisting}。siteUrl 必须是品牌官网「产品中心」页地址，'
          + '不是网站首页（首页会返回 SITE_NOT_SUPPORTED）。'
          + '若你自己已经有抓取能力，用 import-format 契约自行取数后走 import 即可',
        risk: W,
      },
    ],
  },
  {
    id: 'order',
    name: '开始接单',
    about: '销售接待工作台：粘贴客户原话 → AI 结构化建档 → 跟进到成交。',
    ops: [
      { m: 'GET', p: '/api/orders', d: '接单列表', risk: R },
      { m: 'POST', p: '/api/orders', d: '新建接单', risk: W },
      { m: 'GET', p: '/api/orders/{id}', d: '接单详情', risk: R },
      { m: 'PATCH', p: '/api/orders/{id}', d: '改接单', risk: W },
      { m: 'DELETE', p: '/api/orders/{id}', d: '删接单（含其跟进记录）', risk: D },
      { m: 'POST', p: '/api/orders/intake', d: '★ AI 解析建档：喂客户原始描述，出结构化需求。会真实调用模型并扣额度', risk: W, q: { text: '客户原话', '会消耗额度': 'true' } },
      { m: 'PATCH', p: '/api/orders/{id}/status', d: '推进/回退接单状态', risk: W },
      { m: 'POST', p: '/api/orders/{id}/notes', d: '加跟进记录', risk: W },
      { m: 'POST', p: '/api/orders/{id}/followup', d: '生成下一步跟进建议（调模型，扣额度）', risk: W },
    ],
  },
  {
    id: 'plan',
    name: '智能方案',
    about: '生成方案 PPT/PDF、逐页编辑、渲染户型图，客户分享页靠 token 免登录访问。',
    ops: [
      { m: 'GET', p: '/api/plans', d: '方案列表', risk: R },
      { m: 'POST', p: '/api/plans', d: '新建方案', risk: W },
      { m: 'GET', p: '/api/plans/{id}', d: '方案详情（含分页内容）', risk: R },
      { m: 'GET', p: '/api/plans/{id}/preflight', d: '交付前预检：逐页报出「待确认/暂无资料」这类内部语句（只读，不扣额度）', risk: R },
      { m: 'DELETE', p: '/api/plans/{id}', d: '删方案', risk: D },
      { m: 'PATCH', p: '/api/plans/{id}/pages/{index}', d: '改某一页的内容（改完版本号 +1，校对状态自动失效）', risk: W },
      { m: 'PATCH', p: '/api/plans/{id}/templates', d: '改交付模版（户型图设计/产品放置样式；版本号 +1，校对状态自动失效）', risk: W },
      { m: 'POST', p: '/api/plans/{id}/review', d: '标记当前版本已逐页校对（导出/分享前的门禁）', risk: W },
      { m: 'PATCH', p: '/api/plans/{id}/floorplan', d: '设置户型图与点位', risk: W },
      { m: 'POST', p: '/api/plans/{id}/render-floorplan', d: '渲染户型图（消耗算力）', risk: W },
      { m: 'PATCH', p: '/api/plans/{id}/videos', d: '绑定场景视频（最多 2 条，分享页内联播放）', risk: W },
      { m: 'PATCH', p: '/api/plans/{id}/assets', d: '把工具产物挂到工程上（渲染图/场景视频/户型图与点位）', risk: W },
      { m: 'POST', p: '/api/plans/{id}/package', d: '打包交付（PPTX + 讲稿 + 图片包，配了语音服务时多带一份讲解音频），需已逐页校对', risk: W },
      { m: 'GET', p: '/api/plans/package/download', d: '按签名直链下载交付包（链接即凭证，2 小时过期且方案改版即失效）', risk: R },
      { m: 'GET', p: '/api/plans/{id}/narration-audio', d: '★ 讲解音频状态：有没有、地址在哪、多长（只读）。取到后可推给有喇叭的设备播报', risk: R },
      { m: 'POST', p: '/api/plans/{id}/narration-audio', d: '按讲稿文本合成讲解音频（同一版本重复调用复用已存的那份）', risk: W },
      { m: 'GET', p: '/api/plans/{id}/narration-audio/file', d: '讲解音频文件流（WAV）', risk: R },
      { m: 'GET', p: '/api/public/plans/{token}/video/{index}', d: '分享页场景视频文件流（凭 shareToken 免鉴权）', risk: R },
      { m: 'GET', p: '/api/public/plans/{token}', d: '★ 免鉴权：客户分享页读方案（微信直开用）', risk: R },
      { m: 'GET', p: '/api/public/plans/{token}/floorplan', d: '★ 免鉴权：分享页的原始户型图', risk: R },
      { m: 'GET', p: '/api/public/plans/{token}/rendered-floorplan', d: '★ 免鉴权：分享页的渲染后户型图', risk: R },
      { m: 'GET', p: '/api/plans/page-images', d: '本租户已配置的页型配图（没配过的页型不出现）', risk: R },
      { m: 'PUT', p: '/api/plans/page-images/{pageType}', d: '设某页型的配图（传素材 id）', risk: W, q: { pageType: '页型标识', mediaAssetId: '素材 id' } },
      { m: 'DELETE', p: '/api/plans/page-images/{pageType}', d: '清掉某页型的配图（回到兜底图）', risk: D },
    ],
  },
  {
    id: 'layout',
    name: '设备点位布局',
    about: '上传户型平面图，从产品库点选设备布点，导出点位表。',
    ops: [
      { m: 'GET', p: '/api/layouts', d: '布局列表', risk: R },
      { m: 'POST', p: '/api/layouts', d: '新建布局', risk: W },
      { m: 'GET', p: '/api/layouts/{id}', d: '布局详情（含点位坐标）', risk: R },
      { m: 'PATCH', p: '/api/layouts/{id}', d: '改点位/改布局', risk: W },
      { m: 'DELETE', p: '/api/layouts/{id}', d: '删布局', risk: D },
      { m: 'GET', p: '/api/layouts/{id}/summary', d: '点位汇总（按品类聚合，用于报价）', risk: R },
      { m: 'POST', p: '/api/floorplan/detect', d: '户型图识别房间并布点（读图，消耗算力）', risk: W },
    ],
  },
  {
    id: 'lighting',
    name: '智能灯光场景',
    about: '上传效果图 → 编排每盏灯（含电气回路）→ 关键帧时间轴 → 出片。',
    ops: [
      { m: 'GET', p: '/api/lighting', d: '灯光场景列表', risk: R },
      { m: 'POST', p: '/api/lighting', d: '保存场景（灯具坐标已归一化 0-1）', risk: W, q: { 'fixtures[].circuit': '所属电气回路 id，空串=未归组' } },
      { m: 'GET', p: '/api/lighting/{id}', d: '场景详情', risk: R },
      { m: 'GET', p: '/api/lighting/diagnose/modes', d: '灯光问诊任务定义（五项任务 + 每项三题）', risk: R },
      { m: 'POST', p: '/api/lighting/diagnose', d: '灯光问诊：按任务与作答生成分级建议（扣额度，不给毫米级施工参数）', risk: W },
      { m: 'PATCH', p: '/api/lighting/{id}', d: '改场景', risk: W },
      { m: 'DELETE', p: '/api/lighting/{id}', d: '删场景', risk: D },
    ],
  },
  {
    id: 'canvas',
    name: 'AI 画布',
    about: '像聊天一样连续出图：每轮可出多个变体，支持圈选局部重绘。',
    ops: [
      { m: 'GET', p: '/api/canvas/conversations', d: '画布对话列表', risk: R },
      { m: 'POST', p: '/api/canvas/conversations', d: '新建对话线', risk: W },
      { m: 'GET', p: '/api/canvas/conversations/{id}', d: '对话线详情（含全部轮次与变体）', risk: R },
      { m: 'PATCH', p: '/api/canvas/conversations/{id}', d: '改对话线', risk: W },
      { m: 'DELETE', p: '/api/canvas/conversations/{id}', d: '删整条对话线（含轮次与作业）', risk: D },
      { m: 'POST', p: '/api/canvas/conversations/{id}/turns', d: '★ 发一轮出图。会真实调模型、扣额度。接新轮次必须带 parentId', risk: W, q: { parentId: '续轮必传；不传会变成新的根轮次导致界面不显示' } },
      { m: 'PATCH', p: '/api/canvas/turns/{id}', d: '改一轮的描述', risk: W },
      { m: 'DELETE', p: '/api/canvas/turns/{id}', d: '删一轮', risk: D },
      { m: 'GET', p: '/api/canvas/jobs/{id}', d: '查某个出图作业状态', risk: R },
      { m: 'POST', p: '/api/canvas/jobs/{id}/run', d: '手动触发待执行作业', risk: W },
      { m: 'GET', p: '/api/canvas/tasks', d: '进行中的任务', risk: R },
      { m: 'DELETE', p: '/api/canvas/tasks/finished', d: '清掉已完成的作业记录', risk: D },
    ],
  },
  {
    id: 'media',
    name: '素材与生成',
    about: '上传落库、生图、生视频、产物库增删改查。★ 生成类接口会真实扣额度。',
    ops: [
      { m: 'POST', p: '/api/media/uploads', d: '上传一个文件（multipart），返回 assetId 供后续引用', risk: W },
      { m: 'GET', p: '/api/media/assets', d: '产物库列表', risk: R },
      { m: 'GET', p: '/api/media/assets/{id}/file', d: '取文件本体', risk: R, q: { '鉴权': 'img/video 链接不能带 Authorization 头，用 ?token= 查询参数' } },
      { m: 'PATCH', p: '/api/media/assets/{id}', d: '改素材元信息', risk: W },
      { m: 'DELETE', p: '/api/media/assets/{id}', d: '删素材（行+文件）', risk: D },
      { m: 'POST', p: '/api/media/images', d: '★ 生图。会调模型、扣额度', risk: W },
      { m: 'POST', p: '/api/media/images/reverse-prompt', d: '★ 反推提示词。会调模型、扣额度', risk: W },
      { m: 'POST', p: '/api/media/videos', d: '★ 生视频。会调模型、扣额度', risk: W },
      { m: 'POST', p: '/api/media/materials/upload', d: '上传视频素材（进「我的作品」）', risk: W },
    ],
  },
  {
    id: 'agents',
    name: '智能体',
    about: '自建智能体（人设 + 首条任务），与预置的 13 个角色并存。',
    ops: [
      { m: 'GET', p: '/api/agents', d: '智能体列表', risk: R },
      { m: 'POST', p: '/api/agents', d: '建智能体', risk: W, q: { systemPrompt: '人设，决定它以什么身份回答', starterPrompt: '点开时预填的第一条任务' } },
      { m: 'PATCH', p: '/api/agents/{id}', d: '改智能体', risk: W },
      { m: 'DELETE', p: '/api/agents/{id}', d: '删智能体', risk: D },
    ],
  },
  {
    id: 'team',
    name: '团队成员与角色模板',
    about: '给同事开账号、定角色权限；角色是成品模板，不逐项勾权限 action。需要 tenant:member:manage。',
    ops: [
      { m: 'GET', p: '/api/team/role-templates', d: '角色模板列表（含每个模板的权限明细与适用人群）', risk: R },
      { m: 'GET', p: '/api/team/members', d: '本租户成员列表（含角色与权限）', risk: R },
      { m: 'POST', p: '/api/team/members', d: '★ 建成员：手机号+姓名+角色模板+初始密码。初始密码需线下告知本人', risk: W, q: { roleKey: 'super_admin|tenant_admin|designer|operator|viewer', password: '至少 8 位且含字母与数字' } },
      { m: 'PATCH', p: '/api/team/members/{userId}', d: '改成员角色模板。降级最后一个管理员会被拒', risk: W },
      { m: 'DELETE', p: '/api/team/members/{userId}', d: '把成员移出本租户（不删其全局账号）。其 API Key 同时失效', risk: D },
      { m: 'POST', p: '/api/team/roles', d: '★ 新建自定义角色：勾权限组合成新岗位。只能授予自己已有的权限，越权会被 403 拒', risk: W, q: { permissions: '权限 action 数组，必须是调用方自己拥有的那些' } },
      { m: 'PATCH', p: '/api/team/roles/{id}', d: '改自定义角色的名称/说明/权限。系统模板不可改', risk: W },
      { m: 'DELETE', p: '/api/team/roles/{id}', d: '删自定义角色。还有成员在用会被拒', risk: D },
      { m: 'GET', p: '/api/team/service-accounts', d: '本租户的机器账号', risk: R },
      { m: 'DELETE', p: '/api/team/service-accounts/{userId}', d: '删机器账号，其全部 API Key 同时吊销。人类成员走此口会被拒', risk: D },
    ],
  },
  {
    id: 'knowledge',
    name: '知识库',
    about: '外部知识源接入与检索。',
    ops: [
      { m: 'GET', p: '/api/knowledge/external', d: '已接入的外部源', risk: R },
      { m: 'PUT', p: '/api/knowledge/external', d: '接入/更新一个外部源', risk: W },
      { m: 'DELETE', p: '/api/knowledge/external', d: '断开外部源', risk: D },
      { m: 'POST', p: '/api/knowledge/external/search', d: '在外部源里检索', risk: R },
      { m: 'POST', p: '/api/knowledge/external/test', d: '测连通性', risk: R },
      { m: 'GET', p: '/api/knowledge/docs', d: '本地资料库列表（含生效量/累计量字数）', risk: R },
      { m: 'POST', p: '/api/knowledge/docs/upload', d: '上传资料并解析入库（同名视为更新，单份≤8万字）', risk: W },
      { m: 'POST', p: '/api/knowledge/docs/{id}/toggle', d: '按份开关：是否参与 AI 召回', risk: W },
      { m: 'DELETE', p: '/api/knowledge/docs/{id}', d: '删除一份资料（只删库里的行，原文件在 uploads 卷另行管理）', risk: D },
      { m: 'POST', p: '/api/knowledge/docs/search', d: '预览本地资料召回效果（验证「AI 到底查不查得到」）', risk: R },
    ],
  },
  {
    id: 'benchmark',
    name: '对标账号情报',
    about:
      '配置我们盯的对标账号 → 采集它们的热门内容元数据 → AI 映射到我们业务（风格画像 + 场景/产品/卖点映射 + 差距清单）→ 结论进知识库供智能体检索。' +
      '采集动作在 Agent 侧用浏览器能力完成（服务端不引无头浏览器）；本组提供的是**契约、接收与分析**。',
    ops: [
      { m: 'GET', p: '/api/benchmark/accounts', d: '对标账号清单（含每个账号已采集条数）', risk: R },
      { m: 'POST', p: '/api/benchmark/accounts', d: '新增对标账号', risk: W },
      { m: 'PATCH', p: '/api/benchmark/accounts/{id}', d: '改对标账号', risk: W },
      { m: 'DELETE', p: '/api/benchmark/accounts/{id}', d: '删对标账号（连同其采集内容与分析结果）', risk: D },
      { m: 'GET', p: '/api/benchmark/collect-spec', d: '★ 采集契约：要采哪些字段、怎么算热门、怎么提交（给 Agent 读）', risk: R },
      { m: 'POST', p: '/api/benchmark/contents', d: '提交采集到的内容元数据（内容链接是幂等键，重复提交不重复入库）', risk: W },
      { m: 'GET', p: '/api/benchmark/contents', d: '已采集的热门内容（排序维度可切换：综合热度/互动总量/播放量/发布时间）', risk: R },
      { m: 'POST', p: '/api/benchmark/prune', d: '清理超保留期的采集内容（默认保留 90 天）', risk: D },
      { m: 'POST', p: '/api/benchmark/analyze', d: '★ 触发 AI 映射分析（会调模型）', risk: W },
      { m: 'GET', p: '/api/benchmark/insights', d: '分析结果：风格画像 + 差距清单', risk: R },
    ],
  },
  {
    id: 'content',
    name: '内容提取',
    about: '上传文档/录音/URL，抽成结构化字段并人工确认。',
    ops: [
      { m: 'GET', p: '/api/content/extractions', d: '提取任务列表', risk: R },
      { m: 'GET', p: '/api/content/extractions/{id}', d: '任务详情（含抽出的字段与缺失项）', risk: R },
      { m: 'POST', p: '/api/content/extractions/upload', d: '上传文档并提取', risk: W },
      { m: 'POST', p: '/api/content/extractions/transcript', d: '上传录音转写并提取', risk: W },
      { m: 'POST', p: '/api/content/extractions/url', d: '按 URL 抓取并提取', risk: W },
      { m: 'POST', p: '/api/content/extractions/{id}/confirm', d: '人工确认抽出的字段', risk: W },
      { m: 'GET', p: '/api/content/extractions/documents', d: '已提取文档列表', risk: R },
      { m: 'DELETE', p: '/api/content/extractions/documents/{id}', d: '删文档及其字段', risk: D },
    ],
  },
  {
    id: 'feedback',
    name: '问题反馈',
    about: '用户提的问题与官方回复。',
    ops: [
      { m: 'GET', p: '/api/feedback', d: '反馈列表', risk: R },
      { m: 'POST', p: '/api/feedback', d: '提交反馈', risk: W },
      { m: 'GET', p: '/api/feedback/{id}', d: '反馈详情', risk: R },
      { m: 'GET', p: '/api/feedback/{id}/issue-link', d: '生成提交到作者仓库的 issue 链接', risk: R },
      { m: 'PATCH', p: '/api/feedback/{id}', d: '回复/改反馈', risk: W },
      { m: 'DELETE', p: '/api/feedback/{id}', d: '删反馈', risk: D },
    ],
  },
  {
    id: 'llm',
    name: '模型直调',
    about: '直接调对话模型。走这条不会经过平台的额度记账，慎用。',
    ops: [
      { m: 'POST', p: '/api/llm/chat', d: '直调对话模型', risk: W, q: { '⚠️': '不扣平台额度，等于绕过计费' } },
    ],
  },
  {
    id: 'model-config',
    name: '模型配置（部署级）',
    about: '配置各家模型接入与 API Key。属于部署者配置，Agent 一般不该动。',
    ops: [
      { m: 'GET', p: '/api/admin/model-config', d: '读配置（密钥只返回掩码）', risk: R },
      { m: 'PUT', p: '/api/admin/model-config/chat', d: '改对话模型配置', risk: W, q: { apiKey: '传空串=保持原样；不传=不变' } },
      { m: 'PUT', p: '/api/admin/model-config/image', d: '改生图模型配置', risk: W },
      { m: 'PUT', p: '/api/admin/model-config/video', d: '改生视频模型配置', risk: W },
      { m: 'GET', p: '/api/admin/model-config/profiles', d: '配置档列表', risk: R },
      { m: 'POST', p: '/api/admin/model-config/profiles/save', d: '存配置档', risk: W },
      { m: 'POST', p: '/api/admin/model-config/profiles/{id}/activate', d: '切换配置档', risk: W },
      { m: 'DELETE', p: '/api/admin/model-config/profiles/{id}', d: '删配置档', risk: D },
      { m: 'POST', p: '/api/admin/model-config/test-chat', d: '测对话模型连通（调模型）', risk: W },
      { m: 'POST', p: '/api/admin/model-config/test-image', d: '测生图模型连通（调模型）', risk: W },
      { m: 'POST', p: '/api/admin/model-config/test-video', d: '测生视频模型连通（调模型）', risk: W },
      { m: 'POST', p: '/api/admin/model-config/test-comfy', d: '测 ComfyUI 连通', risk: W },
      { m: 'GET', p: '/api/admin/model-config/agent-skillpack', d: '取给 Agent 用的技能包描述', risk: R },
      { m: 'DELETE', p: '/api/admin/model-config/{scope}', d: '清掉某类模型配置（会连同密钥）', risk: D },
      { m: 'POST', p: '/api/admin/model-config/chat/models', d: '拉取对话服务商的可用模型清单（可带未保存的 baseUrl/apiKey 先试）', risk: R },
      { m: 'GET', p: '/api/desktop/config', d: '读桌面端部署配置（品牌名/图标/语音服务地址与令牌，令牌只给「是否已配置」）', risk: R },
      { m: 'PUT', p: '/api/desktop/config', d: '改桌面端部署配置（只改请求里出现的字段）', risk: W },
    ],
  },
  {
    id: 'admin',
    name: '备份与存储治理（部署级）',
    about: '全库备份、产物占用统计与清理。',
    ops: [
      { m: 'GET', p: '/api/admin/backup', d: '全库 JSON 快照下载（同时在 uploads/backups 留一份）', risk: R, q: { '⚠️': '含用户手机号等敏感数据，别外传' } },
      { m: 'POST', p: '/api/admin/backup/restore', d: '从备份 JSON 恢复数据（破坏性，需确认串；merge 不删现有数据 / replace 覆盖）', risk: D, q: { '⚠️': '覆盖模式会清空目标表后写入，无法撤销' } },
      { m: 'GET', p: '/api/admin/storage', d: '产物占用统计', risk: R },
      { m: 'POST', p: '/api/admin/storage/cleanup', d: '清理 N 天前且未被引用的产物（行+文件）', risk: D, q: { beforeDays: '天阈值，传 0 只为实测连通性' } },
    ],
  },
];

/** 危险操作速查：只想要「别手滑」的清单时读这个 */
export function destructiveOps(): { m: string; p: string; d: string; group: string }[] {
  return MANIFEST.flatMap((g) => g.ops.filter((o) => o.risk === 'destructive').map((o) => ({ m: o.m, p: o.p, d: o.d, group: g.id })));
}

/** 清单里声明过的全部「METHOD /path」，smoke 用它跟真实路由比对做漂移检查 */
export function manifestRouteKeys(): Set<string> {
  return new Set(MANIFEST.flatMap((g) => g.ops.map((o) => `${o.m} ${o.p}`)));
}

/**
 * 破坏性操作的实际路径模板（Nest 风格 :param），供运行期按请求路径识别。
 *
 * 为什么要「识别」而不是给每个端点加守卫：逐个端点加标记，加漏一个就等于没防护，
 * 而漏的那个恰好是最容易被误调的那个。清单是单一事实来源，转成运行时模式只有一个地方要对。
 */
export function destructivePatterns(): { method: string; pattern: RegExp }[] {
  return MANIFEST.flatMap((g) =>
    g.ops.filter((o) => o.risk === 'destructive').map((o) => ({
      method: o.m,
      // {id} → :id，再转成能匹配任意一段路径的捕获组
      pattern: new RegExp(`^${o.p.replace(/\{[^}]+\}/g, '[^/]+').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
    })),
  );
}