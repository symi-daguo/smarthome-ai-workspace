import { Typography, theme } from 'antd';
import { useEffect, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { planTheme, type PlanPage } from '../data/planThemes';
import { PlanSlide } from '../components/PlanSlide';
import { deliverPages, floorplanListPageNo, quoteListPageNo, type QuoteSummary } from '../lib/planPages';

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
  renderedFloorplanAssetId?: string | null;
  layoutPoints?: { name: string; category: string; room?: string; x: number; y: number }[] | null;
  /** 设备清单与报价（服务端算好：真实点位 + 产品库参考零售价） */
  quoteSummary?: QuoteSummary | null;
  /** 交付模版（分享页必须与交付 PPT 同模版，否则客户看到的和收到手的不一样） */
  floorplanTemplate?: string | null;
  markerTemplate?: string | null;
  /** 门店挂进来的场景视频（最多 2 条），走公开流内联播放 */
  videoAssetIds?: string[];
  /** 视频标题（与 videoAssetIds 同序），用于视频下方说明 */
  videoTitles?: string[];
}

/** 客户分享页：/share/plan/:token，无需登录微信直开；16:9 幻灯片画布逐页呈现（讲解稿不显示） */
export function PlanShareView(): ReactNode {
  const { token } = useParams<{ token: string }>();
  const { token: tk } = theme.useToken();
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
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: tk.colorBgLayout }}>
        <Text type="secondary">{error}</Text>
      </div>
    );
  }
  if (!plan) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: tk.colorBgLayout }}>
        <Text type="secondary">方案加载中…</Text>
      </div>
    );
  }

  const t = planTheme(plan.style);
  // 分享页户型底图走公开端点（凭 token 免鉴权）
  const slidePlan = {
    store: plan.store,
    floorplanUrl: plan.floorplanAssetId && token ? `/api/public/plans/${token}/floorplan` : null,
    renderedFloorplanUrl: plan.renderedFloorplanAssetId && token ? `/api/public/plans/${token}/rendered-floorplan` : null,
    layoutPoints: plan.layoutPoints ?? null,
    floorplanTemplate: plan.floorplanTemplate ?? null,
    markerTemplate: plan.markerTemplate ?? null,
    quoteSummary: plan.quoteSummary ?? null,
  };

  const videoCount = Math.min(plan.videoAssetIds?.length ?? 0, 2);
  const videoTitles = plan.videoTitles ?? [];

  // 有户型图素材时补一页「户型与设备点位」：户型图算成独立页。
  // 点位清单续页也要补，否则分享页比交付 PPT 少页 —— 客户在手机上看到的
  // 和收到手的对不上，会以为漏发内容。
  // 页序走 planPages.deliverPages：PPTX / 讲稿 / 分享页共用同一份，
  // 这里自己再写一遍插页逻辑，改一处忘另一处就会静默错位。
  const shown = (() => {
    const r = deliverPages({
      pages: plan.pages,
      floorplanUrl: slidePlan.floorplanUrl,
      renderedFloorplanUrl: slidePlan.renderedFloorplanUrl,
      layoutPoints: plan.layoutPoints ?? null,
      floorplanTemplate: plan.floorplanTemplate ?? null,
      markerTemplate: plan.markerTemplate ?? null,
      quoteSummary: plan.quoteSummary ?? null,
    });
    const fpIndex = r.pages.findIndex((p) => p.type === 'floorplan');
    return { pages: r.pages, syntheticAt: fpIndex };
  })();

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
        {/* 场景视频放在幻灯片之前：客户在微信里打开先看到「装出来是什么样」，
            再看逐页细节 —— 顺序反了的话，视频会被当成附加彩蛋而错过。 */}
        {videoCount > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {Array.from({ length: videoCount }, (_, vi) => (
              <div key={vi} style={{ boxShadow: '0 2px 16px rgba(0,0,0,.08)', background: t.surface, overflow: 'hidden' }}>
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <video
                  src={`/api/public/plans/${token}/video/${vi}`}
                  controls
                  preload="metadata"
                  playsInline
                  style={{ display: 'block', width: '100%', maxHeight: '56vh', background: '#000' }}
                />
                {videoTitles[vi] ? (
                  <div style={{ padding: '10px 16px', fontSize: 13, color: t.sub }}>{videoTitles[vi]}</div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {shown.pages.map((p, i) => (          <div key={i} style={{ boxShadow: '0 2px 16px rgba(0,0,0,.08)' }}>
            <PlanSlide page={p} index={i} plan={slidePlan} t={t} listNo={floorplanListPageNo(shown.pages, i)} quoteNo={quoteListPageNo(shown.pages, i)} />
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
