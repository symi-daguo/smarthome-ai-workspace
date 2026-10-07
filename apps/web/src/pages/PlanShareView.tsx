import { Typography } from 'antd';
import { useEffect, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { planTheme, type PlanPage } from '../data/planThemes';
import { PlanSlide } from '../components/PlanSlide';

const { Text } = Typography;

interface SharePlan {
  title: string;
  customer: string;
  area: string;
  store: string;
  style: string;
  edition: string;
  versionNo: number;
  updatedAt: string;
  pages: PlanPage[];
  floorplanAssetId?: string | null;
  layoutPoints?: { name: string; category: string; x: number; y: number }[] | null;
}

/** 客户分享页：/share/plan/:token，无需登录微信直开；16:9 幻灯片画布逐页呈现（讲解稿不显示） */
export function PlanShareView(): ReactNode {
  const { token } = useParams<{ token: string }>();
  const [plan, setPlan] = useState<SharePlan | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    api<SharePlan>(`/api/public/plans/${token}`)
      .then(setPlan)
      .catch((e) => setError((e as Error).message || '方案不存在或已删除'));
  }, [token]);

  if (error) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F7F8F9' }}>
        <Text type="secondary">{error}</Text>
      </div>
    );
  }
  if (!plan) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F7F8F9' }}>
        <Text type="secondary">方案加载中…</Text>
      </div>
    );
  }

  const t = planTheme(plan.style);
  // 分享页户型底图走公开端点（凭 token 免鉴权）
  const slidePlan = {
    store: plan.store,
    floorplanUrl: plan.floorplanAssetId && token ? `/api/public/plans/${token}/floorplan` : null,
    layoutPoints: plan.layoutPoints ?? null,
  };

  return (
    <div className="plan-share-page" style={{ minHeight: '100vh', background: t.bg, padding: '24px 16px 64px' }}>
      <div className="plan-print-bar" style={{ maxWidth: 960, margin: '0 auto 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text strong style={{ color: t.text }}>{plan.title}</Text>
        <button
          onClick={() => window.print()}
          style={{ fontSize: 13, padding: '6px 16px', borderRadius: 9999, border: 'none', background: t.accent, color: '#fff', cursor: 'pointer' }}
        >
          保存为 PDF / 打印
        </button>
      </div>
      <div style={{ maxWidth: 960, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
        {plan.pages.map((p, i) => (
          <div key={i} style={{ boxShadow: '0 2px 16px rgba(0,0,0,.08)' }}>
            <PlanSlide page={p} index={i} plan={slidePlan} t={t} />
          </div>
        ))}
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <Text style={{ fontSize: 12, color: t.sub }}>
            本方案由 {plan.store || '智能家居服务商'} 使用智居 AI 工作台生成 · 文案版本 {plan.versionNo} · 实际配置与报价以门店方案师现场确认为准
          </Text>
        </div>
      </div>
    </div>
  );
}
