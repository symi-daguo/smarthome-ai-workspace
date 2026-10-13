import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { theme as antdTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { XProvider } from '@ant-design/x';
import zhCNX from '@ant-design/x/locale/zh_CN';

export type ThemeMode = 'auto' | 'light' | 'dark';

const THEME_STORAGE_KEY = 'theme_mode';

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: 'light' | 'dark';
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function readStoredMode(): ThemeMode {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  return stored === 'light' || stored === 'dark' || stored === 'auto' ? stored : 'auto';
}

export function ThemeProvider({ children }: { children: ReactNode }): ReactNode {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    localStorage.setItem(THEME_STORAGE_KEY, next);
  }, []);

  const resolved: 'light' | 'dark' = mode === 'auto' ? (systemDark ? 'dark' : 'light') : mode;

  const value = useMemo(() => ({ mode, resolved, setMode }), [mode, resolved, setMode]);

  return (
    <ThemeContext.Provider value={value}>
      <XProvider
        locale={{ ...zhCNX, ...zhCN }}
        theme={{
          algorithm: resolved === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
          token: {
            // 品牌主色：靛蓝系（比对标站的亮紫更沉更冷），明暗两套由算法自动派生
            colorPrimary: '#4F46E5',
            // 转角比常规 SaaS 更圆一档，配合自有阴影形成独立的视觉语言
            borderRadius: 12,
            fontFamily:
              "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
          },
          components: {
            Card: {
              // 自有两级阴影：低对比细边 + 冷调投影（不用中性黑灰，避免偏灰发脏）
              boxShadowTertiary: '0 1px 2px rgba(28, 27, 46, .04), 0 4px 16px rgba(28, 27, 46, .06)',
            },
            Menu: {
              // 浅色侧栏菜单：选中项品牌紫浅底（取自 colorPrimaryBg 语义色，暗色自动适配）
              itemBg: 'transparent',
              subMenuItemBg: 'transparent',
            },
          },
        }}
      >
        {children}
      </XProvider>
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within ThemeProvider');
  return context;
}
