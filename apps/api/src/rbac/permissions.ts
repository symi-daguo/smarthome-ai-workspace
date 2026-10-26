/**
 * 权限 action 全集。
 *
 * 命名约定：`<资源>:<动词>`，动词只有 read / write 两档 ——
 * `resource.read` / `resource.write` 二元切分是这类系统的通行做法（BSD-3-Clause，许可证已核实）。
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
 *
 * **不列「没有对应动作」的权限**：
 *   publish:read / publish:write
 *                        「朋友圈/小红书」不是一个独立板块，只是预置 Agent 人设 + 生图工具入口，
 *                        能力已被 content:read / content:generate 覆盖。留着一个勾了没用的权限项，
 *                        比没有更误导用户（界面显示「可用」，实际什么都不影响）。
 *   platform:tenant:manage
 *                        后端零路由。开源自部署时它被降级成 tenant:member:manage
 *                        （见 agent.controller.ts 的说明），留着就是个空壳。
 * 这两条已从本清单、seed、前端名表与数据库里一并清掉。
 */
export const PERMISSIONS = [
  // —— 平台级 ——
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

  // —— AI 生成与产物库 ——
  'content:read',
  'content:generate',
  'content:extract',

  // —— 知识库 ——
  'knowledge:read',
  'knowledge:manage',

  // —— 对标账号情报 ——
  'benchmark:read',
  'benchmark:write',

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
  'content:generate': 'content:read',
  'cs:write': 'cs:read',
  'benchmark:write': 'benchmark:read',
};

/**
 * 权限 action 的人话说明与分组（按业务归类，不按技术前缀）**放在前端**
 * （apps/web/src/pages/TeamPage.tsx）—— 后端只管 action 本身与校验，
 * 不再维护一份平行的中文名表：两份表并存时，漏改一处就会出现
 * 「界面显示的权限名与实际生效的 action 对不上」，而两边都不报错。
 */
