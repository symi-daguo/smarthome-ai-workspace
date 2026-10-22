/**
 * 当前工程上下文（哪个方案在干活）。
 *
 * 为什么要有它：
 * 百宝箱里的每个工具（生图、生视频、点位布置、灯光编排…）都是**独立页面**，
 * 各自有自己的输入与产物。但门店的真实工作流是「一个客户一个项目」：
 * 先接单 → 出方案 → 布点位 → 出效果图 → 出视频 → 出 PPT，
 * 这些产出**都属于同一个项目**。
 *
 * 没有工程上下文时，工具之间就是断的：生图出来的图不知道属于哪单，
 * 点位图不知道挂在哪个方案上，PPT 里也就只能塞方案页自己那几个素材。
 *
 * 存哪：localStorage。
 * 这是**当前正在做的活**的指针，不是业务数据 —— 换台电脑接着做，
 * 方案本身在服务端，指向它的指针跟着账号走就行（localStorage 存的是 planId）。
 * 选 localStorage 也避免为「当前选中项」引入新表与迁移。
 */

const CURRENT_PLAN_KEY = 'current_plan_id';

/** 变更广播：同标签页内切工程时，侧栏/工具页要能立刻感知 */
export const CURRENT_PLAN_EVENT = 'current-plan-changed';

/** 读当前工程 id（没有则空串） */
export function getCurrentPlanId(): string {
  try {
    return localStorage.getItem(CURRENT_PLAN_KEY) ?? '';
  } catch {
    return '';
  }
}

/** 设置当前工程（空串 = 取消归属） */
export function setCurrentPlanId(planId: string): void {
  try {
    if (planId) localStorage.setItem(CURRENT_PLAN_KEY, planId);
    else localStorage.removeItem(CURRENT_PLAN_KEY);
  } catch {
    // 隐私模式下 localStorage 可能不可写 —— 忽略即可，归属只是辅助信息
  }
  window.dispatchEvent(new Event(CURRENT_PLAN_EVENT));
}

/** 订阅当前工程变化 */
export function subscribeCurrentPlan(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent): void => {
    if (e.key === CURRENT_PLAN_KEY) onChange();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(CURRENT_PLAN_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(CURRENT_PLAN_EVENT, onChange);
  };
}
