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

  return <AuthContext.Provider value={{ user, loading, login, register, logout, refresh }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
