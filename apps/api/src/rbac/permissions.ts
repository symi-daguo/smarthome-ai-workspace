/**
 * 权限 action 全集。
 *
 * 命名约定：`<资源>:<动词>`，动词只有 read / write 两档 —— 照搬 Appwrite 的
 * `resource.read` / `resource.write` 二元切分（BSD-3-Clause，许可证已核实）。
 * 为什么不一律 `:manage`：manage 把「看」和「改」绑在一起，于是
 * 「财务要能看报价金额但不能改价」这种最常见的诉求根本无法表达 ——
 * 结果就是要么给全权（财务能乱改价），要么干脆不给（财务看不到账）。
 *
 * 二元切分的另一半配套规则在 ability.factory.ts：**有 write 隐含有 read**。
 * 少了这条，角色定义就得为每个资源重复写两遍 read，且会出现
 * 「能改却看不到」这种反直觉的权限组合。
 *
 * 刻意保留单动作、不拆二元的（它们天生一体，拆了只会制造无意义的组合）：
 *   platform:*          平台级运维动作
 *   tenant:member:manage / tenant:role:assign / tenant:token:grant
 *                        成员增删改、角色分配、额度发放本身就是一件事
 *   content:extract     提取本身就是一次写操作，没有「只读地提取」
 *   knowledge:manage / knowledge:read
 *                        已经是二元，沿用既有命名不折腾
 */
export const PERMISSIONS = [
  // —— 平台级 ——
  'platform:tenant:manage',
  'platform:billing:manage',
  'platform:audit:view',

  // —— 租户管理 ——
  'tenant:member:manage',
  'tenant:role:assign',
  'tenant:billing:view',
  'tenant:token:grant',

  // —— 报价 ——
  'quote:read',
  'quote:write',

  // —— 接单 ——
  'order:read',
  'order:write',

  // —— 内容发布 ——
  'publish:read',
  'publish:write',

  // —— AI 生成与素材库 ——
  'content:read',
  'content:generate',
  'content:extract',

  // —— 知识库 ——
  'knowledge:read',
  'knowledge:manage',

  // —— 反馈与客服 ——
  'cs:read',
  'cs:write',
] as const;

export type PermissionAction = (typeof PERMISSIONS)[number];

/**
 * 写权限隐含的读权限。
 *
 * 放在这里而不是散在各处：这是「二元切分」的配套规则，只应有一处定义。
 * 新增成对的读写权限时记得同步登记，否则写能过读却被拒。
 */
export const WRITE_IMPLIES_READ: Record<string, string> = {
  'quote:write': 'quote:read',
  'order:write': 'order:read',
  'publish:write': 'publish:read',
  'content:generate': 'content:read',
  'cs:write': 'cs:read',
};

/** 界面上权限 action 的人话说明与分组（按业务归类，不按技术前缀） */
export const PERMISSION_CATALOG: { action: PermissionAction; label: string; group: string }[] = [
  { action: 'quote:read', label: '查看报价与产品库', group: '报价' },
  { action: 'quote:write', label: '做报价、改产品库', group: '报价' },
  { action: 'order:read', label: '查看接单与客户跟进', group: '接单' },
  { action: 'order:write', label: '建单、改状态、加跟进', group: '接单' },
  { action: 'publish:read', label: '查看朋友圈/小红书素材', group: '内容' },
  { action: 'publish:write', label: '生成并发布文案与图文', group: '内容' },
  { action: 'content:read', label: '查看素材库与产物', group: '内容' },
  { action: 'content:generate', label: '生成方案与出图、生视频', group: '内容' },
  { action: 'content:extract', label: '内容提取与解析', group: '内容' },
  { action: 'knowledge:read', label: '查阅知识库', group: '知识库' },
  { action: 'knowledge:manage', label: '维护知识库', group: '知识库' },
  { action: 'cs:read', label: '查看反馈与工单', group: '协作' },
  { action: 'cs:write', label: '提交与处理反馈', group: '协作' },
  { action: 'tenant:member:manage', label: '管理团队成员', group: '团队' },
  { action: 'tenant:role:assign', label: '分配角色', group: '团队' },
  { action: 'tenant:token:grant', label: '发放额度', group: '团队' },
  { action: 'tenant:billing:view', label: '查看账单与额度', group: '团队' },
  { action: 'platform:billing:manage', label: '模型配置与数据备份', group: '平台' },
  { action: 'platform:audit:view', label: '查看操作审计', group: '平台' },
  { action: 'platform:tenant:manage', label: '管理租户', group: '平台' },
];
