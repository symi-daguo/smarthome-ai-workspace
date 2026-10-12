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
  /** 卡片预览图：必须与工具语义对应（public/images/tools/，按工具逐一生成） */
  img: string;
  /** 点击跳转的路由；缺省表示该工具尚未上线 */
  to?: string;
  /** 跳转时携带的预填提示（进入工作台对话） */
  prompt?: string;
}

const GROUPS: { title: string; tools: ToolDef[] }[] = [
  {
    title: '内容获客',
    tools: [
      { key: 'copy-imitate', img: '/images/tools/tool-copy-imitate.jpg', name: '文案仿写', desc: '贴一条爆款链接，产出你自己的脚本', badge: '3 张配图', to: '/', prompt: '帮我把这条爆款文案改写成我们门店的版本：' },
      { key: 'video-cover', img: '/images/tools/tool-video-cover.jpg', name: '视频封面', desc: '照片+主题，一键出竖版封面', badge: '3 张配图', to: '/image' },
      { key: 'holiday-poster', img: '/images/tools/tool-holiday-poster.jpg', name: '节假日海报', desc: '选节日+门店名，当天就能发', badge: '4 张配图', to: '/image' },
      { key: 'free-image', img: '/images/tools/tool-free-image.jpg', name: 'AI 自由生图', desc: '上传图片，一句话改图', to: '/image' },
      { key: 'xhs-image', img: '/images/tools/tool-xhs-image.jpg', name: '小红书生图', desc: '手绘平面图、设备清单图文', to: '/image' },
      { key: 'floorplan-poster', img: '/images/tools/tool-floorplan-poster.jpg', name: '户型方案长图', desc: '上传户型图，出竖版方案海报', to: '/plan' },
    ],
  },
  {
    title: '方案与设计',
    tools: [
      { key: 'colorplan', img: '/images/tools/tool-colorplan.jpg', name: '平面图转彩平图', desc: '线框图秒变彩色平面', to: '/image' },
      { key: 'zone-render', img: '/images/tools/tool-zone-render.jpg', name: '平面图生效果图', desc: '框选 1~4 个区域分别出图', to: '/image' },
      { key: 'bare-render', img: '/images/tools/tool-bare-render.jpg', name: '毛坯房效果图', desc: '空房间直接出智能氛围图', to: '/image' },
      { key: 'wifi-heat', img: '/images/tools/tool-wifi-heat.jpg', name: 'WiFi 热力图', desc: '拖拽设备，生成信号覆盖', to: '/device-layout?mode=wifi' },
      { key: 'device-layout', img: '/images/tools/tool-device-layout.jpg', name: '智能设备点位布局', desc: '拖拽布点，导出图纸与设备清单', to: '/device-layout' },
      { key: 'light-plan', img: '/images/tools/tool-light-plan.jpg', name: '灯光点位效果图', desc: '编辑灯带，导出高清灯光平面图', to: '/device-layout?mode=light' },
      { key: 'light-scene', img: '/images/tools/tool-light-scene.jpg', name: '智能灯光场景演示', desc: '上传效果图，手工编排每盏灯的时间轴并生成视频', to: '/lighting' },
    ],
  },
  {
    title: '产品中心',
    tools: [
      { key: 'product-lib', img: '/images/tools/tool-product-lib.jpg', name: '公共库与我的库', desc: '上传产品，联动报价和点位', to: '/products' },
      { key: 'quote', img: '/images/tools/tool-quote.jpg', name: '智能报价', desc: '选品配单，自动算价导出报价单', to: '/quote' },
    ],
  },
  {
    title: '人工与定制服务',
    tools: [
      { key: 'geo', img: '/images/tools/tool-geo.jpg', name: 'GEO 品宣代发', desc: '本地搜索品宣，人工运营', manual: true, badge: '人工服务' },
      { key: 'video-edit', img: '/images/tools/tool-video-edit.jpg', name: '视频代剪', desc: '贴链接交剪辑师成片', manual: true, badge: '人工服务' },
      { key: 'custom-agent', img: '/images/tools/tool-custom-agent.jpg', name: '定制智能体', desc: '打造你专属的 AI 智能体', to: '/agents' },
      { key: 'feedback', img: '/images/tools/tool-feedback.jpg', name: '问题反馈', desc: '用着遇到问题？提交反馈，我们尽快排查处理', to: '/feedback' },
    ],
  },
];

/**
 * 堆叠照片卡：三层错位叠放同一张语义图，整体居中。
 * 三层取景位置不同（background-position），避免「同一张图原样重复三次」的廉价感。
 * 角标压在图片右下角（对齐参考站），不挤占标题行。
 */
const STACK_LAYERS = [
  { dx: -44, dy: 6, rot: -6, opacity: 0.4, pos: '26% 32%' },
  { dx: -22, dy: 3, rot: 3, opacity: 0.66, pos: '64% 56%' },
  { dx: 0, dy: 0, rot: 0, opacity: 1, pos: '50% 48%' },
] as const;
const CARD_W = 196;
const CARD_H = 128;

function StackedPreview({
  img,
  alt,
  badge,
  manual,
  accent,
  accentText,
}: {
  img: string;
  alt: string;
  badge?: string;
  manual?: boolean;
  accent: string;
  accentText: string;
}): ReactNode {
  return (
    <div style={{ position: 'relative', height: 134, marginBottom: 12, display: 'flex', justifyContent: 'center' }}>
      {STACK_LAYERS.map((l, i) => (
        <div
          key={i}
          role="img"
          aria-label={i === 2 ? `${alt}示意图` : undefined}
          aria-hidden={i === 2 ? undefined : true}
          style={{
            position: 'absolute',
            left: `calc(50% - ${CARD_W / 2}px + ${l.dx}px)`,
            top: l.dy,
            width: CARD_W,
            height: CARD_H,
            background: `url(${img}) ${l.pos} / cover`,
            opacity: l.opacity,
            borderRadius: 12,
            transform: `rotate(${l.rot}deg)`,
            boxShadow: i === 2 ? '0 4px 14px rgba(0,0,0,.12)' : 'none',
          }}
        />
      ))}
      {badge ? (
        <span
          style={{
            position: 'absolute',
            right: `calc(50% - ${CARD_W}px + 6px)`,
            bottom: 6,
            fontSize: 11,
            padding: '1px 8px',
            borderRadius: 9999,
            background: manual ? accent : 'rgba(0,0,0,.55)',
            color: manual ? accentText : '#fff',
          }}
        >
          {badge}
        </span>
      ) : null}
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
    <div style={{ width: '100%', paddingBottom: 24 }}>
      <Title level={3} style={{ marginBottom: 4 }}>智能百宝箱</Title>
      <Text type="secondary">按业务任务选择工具，生成记录与作品可随时找回</Text>

      {GROUPS.map((g) => (
        <div key={g.title} style={{ marginTop: 26 }}>
          <Text strong style={{ fontSize: 15, display: 'block', marginBottom: 12 }}>{g.title}</Text>
          <div
            style={{
              display: 'grid',
              // 对齐参考站：宽屏每行 4 张，卡片留白更从容
              gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
              gap: 16,
            }}
          >
            {g.tools.map((t) => (
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
                  padding: '12px 12px 14px',
                  cursor: 'pointer',
                }}
              >
                <StackedPreview img={t.img} alt={t.name} badge={t.badge} manual={t.manual} accent={token.colorPrimaryBg} accentText={token.colorPrimary} />
                <Text strong style={{ fontSize: 14.5, display: 'block' }}>
                  {t.name}
                </Text>
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
