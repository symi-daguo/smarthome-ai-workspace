import { HistoryOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Empty, Typography, theme } from 'antd';
import { useState, type ReactNode } from 'react';
import { BRAND_GRADIENT } from '../theme/tokens';

const { Text, Title } = Typography;

const STEPS = ['了解客户', '补充资料', '生成方案', '完整编辑', '客户方案'];

export function OrderStudio(): ReactNode {
  const { token } = theme.useToken();
  const [active, setActive] = useState<number | null>(null);
  const [history] = useState<{ key: string; name: string; stage: number }[]>([]);

  return (
    <div
      style={{
        display: 'flex',
        gap: 0,
        minHeight: 'calc(100vh - 57px)',
        background: token.colorBgLayout,
      }}
    >
      {/* 左窄栏 */}
      <aside
        style={{
          width: 220,
          flex: 'none',
          background: token.colorBgContainer,
          borderInlineEnd: `1px solid ${token.colorBorderSecondary}`,
          padding: '20px 14px',
        }}
      >
        <Text type="secondary" style={{ fontSize: 12 }}>开始接单</Text>
        <Title level={4} style={{ margin: '2px 0 16px' }}>开始接单</Title>
        <Button
          block
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setActive(0)}
          style={{ background: BRAND_GRADIENT, border: 'none', marginBottom: 18 }}
        >
          开始新接待
        </Button>
        {STEPS.map((s, i) => (
          <div
            key={s}
            role="button"
            tabIndex={0}
            onClick={() => setActive(i)}
            onKeyDown={(e) => e.key === 'Enter' && setActive(i)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '9px 8px',
              borderRadius: 8,
              cursor: 'pointer',
              background: active === i ? token.colorPrimaryBg : 'transparent',
            }}
          >
            <span
              style={{
                width: 22,
                height: 22,
                borderRadius: 11,
                background: active === i ? BRAND_GRADIENT : token.colorFillTertiary,
                color: active === i ? '#fff' : token.colorTextSecondary,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 12,
                fontWeight: 600,
                flex: 'none',
              }}
            >
              {i + 1}
            </span>
            <Text style={{ fontSize: 13.5 }}>{s}</Text>
          </div>
        ))}
        <div style={{ marginTop: 20, borderTop: `1px solid ${token.colorBorderSecondary}`, paddingTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text type="secondary" style={{ fontSize: 13 }}>历史方案</Text>
            <Button size="small" type="text" icon={<ReloadOutlined />}>刷新</Button>
          </div>
          {history.length === 0 ? (
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>暂无历史接待</Text>
          ) : null}
        </div>
      </aside>

      {/* 右内容区 */}
      <main style={{ flex: 1, padding: 24, minWidth: 0 }}>
        <Alert
          type="warning"
          showIcon
          message="接待工作台完整版（客户档案→方案交付闭环）将在 0.3.0 接入报价与工单系统后上线"
          style={{ marginBottom: 20 }}
        />
        <div
          style={{
            background: token.colorBgContainer,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: 16,
            minHeight: 420,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Text type="secondary">
                {active === null ? '点击「开始新接待」，按 5 步从客户需求走到方案交付' : `当前步骤：${STEPS[active]}（向导逻辑 0.3.0 接入）`}
              </Text>
            }
          />
        </div>
      </main>
    </div>
  );
}
