import { ThunderboltFilled } from '@ant-design/icons';
import { theme } from 'antd';
import type { ReactNode } from 'react';

/**
 * 品牌标识方块：纯色品牌紫底 + 闪电图形，明暗主题下由 token 自动派生。
 *
 * `logoUrl` 非空时改用部署者自己的图标（`BRAND_LOGO_URL`）：
 * 图标是对方的，底色与圆角不该由本项目替他决定 —— 所以直接给原图，
 * 不套色块。留空（默认）则沿用上面这个自带标识，视觉零变化。
 */
export function BrandMark({ size = 36, logoUrl }: { size?: number; logoUrl?: string }): ReactNode {
  const { token } = theme.useToken();
  if (logoUrl) {
    return (
      <img
        src={logoUrl}
        alt=""
        width={size}
        height={size}
        style={{
          borderRadius: token.borderRadius,
          display: 'block',
          flex: 'none',
          objectFit: 'contain',
        }}
      />
    );
  }
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
