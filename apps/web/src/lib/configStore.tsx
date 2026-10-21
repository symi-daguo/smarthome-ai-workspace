/**
 * 工作台当前生效模型摘要：保存 / 启动 / 切换方案时刷新，UI 显示用。
 * 不存明文 Key，只暴露 provider + baseUrl + model + 标签
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';

export interface ActiveConfig {
  /** 当前激活的 ModelProfile 名称（无方案时为空） */
  profileName: string;
  /** 对话 baseUrl（前端展示用，发送消息时不依赖它） */
  chatBaseUrl: string;
  /** 对话模型名（发送时由 ChatStore 读取作为 model 字段） */
  chatModel: string;
  /** 生图 provider 摘要 */
  imageProvider: string;
  /** 当前生效的生图模型名（供生图页只读展示；不在前端切换，避免出现选了不生效的假控件） */
  imageModel: string;
  /** 生视频 provider 摘要 */
  videoProvider: string;
  /** 当前生效的生视频模型名（供音轨能力提示判断；供 Audio 支持检查） */
  videoModel: string;
  /** 对话 API Key 是否已配置（前端展示用，真实 Key 仅在后端） */
  chatKeyConfigured: boolean;
}

const DEFAULT: ActiveConfig = {
  profileName: '',
  chatBaseUrl: '',
  chatModel: '',
  imageProvider: 'MiniMax image-01',
  imageModel: '',
  videoProvider: 'MiniMax Director',
  videoModel: '',
  chatKeyConfigured: false,
};

interface ConfigStoreValue {
  config: ActiveConfig;
  refresh: () => Promise<void>;
}

const Ctx = createContext<ConfigStoreValue | null>(null);

export function ConfigProvider({ children }: { children: ReactNode }): ReactNode {
  const [config, setConfig] = useState<ActiveConfig>(DEFAULT);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [mc, profiles] = await Promise.all([
        api<{
          chat: { baseUrl: string; model: string; keyConfigured: boolean };
          image: { provider: string; model: string };
          video: { provider: string; model: string };
        }>('/api/admin/model-config'),
        api<{ name: string; active: boolean }[]>('/api/admin/model-config/profiles'),
      ]);
      const active = profiles.find((p) => p.active)?.name ?? '';
      // ponytail: 后端未锁定模型名时返回的是中文说明「（跟随请求，默认 MiniMax-M3.1-Flash）」而非模型名，
      // 直接透传会让上游 chat/completions 收到非法 model 报错；这里归一化为空串，由发送方回退默认模型
      const chatModel = /^[\w.\-:]+$/.test(mc.chat.model ?? '') ? mc.chat.model : '';
      setConfig({
        profileName: active,
        chatBaseUrl: mc.chat.baseUrl,
        chatModel,
        imageProvider: mc.image.provider,
        imageModel: mc.image.model ?? '',
        videoProvider: mc.video.provider,
        videoModel: mc.video.model ?? '',
        chatKeyConfigured: mc.chat.keyConfigured,
      });
    } catch {
      setConfig(DEFAULT);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return <Ctx.Provider value={{ config, refresh }}>{children}</Ctx.Provider>;
}

export function useActiveConfig(): ConfigStoreValue {
  const c = useContext(Ctx);
  if (!c) throw new Error('useActiveConfig must be used within ConfigProvider');
  return c;
}
