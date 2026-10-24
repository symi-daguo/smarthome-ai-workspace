/**
 * 侧栏功能可见性配置。
 *
 * 为什么要有这个模块（用户诉求的落点）：
 * 「所有功能先全部恢复默认可见，再由每个客户在设置里自己决定显示哪些侧栏入口」。
 * 之前是把入口直接注释掉 —— 那是把「功能有没有」和「默认显不显示」混成了一件事，
 * 导致功能本身消失。现在拆开：**功能全在，可见性由配置决定，默认全开**。
 *
 * 存储选 localStorage 而非后端，理由：
 * 1. 这是纯界面偏好，不是业务数据 —— 同一个账号在门店大屏与笔记本上想显示的东西本来就可能不同；
 * 2. 不引新表、不加接口、不动迁移 —— 决策阶梯里 YAGNI 排第一；
 * 3. 开源自部署场景里，部署者改配置时不需要跑数据库迁移。
 *
 * 契约：
 * - **默认全开**：localStorage 里没有记录时，所有入口都显示；
 * - 记录里只存「被隐藏的 key」，新增入口不需要动任何已存配置（老配置自动兼容）；
 * - 改配置后广播事件，侧栏即时重渲染（同一个标签页不触发 storage 事件）。
 */

const HIDDEN_KEY = 'sidebar_hidden';

/** 同一标签页内的变更广播（storage 事件不跨标签页） */
export const SIDEBAR_EVENT = 'sidebar-visibility-changed';

function readHidden(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === 'string'));
  } catch {
    // 存的不是合法 JSON（比如手改坏了）—— 退回默认全开，不让侧栏整个渲染不出来
    return new Set();
  }
}

function writeHidden(hidden: Set<string>): void {
  localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden]));
  window.dispatchEvent(new Event(SIDEBAR_EVENT));
}

/** 当前被隐藏的入口 key 集合 */
export function getHiddenSidebarKeys(): Set<string> {
  return readHidden();
}

/**
 * 设置某个入口的可见性。
 * @param key 入口标识
 * @param visible true = 显示（从隐藏集合里移除）
 */
export function setSidebarVisible(key: string, visible: boolean): void {
  const hidden = readHidden();
  if (visible) hidden.delete(key);
  else hidden.add(key);
  writeHidden(hidden);
}

/** 恢复默认：全部显示 */
export function resetSidebarVisibility(): void {
  writeHidden(new Set());
}

/** 订阅可见性变化（跨标签页 + 同标签页自定义事件） */
export function subscribeSidebarVisibility(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent): void => {
    if (e.key === HIDDEN_KEY) onChange();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(SIDEBAR_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(SIDEBAR_EVENT, onChange);
  };
}
