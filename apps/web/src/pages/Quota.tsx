import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Card, Col, Row, Space, Tag, Typography } from 'antd';
import { CheckCircleFilled, RocketOutlined } from '@ant-design/icons';
import { useAuth } from '../store/AuthContext';
import { PageHeader } from '../components/PageHeader';
import { pageContainerStyle } from '../theme/tokens';

const { Text, Paragraph, Title } = Typography;

/**
 * 额度说明（页名原为 Vip，已改中性名：免费开源项目不该挂「会员」二字）：
 * 本项目开源免费给伙伴们自部署，按「注册即租户管理员、默认最高权限」设计，
 * 所有能力开箱即用、无需开通。因此本页不售卖套餐，只说清楚三件事：
 * 你现在有什么权限、额度怎么算、什么时候需要联系官方。
 */

const CAPABILITIES: { group: string; items: string[] }[] = [
  {
    group: 'AI 能力',
    items: [
      '通用对话智能体与 12 个预置智能体（文案 / 脚本 / 传记 / 直播稿）',
      'AI 生图：自由生图 + 毛坯房效果图 / 视频封面 / 节假日海报 / 平面图转彩平图',
      'AI 生视频：首帧图生视频，支持 MiniMax Director 与 OpenAI Sora 切换',
      '智能方案生成：9 页原生可编辑 PPTX + 完整讲稿 + 免登录分享链接',
    ],
  },
  {
    group: '方案与设计',
    items: [
      '智能百宝箱 20 个工具入口',
      '设备点位布置：布点 → 导出图纸 PNG / 设备清单 CSV',
      '智能灯光场景编排：灯具编排 + 手工时间轴 → 出片',
      'WiFi 信号热力图、灯光点位效果图',
      '智能报价：选品配单、区间算价、多级返利、报价单导出',
    ],
  },
  {
    group: '协作与治理',
    items: [
      '多租户与细粒度 RBAC（超管 / 租户管理员 / 设计师 / 运营 / 只读）',
      '团队共享额度，个人对话与资料互相隔离',
      '统一 token 额度账本，发放与消耗全留痕',
      '全库 JSON 备份导出 + 产物占用统计与清理',
    ],
  },
];

export function Quota(): ReactNode {
  const navigate = useNavigate();
  const { user } = useAuth();
  const plan = user?.memberships[0]?.plan;

  return (
    <div style={pageContainerStyle}>
      <PageHeader
        title="开源说明与额度"
        description="本项目开源免费自部署，注册即拥有全部能力，无需开通任何套餐"
        extra={<Button onClick={() => navigate('/tokens')}>查看我的额度</Button>}
      />

      <Alert
        type="success"
        showIcon
        icon={<CheckCircleFilled />}
        style={{ marginBottom: 20 }}
        message="你已解锁全部能力"
        description={
          <Space direction="vertical" size={4}>
            <Text>
              开源自部署默认把注册用户设为<strong>租户管理员</strong>，具备本部署的全部功能权限
              {plan ? <>（部署档位：<Tag style={{ marginInlineEnd: 0 }}>{plan}</Tag>）</> : null}。
              模型配置、额度发放、成员管理均可自助操作，无需联系任何人开通。
            </Text>
            <Text type="secondary">
              额度只约束「调用模型消耗 token」这一件事；本平台不预设商业定价，按你自己的模型成本自行设置。
            </Text>
          </Space>
        }
      />

      <Row gutter={[16, 16]}>
        {CAPABILITIES.map((c) => (
          <Col key={c.group} xs={24} lg={8}>
            <Card title={c.group} style={{ height: '100%' }} styles={{ body: { paddingTop: 8 } }}>
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                {c.items.map((item) => (
                  <Space key={item} align="start" size={8}>
                    <CheckCircleFilled style={{ color: '#52C41A', marginTop: 3 }} />
                    <Text style={{ fontSize: 13, lineHeight: 1.7 }}>{item}</Text>
                  </Space>
                ))}
              </Space>
            </Card>
          </Col>
        ))}
      </Row>

      <Card title="什么时候需要联系官方" style={{ marginTop: 20 }}>
        <Space direction="vertical" size={10}>
          <Paragraph type="secondary" style={{ margin: 0 }}>
            自部署本身不收费。以下情形如果你需要，可以找我们协助：
          </Paragraph>
          <Row gutter={[12, 12]}>
            {[
              { t: '需要我们代运维', d: '服务器部署、数据库迁移、备份恢复、域名与 HTTPS 配置。' },
              { t: '需要定制开发', d: 'GEO 品宣代发、视频代剪、投流素材等人工服务类需求。' },
              { t: '需要发票与合同', d: '企业主体采购发票、合作签约等。' },
            ].map((x) => (
              <Col key={x.t} xs={24} md={8}>
                <Card size="small" style={{ height: '100%' }} styles={{ body: { padding: 14 } }}>
                  <Title level={5} style={{ margin: '0 0 6px', fontSize: 14 }}>
                    <RocketOutlined style={{ marginInlineEnd: 6, color: '#5B5BF0' }} />
                    {x.t}
                  </Title>
                  <Text type="secondary" style={{ fontSize: 13 }}>{x.d}</Text>
                </Card>
              </Col>
            ))}
          </Row>
          <Text type="secondary" style={{ fontSize: 12 }}>
            一个公司可开通多个员工账号，共享额度与能力，个人对话与资料相互隔离。
          </Text>
        </Space>
      </Card>
    </div>
  );
}