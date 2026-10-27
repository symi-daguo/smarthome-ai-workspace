import { Spin, Typography, theme } from 'antd';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, fileUrl } from '../lib/api';
import { refreshPageImageOverrides } from '../lib/pageImages';
import { planTheme, type PlanPage } from '../data/planThemes';
import { PlanSlide } from '../components/PlanSlide';
import { deliverPages, floorplanListPageNo, quoteListPageNo, type QuoteSummary } from '../lib/planPages';

const { Text } = Typography;

/**
 * 打印前等图的最长等待（毫秒）。
 *
 * 超时就照常打印：已经加载完的图会打进去，慢的那张可能缺，
 * 但用户至少拿到一份 PDF —— 一直转圈比缺一张图更糟。
 */
const PRINT_IMAGE_TIMEOUT_MS = 8000;

/**
 * 方案打印视图 —— 「导出高清 PDF」的落地页。
 *
 * 为什么用浏览器原生打印，而不是在 Node 端转 PPTX：
 * - **零新增依赖**：服务端不引无头浏览器（brand-site.service 的既定原则），
 *   前端也不必引 jspdf / html2canvas 这类重量级库；
 * - **矢量输出**：文字是文字、图形是图形，PDF 里可选中、可搜索、无级缩放，
 *   打印出来的报价清单数字不会糊；
 * - **所见即所得**：这一页渲染的就是方案预览用的那套 `PlanSlide` 组件，
 *   与浏览器里看到的一模一样。
 *
 * 打印对话框里把「目标打印机」选成「另存为 PDF」，纸张方向选「横向」、
 * 边距选「无」（页面尺寸已用 `@page` 固定为 16:9），即可得到成品 PDF。
 *
 * 页序与 PPTX 共用 `deliverPages()`，保证 PDF 与 PPT 页页对得上。
 */

interface PrintPlan {
  id: string;
  title: string;
  customer: string;
  area: string;
  store: string;
  style: string;
  edition: string;
  versionNo: number;
  pages: PlanPage[];
  floorplanAssetId?: string | null;
  renderedFloorplanAssetId?: string | null;
  layoutPoints?: { name: string; category: string; room?: string; x: number; y: number }[] | null;
  floorplanTemplate?: string | null;
  markerTemplate?: string | null;
  quoteSummary?: QuoteSummary | null;
}

export function PlanPrintView(): ReactNode {
  const [params] = useSearchParams();
  // 两种来源：
  //   ?id=xxx     门店自己的方案（需登录，走 /api/plans/:id，含完整字段）
  //   ?share=xxx  公开分享的方案（免鉴权，走 /api/public/plans/:token）
  // 公开分享也支持导出，是给客户的用法：客户自己就能把方案存成高清 PDF，
  // 不必再回门店要文件。
  const id = params.get('id') ?? '';
  const share = params.get('share') ?? '';
  const { token } = theme.useToken();
  const [plan, setPlan] = useState<PrintPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!id && !share) {
      setError('缺少方案参数');
      return;
    }
    const req = share
      ? api<PrintPlan>(`/api/public/plans/${encodeURIComponent(share)}`)
      : api<PrintPlan>(`/api/plans/${encodeURIComponent(id)}`);
    req
      .then(setPlan)
      .catch((e) => setError((e as Error).message || '方案不存在或已删除'));
  }, [id, share]);

  /**
   * 页型配图：门店配的图要出现在打印出的 PDF 里，与导出的 PPTX 同源。
   *
   * 分享态（`?share=`，客户未登录）拿不到这个接口（要鉴权），
   * 此时保持默认实景图 —— 客户看到的是方案本身，不是门店的图库配置。
   */
  useEffect(() => {
    if (share) return;
    void refreshPageImageOverrides();
  }, [share]);

  // style 缺省时回落到首个主题（planTheme 内部也找不到就取 PLAN_THEMES[0]）
  const t = planTheme(plan?.style ?? 'A');

  const slidePlan = useMemo(
    () => ({
      store: plan?.store ?? '',
      /**
       * 户型底图：分享态必须走**公开**端点。
       * 原来一律用 fileUrl('/api/media/assets/:id/file')，那个接口要鉴权 ——
       * 客户（未登录）导出 PDF 时户型图会 401，图上不出现点位，等于导出一份残件。
       */
      floorplanUrl: plan?.floorplanAssetId
        ? (share ? `/api/public/plans/${encodeURIComponent(share)}/floorplan` : fileUrl(`/api/media/assets/${plan.floorplanAssetId}/file`))
        : null,
      renderedFloorplanUrl: plan?.renderedFloorplanAssetId
        ? (share ? `/api/public/plans/${encodeURIComponent(share)}/rendered-floorplan` : fileUrl(`/api/media/assets/${plan.renderedFloorplanAssetId}/file`))
        : null,
      layoutPoints: plan?.layoutPoints ?? null,
      floorplanTemplate: plan?.floorplanTemplate ?? null,
      markerTemplate: plan?.markerTemplate ?? null,
      quoteSummary: plan?.quoteSummary ?? null,
    }),
    [plan, share],
  );

  const shown = useMemo(() => {
    if (!plan) return { pages: [] as PlanPage[] };
    const r = deliverPages({
      pages: plan.pages,
      floorplanUrl: slidePlan.floorplanUrl,
      renderedFloorplanUrl: slidePlan.renderedFloorplanUrl,
      layoutPoints: plan.layoutPoints ?? null,
      floorplanTemplate: plan.floorplanTemplate ?? null,
      markerTemplate: plan.markerTemplate ?? null,
      quoteSummary: plan.quoteSummary ?? null,
    });
    return { pages: r.pages };
  }, [plan, slidePlan]);

  /**
   * 图片与字体都到位后再触发打印：提前 print 会打出半张空页。
   *
   * 为什么必须等：配图是真正的 `<img>`（不是 CSS 背景图），
   * 图没加载完就打印，PDF 里配图位置是一片空白 ——
   * 门店在页面上看到的预览和客户拿到的 PDF 不是同一份东西。
   *
   * 为什么要有超时兜底：`Promise.all` 只要有一张图一直不落地
   * （弱网、图 404 后被浏览器反复重试）就永远等下去 ——
   * 用户点了「导出 PDF」，界面一直转圈，比打出半张空页更糟。
   */
  useEffect(() => {
    if (!plan || !shown.pages.length) return;
    const imgs = [...document.images];
    const waits = imgs.map((im) => (im.complete ? Promise.resolve() : new Promise<void>((res) => {
      // 用 addEventListener 而不是写 im.onload：别覆盖别处挂上去的处理器
      im.addEventListener('load', () => res(), { once: true });
      im.addEventListener('error', () => res(), { once: true });
    })));
    let timer = 0;
    const timeout = new Promise<void>((res) => { timer = window.setTimeout(res, PRINT_IMAGE_TIMEOUT_MS); });
    Promise.race([Promise.all(waits), timeout])
      .then(() => document.fonts?.ready)
      .catch(() => undefined)
      .then(() => {
        window.clearTimeout(timer);
        setReady(true);
        // 留一帧给浏览器完成布局，否则第一页可能是空白的
        window.setTimeout(() => window.print(), 350);
      });
  }, [plan, shown.pages.length]);

  if (error) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: token.colorBgLayout }}>
        <Text type="secondary">{error}</Text>
      </div>
    );
  }
  if (!plan) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: token.colorBgLayout }}>
        <Spin tip="正在准备打印视图…">
          <div style={{ padding: 40 }} />
        </Spin>
      </div>
    );
  }

  return (
    <div className="plan-print-root" style={{ background: token.colorBgLayout, minHeight: '100vh', padding: '16px 0 48px' }}>
      {/* 只在屏幕上显示的操作提示；打印时整条隐藏（见 styles.css 的 @media print） */}
      <div className="plan-print-hint" style={{ maxWidth: 1280, margin: '0 auto 16px', padding: '12px 16px', background: token.colorBgContainer, border: `1px solid ${token.colorBorderSecondary}`, borderRadius: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
        <div>
          <Text strong>导出高清 PDF</Text>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              打印对话框里把「目标打印机」选成「另存为 PDF」；纸张方向「横向」、边距「无」（页面尺寸已固定为 16:9）。输出是矢量 PDF，文字可搜索可复制。
            </Text>
          </div>
        </div>
        <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          共 {shown.pages.length} 页 · {ready ? '已就绪' : '准备中'}
        </Text>
      </div>

      <div style={{ maxWidth: 1280, margin: '0 auto' }}>
        {shown.pages.map((p, i) => (
          <div key={i} className="plan-print-page" style={{ marginBottom: 16 }}>
            <PlanSlide
              page={p}
              index={i}
              plan={slidePlan}
              t={t}
              listNo={floorplanListPageNo(shown.pages, i)}
              quoteNo={quoteListPageNo(shown.pages, i)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
