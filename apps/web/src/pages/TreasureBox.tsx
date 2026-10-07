import { App as AntApp, Typography, theme } from 'antd';
import { useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';

const { Text, Title } = Typography;

interface ToolDef {
  key: string;
  name: string;
  desc: string;
  badge?: string;
  manual?: boolean;
  /** 点击跳转的路由；缺省表示该工具尚未上线 */
  to?: string;
  /** 跳转时携带的预填提示（进入工作台对话） */
  prompt?: string;
}

const GROUPS: { title: string; tools: ToolDef[] }[] = [
  {
    title: '内容获客',
    tools: [
      { key: 'copy-imitate', name: '文案仿写', desc: '贴一条爆款链接，产出你自己的脚本', badge: '3 张配图', to: '/', prompt: '帮我把这条爆款文案改写成我们门店的版本：' },
      { key: 'video-cover', name: '视频封面', desc: '照片+主题，一键出竖版封面', badge: '3 张配图', to: '/image' },
      { key: 'holiday-poster', name: '节假日海报', desc: '选节日+门店名，当天就能发', badge: '4 张配图', to: '/image' },
      { key: 'free-image', name: 'AI 自由生图', desc: '上传图片，一句话改图', to: '/image' },
      { key: 'xhs-image', name: '小红书生图', desc: '手绘平面图、设备清单图文', to: '/image' },
      { key: 'floorplan-poster', name: '户型方案长图', desc: '上传户型图，出竖版方案海报', to: '/plan' },
    ],
  },
  {
    title: '方案与设计',
    tools: [
      { key: 'colorplan', name: '平面图转彩平图', desc: '线框图秒变彩色平面', to: '/image' },
      { key: 'zone-render', name: '平面图生效果图', desc: '框选 1~4 个区域分别出图', to: '/image' },
      { key: 'bare-render', name: '毛坯房效果图', desc: '空房间直接出智能氛围图', to: '/image' },
      { key: 'wifi-heat', name: 'WiFi 热力图', desc: '拖拽设备，生成信号覆盖', to: '/device-layout?mode=wifi' },
      { key: 'device-layout', name: '智能设备点位布局', desc: '拖拽布点，导出图纸与设备清单', to: '/device-layout' },
      { key: 'light-plan', name: '灯光点位效果图', desc: '编辑灯带，导出高清灯光平面图', to: '/device-layout?mode=light' },
      { key: 'light-scene', name: '智能灯光场景演示', desc: '编排每盏灯时间轴，生成视频', to: '/video' },
    ],
  },
  {
    title: '产品中心',
    tools: [
      { key: 'product-lib', name: '公共库与我的库', desc: '上传产品，联动报价和点位', to: '/knowledge' },
      { key: 'quote', name: '智能报价', desc: '选品配单，自动算价导出报价单', to: '/quote' },
    ],
  },
  {
    title: '人工与定制服务',
    tools: [
      { key: 'geo', name: 'GEO 品宣代发', desc: '本地搜索品宣，人工运营', manual: true, badge: '人工服务' },
      { key: 'video-edit', name: '视频代剪', desc: '贴链接交剪辑师成片', manual: true, badge: '人工服务' },
      { key: 'custom-agent', name: '定制智能体', desc: '围绕你的业务专属打造', manual: true, badge: '人工服务', to: '/agents' },
      { key: 'feedback', name: '问题反馈', desc: '功能建议与故障申报', manual: true, badge: '人工服务' },
    ],
  },
];

/** 堆叠照片卡视觉（本地生成图，public/images/cases + materials） */
const STACK_IMGS = [
  '/images/cases/c2.jpg',
  '/images/cases/c3.jpg',
  '/images/cases/c4.jpg',
  '/images/cases/c5.jpg',
  '/images/cases/c1.jpg',
  '/images/materials/m1.jpg',
  '/images/materials/m2.jpg',
];

function StackedPreview({ img }: { img: string }): ReactNode {
  return (
    <div style={{ position: 'relative', height: 96, marginBottom: 14 }}>
      <div style={{ position: 'absolute', left: 8, top: 6, width: 120, height: 78, background: `url(${img}) center/cover`, opacity: 0.35, borderRadius: 10, transform: 'rotate(-6deg)' }} />
      <div style={{ position: 'absolute', left: 16, top: 3, width: 120, height: 78, background: `url(${img}) center/cover`, opacity: 0.6, borderRadius: 10, transform: 'rotate(3deg)' }} />
      <div style={{ position: 'absolute', left: 24, top: 0, width: 120, height: 78, background: `url(${img}) center/cover`, borderRadius: 10 }} />
    </div>
  );
}

export function TreasureBox(): ReactNode {
  const { message } = AntApp.useApp();
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const openTool = (t: ToolDef): void => {
    if (t.to) {
      navigate(t.to, t.prompt ? { state: { prompt: t.prompt } } : undefined);
    } else {
      message.info(`「${t.name}」${t.manual ? '为人工服务，请联系平台助理开通' : '正在开发中，将在后续版本上线'}`);
    }
  };

  return (
    <div style={{ paddingBottom: 24 }}>
      <Title level={3} style={{ marginBottom: 4 }}>智能百宝箱</Title>
      <Text type="secondary">按业务任务选择工具，生成记录与作品可随时找回</Text>

      {GROUPS.map((g, gi) => (
        <div key={g.title} style={{ marginTop: 26 }}>
          <Text strong style={{ fontSize: 15, display: 'block', marginBottom: 12 }}>{g.title}</Text>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: 14,
            }}
          >
            {g.tools.map((t, ti) => (
              <div
                key={t.key}
                role="button"
                tabIndex={0}
                onClick={() => openTool(t)}
                onKeyDown={(e) => e.key === 'Enter' && openTool(t)}
                style={{
                  background: token.colorBgContainer,
                  border: `1px solid ${token.colorBorderSecondary}`,
                  borderRadius: 14,
                  padding: '16px 16px 14px',
                  cursor: 'pointer',
                }}
              >
                <StackedPreview img={STACK_IMGS[(gi * 3 + ti) % STACK_IMGS.length]} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Text strong style={{ fontSize: 14.5 }}>{t.name}</Text>
                  {t.badge ? (
                    <span
                      style={{
                        fontSize: 11,
                        padding: '1px 8px',
                        borderRadius: 9999,
                        background: t.manual ? token.colorPrimaryBg : token.colorFillTertiary,
                        color: t.manual ? token.colorPrimary : token.colorTextSecondary,
                      }}
                    >
                      {t.badge}
                    </span>
                  ) : null}
                </div>
                <Text type="secondary" style={{ fontSize: 12.5, display: 'block', marginTop: 4 }}>
                  {t.desc}
                </Text>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
