import { useSyncExternalStore } from 'react';
import { api } from './api';

/**
 * 部署级品牌（产品名 + 图标）。
 *
 * **为什么单独一个模块**：品牌名与图标要在**登录前**就显示（登录页、浏览器标题），
 * 所以不能走登录后的租户接口，得由后端的公开端点给（`GET /api/public/branding`）。
 *
 * **为什么用模块级 store 而不是 Context**：消费点分散在登录页、侧栏、PPTX 导出、
 * 分享页四處，其中 PPTX 导出还不是组件 —— Context 进不去。
 * 一个模块级 store + `useSyncExternalStore` 全都覆盖，且不用多包一层 Provider。
 *
 * **为什么不用构建期注入**（`import.meta.env`）：那是打包时定死的，
 * 部署者改个品牌名就得重新构建镜像或重打安装包；环境变量改完重启就生效。
 */
export interface Branding {
  /** 产品名 */
  name: string;
  /** 图标地址（站内路径或完整 URL） */
  logoUrl: string;
}

const DEFAULT_NAME = '智能家居 AI 工作台';

let state: Branding = { name: DEFAULT_NAME, logoUrl: '' };
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

/** 品牌落到浏览器自身：标题与 favicon */
function applyToDocument(b: Branding): void {
  document.title = b.name;
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (icon) icon.href = b.logoUrl;
}

/**
 * 启动时拉一次品牌信息。
 *
 * 失败就用默认品牌继续跑：品牌配置不该让界面起不来，
 * 也不该让登录页卡在空白上（这条请求失败不该阻塞首屏渲染）。
 */
export async function loadBranding(): Promise<void> {
  try {
    const res = await api<Branding>('/api/public/branding', { timeoutMs: 5000 });
    state = {
      name: res.name?.trim() || DEFAULT_NAME,
      logoUrl: res.logoUrl?.trim() || '',
    };
    applyToDocument(state);
    emit();
  } catch {
    // 保持默认品牌
  }
}

/** 读当前品牌（不需要订阅变化的场合用，比如 PPTX 导出） */
export function getBranding(): Branding {
  return state;
}

/** 订阅品牌变化（组件用） */
export function useBranding(): Branding {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => state,
    () => state,
  );
}
