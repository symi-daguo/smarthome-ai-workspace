import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, tokenStore } from '../lib/api';

export interface Membership {
  tenantId: string;
  tenantName: string;
  plan: string;
  roleKey: string;
  permissions: string[];
}

export interface UserProfile {
  id: string;
  phone: string;
  displayName: string;
  avatarColor?: string | null;
  /** 头像图片 URL；空串=回退到底色+首字 */
  avatarUrl?: string;
  /** 当前生效租户（服务端 TenantGuard 写入；前端只读，用于取租户名） */
  activeTenantId?: string;
  memberships: Membership[];
}

interface AuthContextValue {
  user: UserProfile | null;
  loading: boolean;
  login: (phone: string, password: string) => Promise<void>;
  register: (input: { phone: string; password: string; displayName: string; tenantName?: string }) => Promise<void>;
  logout: () => void;
  /** 重新拉取 /api/auth/me（个人设置保存后刷新头像色/昵称） */
  refresh: () => Promise<void>;
  /** 刷新 JWT 令牌（延长有效期，避免过期丢会话；成功返回 true） */
  renewToken: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function fetchMe(): Promise<UserProfile | null> {
  if (!tokenStore.get()) return null;
  try {
    return await api<UserProfile>('/api/auth/me');
  } catch {
    tokenStore.clear();
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void fetchMe().then((profile) => {
      setUser(profile);
      setLoading(false);
    });
  }, []);

  const login = useCallback(async (phone: string, password: string) => {
    const result = await api<{ token: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ phone, password }),
    });
    tokenStore.set(result.token);
    const profile = await fetchMe();
    setUser(profile);
    if (!profile) throw new Error('登录后获取用户信息失败');
  }, []);

  const register = useCallback(
    async (input: { phone: string; password: string; displayName: string; tenantName?: string }) => {
      const result = await api<{ token: string }>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      tokenStore.set(result.token);
      const profile = await fetchMe();
      setUser(profile);
      if (!profile) throw new Error('注册后获取用户信息失败');
    },
    [],
  );

  const logout = useCallback(() => {
    tokenStore.clear();
    setUser(null);
  }, []);

  const refresh = useCallback(async () => {
    setUser(await fetchMe());
  }, []);

  const renewToken = useCallback(async (): Promise<boolean> => {
    const old = tokenStore.get();
    if (!old) return false;
    try {
      const r = await api<{ token: string }>('/api/auth/refresh', { method: 'POST' });
      tokenStore.set(r.token);
      return true;
    } catch {
      return false;
    }
  }, []);

  // JWT exp 临期（<2 天）自动续期：会话不因令牌过期而丢失
  useEffect(() => {
    if (!user) return;
    const check = (): void => {
      const t = tokenStore.get();
      if (!t) return;
      try {
        const payload = JSON.parse(atob(t.split('.')[1] ?? '')) as { exp?: number };
        if (payload.exp && payload.exp * 1000 - Date.now() < 2 * 86_400_000) void renewToken();
      } catch {
        // token 结构异常不处理，下次请求自然触发重新登录
      }
    };
    check();
    const timer = window.setInterval(check, 6 * 3600_000);
    return () => window.clearInterval(timer);
  }, [user, renewToken]);

  return <AuthContext.Provider value={{ user, loading, login, register, logout, refresh, renewToken }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
