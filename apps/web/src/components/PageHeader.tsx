import { Typography } from 'antd';
import type { ReactNode } from 'react';

const { Title, Paragraph } = Typography;

export function PageHeader({ title, description, extra }: { title: string; description?: string; extra?: ReactNode }): ReactNode {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 16,
        flexWrap: 'wrap',
        marginBottom: 20,
      }}
    >
      <div>
        <Title level={4} style={{ margin: 0 }}>
          {title}
        </Title>
        {description ? (
          <Paragraph type="secondary" style={{ margin: '6px 0 0' }}>
            {description}
          </Paragraph>
        ) : null}
      </div>
      {extra ? <div style={{ flex: 'none' }}>{extra}</div> : null}
    </div>
  );
}
