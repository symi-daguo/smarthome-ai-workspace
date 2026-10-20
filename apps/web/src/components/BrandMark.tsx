import { ThunderboltFilled } from '@ant-design/icons';
import { theme } from 'antd';
import type { ReactNode } from 'react';

/** 品牌标识方块：纯色品牌紫底 + 闪电图形，明暗主题下由 token 自动派生 */
export function BrandMark({ size = 36 }: { size?: number }): ReactNode {
  const { token } = theme.useToken();
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: token.borderRadius,
        background: token.colorPrimary,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
      }}
    >
      <ThunderboltFilled style={{ color: '#ffffff', fontSize: size * 0.5 }} />
    </div>
  );
}
