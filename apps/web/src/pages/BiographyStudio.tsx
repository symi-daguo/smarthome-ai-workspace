import { PlusOutlined, ReadOutlined } from '@ant-design/icons';
import { Button, Typography, theme } from 'antd';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { BRAND_GRADIENT } from '../theme/tokens';

const { Text, Title } = Typography;

interface IpProfile {
  key: string;
  name: string;
  stage: string;
}

const WAYS = ['真人对话式专访', '边聊边记', '聊够一半成稿'];

export function BiographyStudio(): ReactNode {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const [profiles] = useState<IpProfile[]>([]);

  const startInterview = (): void => {
    navigate('/', { state: { agent: '你的专属传记智能体', prompt: '我想做一次人物专访，请像老朋友一样一句一句采访我，把我的起点、转折和信念写成一篇人物志。' } });
  };

  return (
    <div style={{ minHeight: 'calc(100vh - 57px)', background: token.colorBgLayout, padding: '48px 24px' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', textAlign: 'center' }}>
        <Text type="secondary" style={{ fontSize: 13, letterSpacing: 2 }}>智居 AI 工作台</Text>

        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            marginTop: 40,
            padding: '5px 14px',
            borderRadius: 9999,
            background: token.colorPrimaryBg,
            color: token.colorPrimary,
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          ● 专属人物专访
        </div>

        <Title level={1} style={{ fontSize: 48, fontWeight: 800, margin: '14px 0 18px' }}>为你立传</Title>
        <Text type="secondary" style={{ fontSize: 16, lineHeight: 1.9, display: 'block', maxWidth: 560, margin: '0 auto' }}>
          别人用简介介绍自己，你值得一篇专访。
          <br />
          像老朋友一样一句一句采访你，把你的起点、坎和信念，写成一篇属于你的人物志。
        </Text>

        {/* 输入卡 */}
        <div
          role="button"
          tabIndex={0}
          onClick={startInterview}
          onKeyDown={(e) => e.key === 'Enter' && startInterview()}
          style={{
            margin: '30px auto 0',
            maxWidth: 480,
            background: token.colorBgContainer,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: 16,
            padding: '14px 18px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            textAlign: 'left',
            cursor: 'pointer',
          }}
        >
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 10,
              background: BRAND_GRADIENT,
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 18,
              flex: 'none',
            }}
          >
            <PlusOutlined />
          </div>
          <div>
            <Text strong style={{ display: 'block' }}>开始一次专访</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>边聊边记，聊够自动成稿</Text>
          </div>
        </div>

        {/* 主按钮组 */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginTop: 22, flexWrap: 'wrap' }}>
          <Button
            size="large"
            onClick={startInterview}
            style={{ background: BRAND_GRADIENT, border: 'none', color: '#fff', fontWeight: 600, minWidth: 220 }}
          >
            新建 / 导入个人 IP 档案 →
          </Button>
          <Button size="large" icon={<PlusOutlined />} style={{ borderRadius: 10 }} onClick={startInterview}>
            新建 / 导入个人 IP 档案
          </Button>
        </div>

        {/* 方式 chip */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginTop: 16 }}>
          {WAYS.map((w) => (
            <span
              key={w}
              style={{
                fontSize: 12.5,
                padding: '5px 14px',
                borderRadius: 9999,
                background: token.colorFillQuaternary,
                border: `1px solid ${token.colorBorderSecondary}`,
                color: token.colorTextSecondary,
              }}
            >
              {w}
            </span>
          ))}
        </div>

        {/* 我的 IP 档案 */}
        <div style={{ marginTop: 44, textAlign: 'left' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <Text strong>我的个人 IP 档案</Text>
            <a style={{ fontSize: 13 }}>查看历史对话记录 →</a>
          </div>
          {profiles.length === 0 ? (
            <div
              style={{
                background: token.colorBgContainer,
                border: `1px dashed ${token.colorBorder}`,
                borderRadius: 14,
                padding: '28px 20px',
                textAlign: 'center',
              }}
            >
              <ReadOutlined style={{ fontSize: 26, color: token.colorTextQuaternary }} />
              <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 13 }}>
                还没有档案。做一次专访，之后所有短视频脚本、直播话术都会引用它——做过的，不用再做一遍。
              </Text>
            </div>
          ) : (
            profiles.map((p) => (
              <div
                key={p.key}
                style={{
                  background: token.colorBgContainer,
                  border: `1px solid ${token.colorBorderSecondary}`,
                  borderRadius: 14,
                  padding: '14px 18px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <Text strong style={{ flex: 1 }}>{p.name}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>{p.stage}</Text>
                <Button size="small">查看 / 继续</Button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
