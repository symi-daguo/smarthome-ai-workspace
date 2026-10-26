import { catMeta } from '../lib/pointOverlay';
import { PAGE_TYPE_LABEL, resolvePageImage, imgFilter, imgPosition, imgSize, CARD_SHADOW, CARD_SHADOW_SOFT, type PlanPage, type PlanTheme } from '../data/planThemes';
import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { compositePoints, COMPOSITE_WIDTH, type PointLike } from '../lib/pointOverlay';
import { customerText } from '../lib/planSanitize';
import { floorplanTemplate, markerTemplate, floorplanImages, floorplanPageCopy, COMPARE_LEFT_LABEL } from '../data/planTemplates';
import { POINT_ROWS_PER_PAGE, QUOTE_ROWS_PER_PAGE, deliverPointCount, type QuoteSummary } from '../lib/planPages';

interface SlidePlan {
  store: string;
  /** 客户户型平面图（点位编辑器挂接；空间动线页优先用它+点位叠加） */
  floorplanUrl?: string | null;
  /** AI 渲染的精装修效果图（与原始户型图共存时优先用此图，覆盖点位叠加） */
  renderedFloorplanUrl?: string | null;
  layoutPoints?: PointLike[] | null;
  /** 交付模版（与 PPTX 同源，见 data/planTemplates.ts） */
  floorplanTemplate?: string | null;
  markerTemplate?: string | null;
  /** 设备清单与报价（与 PPTX 同源，见 lib/planPages.ts） */
  quoteSummary?: QuoteSummary | null;
}

/**
 * 幻灯片预览组件（16:9 画布）。设计系统分层（jingmei-ppt skill 方法论）：
 * - tokens：planThemes 的角色色 + 阴影 + 页型配图映射
 * - primitives：Folio 页眉 / Claim 主张 / PointCard 阴影要点卡 / ImagePanel 配图 / QuoteBar 结论 / Footer
 * - compositions：8 类页型各自独立轮廓（沉浸式图页与分析卡页交替，避免整册同一网格）
 * cqw 容器查询单位让同一组件在缩略图/大图/分享页自动缩放。
 */
const containerStyle: CSSProperties = { containerType: 'inline-size' };

interface BudgetItem {
  name: string;
  min: number;
  max: number;
}

/**
 * 各页型实际渲染的要点条数（与下面各 Slide 组件里的 slice 上限一一对应）。
 *
 * 放在渲染文件里而不是编辑弹窗里：这是**渲染的真实约束**，编辑提示与它同源，
 * 以后调整某个页型的 slice 时只改一处，不会出现"提示说 5 条、实际只显示 4 条"。
 */
export const PAGE_BULLET_LIMIT: Record<PlanPage['type'], number> = {
  // 户型与点位页是图示页：只有整页大图 + 品类汇总，没有可编辑的要点条
  floorplan: 0,
  // 报价页是表页：内容由点位与产品库价格推出，不接受人工改要点
  quote: 0,
  cover: 3,
  brand: 4,
  needs: 5,
  ecosystem: 5,
  scene: 5,
  layout: 6,
  budget: 6,
  delivery: 5,
};

/** 解析预算页要点"分项名：下限-上限"为图表数据；无法解析的退回普通要点 */
function parseBudget(bullets: string[]): BudgetItem[] | null {
  const items: BudgetItem[] = [];
  for (const b of bullets) {
    const m = b.match(/^(.+?)\s*[：:]\s*([\d,]+)\s*[-–~]\s*([\d,]+)/);
    if (!m) return null;
    const min = Number(m[2].replace(/,/g, ''));
    const max = Number(m[3].replace(/,/g, ''));
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= 0) return null;
    items.push({ name: m[1].trim(), min, max });
  }
  return items.length >= 2 ? items : null;
}

/** 解析交付页要点为流程步骤：去前导编号，首段为名称，其余（含子标题）归入说明 */
function parseStages(bullets: string[]): { name: string; desc: string }[] | null {
  const stages = bullets.map((b) => {
    const cleaned = b.replace(/^\s*0?\d{1,2}\s*[.、::｜|]?\s*/, '');
    const idx = cleaned.search(/[｜|：:]/);
    if (idx < 0) return { name: cleaned.trim(), desc: '' };
    return { name: cleaned.slice(0, idx).trim(), desc: cleaned.slice(idx + 1).replace(/[｜|]/g, ' ').trim() };
  });
  const ok = stages.filter((s) => s.name && s.desc);
  return ok.length >= 3 ? ok.slice(0, 6) : null;
}

function fmt(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(n % 10000 === 0 ? 0 : 1)}万` : `${n}`;
}

/** 页型→配图（门店配了页型图就用门店的，没配则用写死的兜底图/场景图） */
function pageImage(page: PlanPage): string {
  // 与 PPTX 导出共用 resolvePageImage 一处口径 —— 预览看到什么，导出的就是什么
  return resolvePageImage(page);
}

/**
 * 方案户型图的最终画面（主图）。
 *
 * 抽出来是因为空间动线页与户型点位页都要这张图，两处各写一遍合成逻辑
 * 迟早只改一处，客户看到的两个页面就对不上。
 *
 * 口径全部来自 `floorplanImages`（data/planTemplates.ts）——
 * 与 PPTX 导出共用同一份，模版三选一不再各写一遍。
 */
function useFloorplanVisual(plan: SlidePlan): { src: string; label: string; fit: 'cover' | 'contain' } {
  /**
   * 底图是**客户原图**。
   *
   * 为什么点位要叠在原始户型图上：点位坐标是门店在**客户上传的那张户型图**上标的，
   * 换成 AI 渲染图当底图，两张图的构图只要有出入（模型改了布局、加了边距、
   * 改了开口位置），点位就与实际位置对不上 —— 而点位图是施工交底的依据，
   * 位置错了比没有图更糟。AI 精装修效果图只出现在「该出现的地方」
   * （compare 的右栏、render 模版），绝不拿去当叠点位的底图。
   */
  const images = floorplanImages(plan);
  const mkTpl = markerTemplate(plan.markerTemplate);
  // render / compare 模版图上没有徽章，不叠点位（见 floorplanImages 的对照表）
  const needCompose = Boolean(images.main && images.overlayPoints && plan.layoutPoints?.length);
  const [composite, setComposite] = useState<string | null>(null);
  useEffect(() => {
    if (!needCompose || !images.main) {
      setComposite(null);
      return;
    }
    let alive = true;
    void compositePoints(images.main, plan.layoutPoints ?? [], COMPOSITE_WIDTH, mkTpl)
      .then((url) => { if (alive) setComposite(url); })
      .catch(() => { if (alive) setComposite(null); });
    return () => { alive = false; };
  }, [needCompose, images.main, plan.layoutPoints, mkTpl]);

  // 户型图用 cover 铺满：contain 会在卡片内留出上下白边，PPT 里非常难看。
  // 点位图标是合成进图里的，裁剪时会跟着一起裁，不会与点位错位。
  //
  // compare 模版的**对照页**另说：那张页的两张图要完整看到，
  // 那边用 contain（见 FloorplanSlide），与 PPTX 的对照页同一口径。
  if (images.main) {
    return {
      src: needCompose ? (composite ?? images.main) : images.main,
      label: images.mainLabel,
      fit: 'cover',
    };
  }
  return { src: '', label: '空间动线实景', fit: 'cover' };
}

export function PlanSlide({ page: raw, index, plan, t, listNo = 0, quoteNo = 0 }: { page: PlanPage; index: number; plan: SlidePlan; t: PlanTheme; listNo?: number; quoteNo?: number }): ReactNode {
  // 客户可见的出口在这里统一净化一次。
  //
  // 为什么放在组件里而不是 4 个调用点各自处理：PlanSlide 被编辑预览、客户放映、
  // 分享页（PlanShareView）三处复用，逐个调用点净化必然漏一处，而漏掉的那处
  // 就是客户直接看到的页面。改名成 page 后，下面所有子组件拿到的都是净化后的值，
  // 无需改动它们内部任何一行。
  const page = useMemo<PlanPage>(() => ({
    ...raw,
    // 净化后为空则退回原文：宁可多显示一句，也不要标题凭空消失
    heading: customerText(raw.heading) || raw.heading,
    // 正文与副标题同样要净化：模型最常把「待确认」「暂无资料」写进正文，
    // 只净 heading/bullets 的话，客户在分享页照样看得见待办语句。
    body: customerText(raw.body) || raw.body,
    subtitle: customerText(raw.subtitle) || raw.subtitle,
    quote: customerText(raw.quote) || raw.quote,
    bullets: raw.bullets.map(customerText).filter(Boolean),
  }), [raw]);
  switch (page.type) {
    case 'cover': return <CoverSlide page={page} plan={plan} t={t} />;
    case 'brand': return <BrandSlide page={page} index={index} plan={plan} t={t} />;
    case 'layout': return <LayoutSlide page={page} index={index} plan={plan} t={t} />;
    case 'needs': return <NeedsSlide page={page} index={index} plan={plan} t={t} />;
    case 'ecosystem': return <EcosystemSlide page={page} index={index} plan={plan} t={t} />;
    case 'scene': return <SceneSlide page={page} index={index} plan={plan} t={t} />;
    case 'budget': return <BudgetSlide page={page} index={index} plan={plan} t={t} />;
    case 'delivery': return <DeliverySlide page={page} index={index} plan={plan} t={t} />;
    case 'floorplan': return <FloorplanSlide page={page} index={index} plan={plan} t={t} listNo={listNo} />;
    case 'quote': return <QuoteSlide page={page} index={index} plan={plan} t={t} quoteNo={quoteNo} />;
  }
}

/* ---------- primitives ---------- */

function Frame({ t, children, style }: { t: PlanTheme; children: ReactNode; style?: CSSProperties }): ReactNode {
  return (
    <div style={{ ...containerStyle, width: '100%', aspectRatio: '16 / 9', background: t.bg, borderRadius: 10, overflow: 'hidden', position: 'relative', ...style }}>
      {children}
    </div>
  );
}

/**
 * 页眉：页码 + 页型标签 + 副标题。
 *
 * `label` 用于覆盖页型标签：户型页的页型标签随模版变
 * （compare 是「户型改造前后对照」，不是「户型与设备点位」），
 * 与 PPTX 的 folio 同一口径。
 */
function Folio({ page, index, t, label }: { page: PlanPage; index: number; t: PlanTheme; label?: string }): ReactNode {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: '1.6cqw' }}>
      <span style={{ fontSize: 'clamp(6px,1.3cqw,11px)', fontWeight: 800, color: t.accent, letterSpacing: '0.1em', whiteSpace: 'nowrap', flex: 'none' }}>
        {String(index + 1).padStart(2, '0')}
      </span>
      <span style={{ width: 2, height: '1.6cqw', minHeight: 8, background: t.accent, alignSelf: 'center', flex: 'none' }} />
      <span style={{ fontSize: 'clamp(6px,1.3cqw,11px)', fontWeight: 700, color: t.text, whiteSpace: 'nowrap', flex: 'none' }}>{label ?? PAGE_TYPE_LABEL[page.type]}</span>
      {page.subtitle ? <span style={{ fontSize: 'clamp(5px,1.15cqw,10px)', color: t.sub, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>{page.subtitle}</span> : null}
    </div>
  );
}

function Claim({ page, t, size = 'clamp(9px,2.9cqw,22px)' }: { page: PlanPage; t: PlanTheme; size?: string }): ReactNode {
  return (
    <div style={{ fontSize: size, fontWeight: 800, color: t.text, lineHeight: 1.28, marginTop: '1.4cqw' }}>
      {page.heading.includes('｜') ? page.heading.split('｜').map((seg, i) => (
        i === 0 ? <span key={i}>{seg}<span style={{ color: t.accent }}>｜</span></span> : <span key={i}>{seg}</span>
      )) : page.heading}
    </div>
  );
}

function PointCard({ n, text, t, strong = true }: { n: number; text: string; t: PlanTheme; strong?: boolean }): ReactNode {
  const [h, ...r] = text.split(/[：|｜]/);
  return (
    // flex:1 + minHeight:0 让要点卡在列内均分高度：条数越多卡越扁，但绝不溢出画布。
    // 原来按内容取自然高度，6 条时总高超过 16:9 画布，底部卡片和页脚被裁掉。
    <div style={{ display: 'flex', alignItems: 'center', gap: '1.6cqw', background: t.surface, borderRadius: '1.4cqw', padding: '1.1cqw 1.8cqw', boxShadow: CARD_SHADOW, border: `1px solid ${t.accent}1a`, flex: '1 1 0', minHeight: 0 }}>
      <span style={{ width: '3.4cqw', height: '3.4cqw', minWidth: 13, minHeight: 13, borderRadius: '50%', background: `linear-gradient(135deg, ${t.accent}, ${t.accent}bb)`, color: '#fff', fontSize: '1.5cqw', fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none', boxShadow: `0 2px 5px ${t.accent}66` }}>
        {String(n).padStart(2, '0')}
      </span>
      <span style={{ fontSize: 'clamp(6px,1.45cqw,12px)', color: t.text, lineHeight: 1.5, minWidth: 0, overflow: 'hidden' }}>
        {r.length ? <><b style={{ color: t.text }}>{h}</b><span style={{ color: t.accent, margin: '0 0.4cqw' }}>·</span><span style={{ color: t.sub }}>{r.join(' ')}</span></> : text}
      </span>
    </div>
  );
}

function ImagePanel({ src, t, caption, style, label, overlay, fit }: { src: string; t: PlanTheme; caption?: string; style?: CSSProperties; label?: string; overlay?: ReactNode; fit?: 'cover' | 'contain' }): ReactNode {
  return (
    <div style={{ position: 'relative', borderRadius: '1.6cqw', overflow: 'hidden', boxShadow: CARD_SHADOW, background: fit === 'contain' ? '#fff' : undefined, ...style }}>
      <div style={{ position: 'absolute', inset: 0, background: `url(${src}) center/${fit === 'contain' ? 'contain' : 'cover'} no-repeat` }} />
      {overlay}
      {label ? (
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '2.2cqw 2cqw 1.4cqw', background: 'linear-gradient(transparent, rgba(15,10,5,.72))' }}>
          <span style={{ fontSize: 'clamp(6px,1.5cqw,13px)', fontWeight: 800, color: '#fff', letterSpacing: '0.05em' }}>{label}</span>
        </div>
      ) : null}
      {caption ? (
        <div style={{ position: 'absolute', top: '1.2cqw', left: '1.2cqw', background: 'rgba(15,10,5,.55)', backdropFilter: 'blur(2px)', borderRadius: 999, padding: '0.5cqw 1.4cqw' }}>
          <span style={{ fontSize: 'clamp(5px,1.1cqw,10px)', color: '#fff' }}>{caption}</span>
        </div>
      ) : null}
      <div style={{ position: 'absolute', inset: 0, border: `1px solid ${t.accent}33`, borderRadius: '1.6cqw' }} />
    </div>
  );
}

function QuoteBar({ quote, t }: { quote?: string; t: PlanTheme }): ReactNode {
  if (!quote) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '1.4cqw', background: t.surface, borderRadius: '0 1.2cqw 1.2cqw 0', boxShadow: CARD_SHADOW_SOFT, padding: '1.2cqw 2cqw', borderLeft: `0.55cqw solid ${t.accent}` }}>
      <span style={{ fontSize: '2.8cqw', lineHeight: 1, color: t.accent, fontWeight: 800 }}>&ldquo;</span>
      <span style={{ fontSize: 'clamp(6px,1.6cqw,13px)', color: t.text, fontStyle: 'italic', fontWeight: 600 }}>{quote}</span>
    </div>
  );
}

function Footer({ plan, t }: { plan: SlidePlan; t: PlanTheme }): ReactNode {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '1.2cqw', fontSize: 'clamp(5px,1.05cqw,9px)', color: t.sub }}>
      <span style={{ fontWeight: 700, color: t.text }}>{plan.store || '全屋智能方案'}</span>
      <span style={{ width: 2, height: 2, borderRadius: 1, background: t.accent }} />
      <span>实际配置与报价以门店方案师现场确认为准</span>
    </div>
  );
}

/* ---------- compositions ---------- */

/** 封面：左主张+价值卡，右满高实景图 */
function CoverSlide({ page, plan, t }: { page: PlanPage; plan: SlidePlan; t: PlanTheme }): ReactNode {
  return (
    <Frame t={t}>
      <div style={{ position: 'absolute', right: 0, top: 0, width: '44%', height: '100%' }}>
        <div style={{ position: 'absolute', inset: 0, background: `url(${pageImage(page)}) center/cover` }} />
        <div style={{ position: 'absolute', inset: 0, background: t.dark ? 'linear-gradient(90deg, rgba(16,12,8,.55), transparent 45%)' : 'linear-gradient(90deg, rgba(255,255,255,.9), rgba(255,255,255,.25) 30%, transparent 60%)' }} />
      </div>
      <div style={{ position: 'absolute', left: 0, top: 0, width: '60%', height: '100%', padding: '7% 0 6% 6%', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.4cqw' }}>
          <span style={{ width: '5cqw', height: '5cqw', minWidth: 20, minHeight: 20, borderRadius: '1.6cqw', background: `linear-gradient(135deg, ${t.accent}, ${t.accent}99)`, boxShadow: `0 3px 8px ${t.accent}55`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 800, fontSize: '2.4cqw' }}>智</span>
          <span style={{ fontSize: 'clamp(6px,1.4cqw,12px)', fontWeight: 700, color: t.sub, letterSpacing: '0.12em' }}>{plan.store || '全屋智能方案'}</span>
        </div>
        <div style={{ fontSize: 'clamp(10px,3.6cqw,28px)', fontWeight: 800, color: t.text, lineHeight: 1.3, marginTop: 'auto' }}>
          {page.heading.split('｜').map((seg, i, arr) => (
            <span key={i}>{i === 0 && arr.length > 1 ? <>{seg}<span style={{ color: t.accent }}>｜</span></> : seg}</span>
          ))}
        </div>
        <div style={{ fontSize: 'clamp(6px,1.7cqw,14px)', color: t.sub, marginTop: '1.6cqw' }}>{page.subtitle}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.2cqw', marginTop: 'auto' }}>
          {page.bullets.slice(0, 3).map((b, i) => {
            const [h, ...r] = b.split(/[：|｜]/);
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '1.4cqw', background: `${t.surface}e6`, backdropFilter: 'blur(2px)', border: `1px solid ${t.accent}33`, borderRadius: '1.2cqw', padding: '1.1cqw 1.6cqw', boxShadow: CARD_SHADOW_SOFT }}>
                <span style={{ width: '1cqw', height: '1cqw', minWidth: 4, minHeight: 4, borderRadius: '50%', background: t.accent, flex: 'none' }} />
                <span style={{ fontSize: 'clamp(6px,1.4cqw,12px)', color: t.text }}><b style={{ color: t.accent }}>{h}</b>{r.length ? `：${r.join('：')}` : ''}</span>
              </div>
            );
          })}
        </div>
      </div>
    </Frame>
  );
}

/** 品牌实力：左文 + 2×2 数据卡 + 右竖图 */
function BrandSlide({ page, index, plan, t }: { page: PlanPage; index: number; plan: SlidePlan; t: PlanTheme }): ReactNode {
  return (
    <Frame t={t} style={{ padding: '4.5% 5% 5.5%' }}>
      <div style={{ display: 'flex', gap: '4%', height: '100%' }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <Folio page={page} index={index} t={t} />
          <Claim page={page} t={t} />
          <div style={{ fontSize: 'clamp(6px,1.4cqw,12px)', color: t.sub, lineHeight: 1.8, marginTop: '1.6cqw' }}>{page.body}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.4cqw', marginTop: '2.2cqw', flex: 1, minHeight: 0 }}>
            {page.bullets.slice(0, 4).map((b, i) => {
              const [h, ...r] = b.split(/[：|｜]/);
              return (
                <div key={i} style={{ position: 'relative', background: t.surface, borderRadius: '1.4cqw', padding: '1.8cqw 2cqw', boxShadow: CARD_SHADOW, border: `1px solid ${t.accent}1a`, display: 'flex', flexDirection: 'column', justifyContent: 'center', overflow: 'hidden' }}>
                  <span style={{ position: 'absolute', right: '1cqw', top: '0.4cqw', fontSize: 'clamp(16px,4.2cqw,34px)', fontWeight: 800, color: `${t.accent}14`, lineHeight: 1 }}>{String(i + 1).padStart(2, '0')}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1cqw' }}>
                    <span style={{ width: '0.55cqw', minWidth: 2, height: '1.6cqw', minHeight: 8, background: t.accent, borderRadius: 2, flex: 'none' }} />
                    <span style={{ fontSize: 'clamp(7px,1.5cqw,13px)', fontWeight: 800, color: t.text }}>{h}</span>
                  </div>
                  <div style={{ fontSize: 'clamp(5.5px,1.2cqw,10.5px)', color: t.sub, marginTop: '0.8cqw', lineHeight: 1.6, paddingLeft: '1.55cqw' }}>{r.join(' ')}</div>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: '1.8cqw' }}><QuoteBar quote={page.quote} t={t} /></div>
          <div style={{ marginTop: '1.4cqw' }}><Footer plan={plan} t={t} /></div>
        </div>
        <ImagePanel src={pageImage(page)} t={t} label={page.subtitle || '门店实景'} style={{ width: '30%', flex: 'none' }} />
      </div>
    </Frame>
  );
}

/** 空间动线：左竖实景图 + 右编号要点卡列；优先用精装修渲染图，无则用"户型+点位"合成图，无则用场景实景图 */
function LayoutSlide({ page, index, plan, t }: { page: PlanPage; index: number; plan: SlidePlan; t: PlanTheme }): ReactNode {
  const { src: visual, label, fit } = useFloorplanVisual(plan);
  const src = visual || pageImage(page);
  return (
    <Frame t={t} style={{ padding: '4.5% 5% 5.5%' }}>
      <div style={{ display: 'flex', gap: '4%', height: '100%' }}>
        <ImagePanel
          src={src}
          t={t}
          label={label}
          fit={fit}
          style={{ width: '32%', flex: 'none' }}
        />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <Folio page={page} index={index} t={t} />
          <Claim page={page} t={t} />
          <div style={{ fontSize: 'clamp(6px,1.35cqw,11.5px)', color: t.sub, lineHeight: 1.75, marginTop: '1.4cqw', marginBottom: '1.6cqw' }}>{page.body}</div>
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: '1.25cqw' }}>
            {page.bullets.slice(0, 6).map((b, i) => <PointCard key={i} n={i + 1} text={b} t={t} />)}
          </div>
          <div style={{ marginTop: '1.4cqw', display: 'flex', alignItems: 'center', gap: '2cqw' }}>
            <QuoteBar quote={page.quote} t={t} />
          </div>
          <div style={{ marginTop: '1.6cqw' }}><Footer plan={plan} t={t} /></div>
        </div>
      </div>
    </Frame>
  );
}

/** 需求洞察：顶部沉浸图带 + 下方左文右卡 */
function NeedsSlide({ page, index, plan, t }: { page: PlanPage; index: number; plan: SlidePlan; t: PlanTheme }): ReactNode {
  return (
    <Frame t={t}>
      <div style={{ position: 'relative', height: '36%' }}>
        <div style={{ position: 'absolute', inset: 0, background: `url(${pageImage(page)}) ${imgPosition(pageImage(page))}/cover`, filter: imgFilter(pageImage(page)) }} />
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(15,10,5,.1), rgba(15,10,5,.5))' }} />
        <div style={{ position: 'absolute', left: '5%', bottom: '12%', right: '5%' }}>
          <div style={{ fontSize: 'clamp(6px,1.25cqw,11px)', fontWeight: 700, color: '#ffffffb0', letterSpacing: '0.15em' }}>{page.subtitle || PAGE_TYPE_LABEL[page.type]}</div>
          <div style={{ fontSize: 'clamp(9px,2.7cqw,21px)', fontWeight: 800, color: '#fff', lineHeight: 1.3, marginTop: '0.6cqw' }}>{page.heading}</div>
        </div>
      </div>
      <div style={{ padding: '2.6cqw 5% 5%', display: 'flex', gap: '3.5%', height: '64%' }}>
        <div style={{ width: '34%', display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 'clamp(6px,1.35cqw,11.5px)', color: t.sub, lineHeight: 1.8 }}>{page.body}</div>
          <div style={{ marginTop: 'auto' }}><QuoteBar quote={page.quote} t={t} /></div>
          <div style={{ marginTop: '1.6cqw' }}><Footer plan={plan} t={t} /></div>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: '1.3cqw' }}>
          {page.bullets.slice(0, 5).map((b, i) => <PointCard key={i} n={i + 1} text={b} t={t} />)}
        </div>
      </div>
    </Frame>
  );
}

/** 生态规划：右图 + 左文 + 底部生态卡横排 */
function EcosystemSlide({ page, index, plan, t }: { page: PlanPage; index: number; plan: SlidePlan; t: PlanTheme }): ReactNode {
  return (
    <Frame t={t} style={{ padding: '4.5% 5% 5.5%' }}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{ display: 'flex', gap: '4%', flex: 1, minHeight: 0 }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', minWidth: 0 }}>
            <Folio page={page} index={index} t={t} />
            <Claim page={page} t={t} />
            <div style={{ fontSize: 'clamp(6px,1.35cqw,11.5px)', color: t.sub, lineHeight: 1.75, marginTop: '1.4cqw' }}>{page.body}</div>
          </div>
          <ImagePanel src={pageImage(page)} t={t} label="智能中枢实景" style={{ width: '34%', flex: 'none' }} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(page.bullets.length, 5)}, 1fr)`, gap: '1.3cqw', marginTop: '2.2cqw', height: '24%' }}>
          {page.bullets.slice(0, 5).map((b, i) => {
            const [h, ...r] = b.split(/[：|｜]/);
            return (
              <div key={i} style={{ background: t.surface, borderRadius: '1.4cqw', padding: '1.2cqw 1.5cqw', boxShadow: CARD_SHADOW, borderTop: `0.4cqw solid ${t.accent}`, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                <div style={{ fontSize: 'clamp(6px,1.3cqw,11px)', fontWeight: 800, color: t.text }}>{h}</div>
                <div style={{ fontSize: 'clamp(5px,1.1cqw,9.5px)', color: t.sub, marginTop: '0.7cqw', lineHeight: 1.55, overflow: 'hidden' }}>{r.join(' ')}</div>
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '2cqw', marginTop: '1.8cqw' }}>
          <div style={{ flex: 1 }}><QuoteBar quote={page.quote} t={t} /></div>
          <Footer plan={plan} t={t} />
        </div>
      </div>
    </Frame>
  );
}

/** 场景拆解：左满高沉浸图+场景标签，右要点卡列 */
function SceneSlide({ page, index, plan, t }: { page: PlanPage; index: number; plan: SlidePlan; t: PlanTheme }): ReactNode {
  return (
    <Frame t={t}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: '36%', height: '100%' }}>
        <div style={{ position: 'absolute', inset: 0, background: `url(${pageImage(page)}) ${imgPosition(pageImage(page))}/${imgSize(pageImage(page), true)}`, filter: imgFilter(pageImage(page)) }} />
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(90deg, rgba(15,10,5,.15), rgba(15,10,5,.62))' }} />
        <div style={{ position: 'absolute', left: '11%', bottom: '9%', right: '8%' }}>
          <div style={{ display: 'inline-block', background: t.accent, color: '#fff', borderRadius: 999, padding: '0.7cqw 2cqw', fontSize: 'clamp(5px,1.15cqw,10px)', fontWeight: 700, letterSpacing: '0.1em', boxShadow: `0 3px 8px ${t.accent}66` }}>
            {PAGE_TYPE_LABEL[page.type]}
          </div>
          <div style={{ fontSize: 'clamp(8px,2.3cqw,18px)', fontWeight: 800, color: '#fff', lineHeight: 1.35, marginTop: '1.4cqw' }}>{page.heading}</div>
        </div>
      </div>
      <div style={{ position: 'absolute', left: '36%', top: 0, right: 0, bottom: 0, padding: '5% 5% 3.5%', display: 'flex', flexDirection: 'column' }}>
        <Folio page={page} index={index} t={t} />
        <div style={{ fontSize: 'clamp(6px,1.3cqw,11px)', color: t.sub, lineHeight: 1.75, marginTop: '1.4cqw', marginBottom: '1.8cqw' }}>{page.body}</div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: '1.25cqw' }}>
          {page.bullets.slice(0, 5).map((b, i) => <PointCard key={i} n={i + 1} text={b} t={t} />)}
        </div>
        <div style={{ marginTop: '1.6cqw' }}><QuoteBar quote={page.quote} t={t} /></div>
        <div style={{ marginTop: '1.6cqw' }}><Footer plan={plan} t={t} /></div>
      </div>
    </Frame>
  );
}

/** 预算规划：左文+合规，右阴影面板内条形图 */
/**
 * 设备清单与报价页（React 版，与 PPTX 的 quoteSlide 同口径）。
 *
 * 数据来自产品库与真实点位：数量 = 该款设备在平面图上的点位个数，
 * 单价 = 参考零售价。**不含**辅材、布线、安装与调试 —— 口径写在页脚，
 * 否则客户会把设备价当整包价。
 */
function QuoteSlide({ page, index, plan, t, quoteNo }: { page: PlanPage; index: number; plan: SlidePlan; t: PlanTheme; quoteNo: number }): ReactNode {
  const sum = plan.quoteSummary;
  const rows = sum ? sum.items.slice(quoteNo * QUOTE_ROWS_PER_PAGE, (quoteNo + 1) * QUOTE_ROWS_PER_PAGE) : [];
  const pageSubtotal = rows.reduce((s, it) => s + it.subtotal, 0);
  const isLast = !sum || quoteNo * QUOTE_ROWS_PER_PAGE + rows.length >= sum.items.length;
  const cols = ['5%', '44%', '12%', '9%', '15%', '15%'];
  const heads = ['序号', '设备名称', '品类', '数量', '参考单价', '小计'];
  return (
    <Frame t={t} style={{ padding: '4.5% 5% 5%' }}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ width: '62%' }}>
            <Folio page={page} index={index} t={t} />
            <Claim page={page} t={t} />
            <div style={{ fontSize: 'clamp(6px,1.2cqw,10.5px)', color: t.sub, lineHeight: 1.6, marginTop: '1cqw' }}>{page.body}</div>
          </div>
          <div style={{ width: '30%', background: t.surface, borderRadius: '1.4cqw', boxShadow: CARD_SHADOW, border: `1px solid ${t.accent}1a`, padding: '1.6cqw 2cqw' }}>
            <div style={{ fontSize: 'clamp(6px,1.15cqw,10px)', fontWeight: 800, color: t.sub }}>整包合计（含安装调试）</div>
            <div style={{ fontSize: 'clamp(16px,3.4cqw,30px)', fontWeight: 800, color: t.accent, lineHeight: 1.2, marginTop: '0.5cqw' }}>
              {sum ? `¥${sum.grandTotal.toLocaleString('zh-CN')}` : '—'}
            </div>
            <div style={{ fontSize: 'clamp(5px,1.05cqw,9px)', color: t.sub, marginTop: '0.4cqw' }}>
              {sum ? `设备 ¥${sum.total.toLocaleString('zh-CN')} · 安装调试 ${sum.installRate}% ¥${sum.installFee.toLocaleString('zh-CN')}` : ''}
            </div>
            <div style={{ fontSize: 'clamp(5px,1.05cqw,9px)', color: t.sub, marginTop: '0.2cqw' }}>
              {sum ? `共 ${sum.kindCount} 种设备 · ${sum.deviceCount} 台` : ''}
            </div>
          </div>
        </div>

        <div style={{ flex: 1, marginTop: '1.6cqw', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ display: 'flex', background: t.accent, color: '#FFFFFF', borderRadius: '0.6cqw 0.6cqw 0 0', padding: '0.7cqw 0' }}>
            {heads.map((h, i) => (
              <div key={h} style={{ width: cols[i], fontSize: 'clamp(6px,1.15cqw,10px)', fontWeight: 800, textAlign: i >= 3 ? 'right' : 'left', paddingRight: i >= 3 ? '1cqw' : 0, paddingLeft: i < 3 ? '0.9cqw' : 0 }}>{h}</div>
            ))}
          </div>
          {rows.map((it, ri) => (
            <div key={it.name} style={{ display: 'flex', alignItems: 'center', padding: '0.42cqw 0', background: ri % 2 ? `${t.surface}` : 'transparent', borderBottom: `1px solid ${t.accent}18` }}>
              <div style={{ width: cols[0], fontSize: 'clamp(6px,1.1cqw,9.5px)', fontWeight: 800, color: t.accent, paddingLeft: '0.9cqw' }}>{quoteNo * QUOTE_ROWS_PER_PAGE + ri + 1}</div>
              <div style={{ width: cols[1], fontSize: 'clamp(6px,1.15cqw,10px)', fontWeight: 700, color: t.text, paddingLeft: '0.9cqw', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.name}</div>
              <div style={{ width: cols[2], fontSize: 'clamp(6px,1.05cqw,9px)', color: t.sub, paddingLeft: '0.9cqw' }}>{catMeta(it.category).label}</div>
              <div style={{ width: cols[3], fontSize: 'clamp(6px,1.1cqw,9.5px)', color: t.text, textAlign: 'right', paddingRight: '1cqw' }}>{it.qty}</div>
              <div style={{ width: cols[4], fontSize: 'clamp(6px,1.1cqw,9.5px)', color: t.sub, textAlign: 'right', paddingRight: '1cqw' }}>¥{it.unitPrice.toLocaleString('zh-CN')}</div>
              <div style={{ width: cols[5], fontSize: 'clamp(6px,1.1cqw,9.5px)', fontWeight: 700, color: t.text, textAlign: 'right', paddingRight: '1cqw' }}>¥{it.subtotal.toLocaleString('zh-CN')}</div>
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', paddingTop: '0.8cqw' }}>
            <div style={{ flex: 1 }} />
            {isLast ? (
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '1cqw' }}>
                <span style={{ fontSize: 'clamp(6px,1.1cqw,9.5px)', color: t.sub }}>设备 ¥{(sum?.total ?? 0).toLocaleString('zh-CN')}</span>
                <span style={{ fontSize: 'clamp(6px,1.1cqw,9.5px)', color: t.sub }}>安装调试 {sum?.installRate ?? 0}% ¥{(sum?.installFee ?? 0).toLocaleString('zh-CN')}</span>
                <span style={{ fontSize: 'clamp(6px,1.1cqw,9.5px)', fontWeight: 700, color: t.sub }}>整包合计</span>
                <span style={{ fontSize: 'clamp(7px,1.4cqw,12px)', fontWeight: 800, color: t.accent }}>¥{(sum?.grandTotal ?? 0).toLocaleString('zh-CN')}</span>
              </div>
            ) : (
              <>
                <div style={{ fontSize: 'clamp(6px,1.1cqw,9.5px)', fontWeight: 700, color: t.sub }}>本页小计</div>
                <div style={{ width: '15%', textAlign: 'right', fontSize: 'clamp(6px,1.1cqw,9.5px)', fontWeight: 800, color: t.text, paddingRight: '1cqw' }}>
                  ¥{pageSubtotal.toLocaleString('zh-CN')}
                </div>
              </>
            )}
          </div>
        </div>

        <div style={{ fontSize: 'clamp(5px,1cqw,9px)', color: t.sub, marginTop: '0.8cqw' }}>
          说明：设备价为参考零售价；安装调试费按设备价比例计取（比例在工作台设置里定）。辅材与特殊施工费用按现场实际情况另计。
        </div>
        <div style={{ marginTop: 'auto', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <QuoteBar quote={page.quote} t={t} />
          <Footer plan={plan} t={t} />
        </div>
      </div>
    </Frame>
  );
}

function BudgetSlide({ page, index, plan, t }: { page: PlanPage; index: number; plan: SlidePlan; t: PlanTheme }): ReactNode {
  const items = parseBudget(page.bullets)?.slice(0, 6);
  const maxVal = items ? Math.max(...items.map((it) => it.max)) : 0;
  return (
    <Frame t={t} style={{ padding: '4.5% 5% 5.5%' }}>
      <div style={{ display: 'flex', gap: '4%', height: '100%' }}>
        <div style={{ width: '32%', display: 'flex', flexDirection: 'column' }}>
          <Folio page={page} index={index} t={t} />
          <Claim page={page} t={t} />
          <div style={{ fontSize: 'clamp(6px,1.3cqw,11px)', color: t.sub, lineHeight: 1.75, marginTop: '1.4cqw' }}>{page.body}</div>
          <div style={{ marginTop: 'auto' }}>
            <QuoteBar quote={page.quote} t={t} />
            <div style={{ marginTop: '1.6cqw' }}><Footer plan={plan} t={t} /></div>
          </div>
        </div>
        <div style={{ flex: 1, background: t.surface, borderRadius: '1.8cqw', boxShadow: CARD_SHADOW, border: `1px solid ${t.accent}1a`, padding: '2.6cqw 3cqw', display: 'flex', flexDirection: 'column' }}>
          {items ? (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.8cqw' }}>
                <span style={{ fontSize: 'clamp(6px,1.3cqw,11px)', fontWeight: 800, color: t.text }}>分项预算区间（元）</span>
                <span style={{ fontSize: 'clamp(5px,1.05cqw,9px)', color: t.sub }}>实际报价以现场确认为准</span>
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-around', gap: '1cqw' }}>
                {items.map((it, i) => (
                  <div key={i}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'clamp(6px,1.35cqw,11.5px)', color: t.text, marginBottom: '0.6cqw' }}>
                      <span style={{ fontWeight: 600 }}>{it.name}</span>
                      <span style={{ color: t.accent, fontWeight: 800 }}>{fmt(it.min)}–{fmt(it.max)}</span>
                    </div>
                    <div style={{ height: '1.7cqw', minHeight: 5, background: `${t.accent}14`, borderRadius: '1cqw', overflow: 'hidden' }}>
                      <div style={{ width: `${(it.max / maxVal) * 100}%`, height: '100%', background: `linear-gradient(90deg, ${t.accent}bb, ${t.accent})`, borderRadius: '1cqw', boxShadow: `0 1px 3px ${t.accent}55` }} />
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '1.25cqw', justifyContent: 'center' }}>
              {page.bullets.slice(0, 6).map((b, i) => <PointCard key={i} n={i + 1} text={b} t={t} />)}
            </div>
          )}
        </div>
      </div>
    </Frame>
  );
}

/** 落地交付：顶部文 + 中部时间轴卡列 + 底部引言 */
function DeliverySlide({ page, index, plan, t }: { page: PlanPage; index: number; plan: SlidePlan; t: PlanTheme }): ReactNode {
  const stages = parseStages(page.bullets);
  return (
    <Frame t={t} style={{ padding: '4.5% 5% 5.5%' }}>
      <div style={{ display: 'flex', height: '100%', flexDirection: 'column' }}>
        <div style={{ display: 'flex', gap: '3%', alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Folio page={page} index={index} t={t} />
            <Claim page={page} t={t} />
            <div style={{ fontSize: 'clamp(6px,1.3cqw,11px)', color: t.sub, lineHeight: 1.7, marginTop: '1.2cqw' }}>{page.body}</div>
          </div>
          <ImagePanel src={pageImage(page)} t={t} style={{ width: '24%', height: '13cqw', flex: 'none' }} />
        </div>
        {stages ? (
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${stages.length}, 1fr)`, gap: '1.3cqw', marginTop: '2.4cqw', flex: 1, minHeight: 0, position: 'relative', alignItems: 'center' }}>
            <div style={{ position: 'absolute', top: 'calc(50% - 6.9cqw)', left: '6%', right: '6%', height: 2, background: `linear-gradient(90deg, ${t.accent}22, ${t.accent}, ${t.accent}22)` }} />
            {stages.map((s, i) => (
              <div key={i} style={{ background: t.surface, borderRadius: '1.4cqw', boxShadow: CARD_SHADOW, border: `1px solid ${t.accent}1a`, padding: '1.6cqw 1.2cqw', height: '22cqw', minHeight: 96, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', position: 'relative', overflow: 'hidden' }}>
                <span style={{ position: 'absolute', left: '50%', bottom: '0.6cqw', transform: 'translateX(-50%)', fontSize: 'clamp(24px,6.5cqw,52px)', fontWeight: 800, color: `${t.accent}10`, lineHeight: 1, pointerEvents: 'none' }}>{String(i + 1).padStart(2, '0')}</span>
                <span style={{ position: 'relative', width: '5cqw', height: '5cqw', minWidth: 18, minHeight: 18, borderRadius: '50%', background: `linear-gradient(135deg, ${t.accent}, ${t.accent}bb)`, color: '#fff', fontSize: '1.9cqw', fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 3px 7px ${t.accent}66`, border: '2px solid #fff' }}>
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div style={{ position: 'relative', fontSize: 'clamp(6px,1.4cqw,11.5px)', fontWeight: 800, color: t.text, marginTop: '1.4cqw' }}>{s.name}</div>
                <div style={{ position: 'relative', fontSize: 'clamp(5px,1.05cqw,9px)', color: t.sub, marginTop: '0.7cqw', lineHeight: 1.5 }}>{s.desc}</div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '1.25cqw', marginTop: '2cqw' }}>
            {page.bullets.slice(0, 5).map((b, i) => <PointCard key={i} n={i + 1} text={b} t={t} />)}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: '2cqw', marginTop: '2cqw' }}>
          <div style={{ flex: 1 }}><QuoteBar quote={page.quote} t={t} /></div>
          <Footer plan={plan} t={t} />
        </div>
      </div>
    </Frame>
  );
}

/**
 * 户型与设备点位页。
 *
 * 为什么单独一页：空间动线页里的户型图要和文案并排，只占三成宽，
 * 客户现场根本看不清点位。门店真正要给客户看的是「哪台装在哪」，
 * 得一张整页大图 —— 页数公式同样把户型图算成独立页
 * （`app.js:3427`：`核心模块 + 额外户型图 + 素材展示页`）。
 *
 * 图用 contain 而不是 cover：户型图被裁掉一半比看不清楚更严重。
 */
function FloorplanSlide({ page, index, plan, t, listNo = 0 }: { page: PlanPage; index: number; plan: SlidePlan; t: PlanTheme; listNo?: number }): ReactNode {
  const images = floorplanImages(plan);
  const { src: visual, label, fit } = useFloorplanVisual(plan);
  const src = visual || plan.floorplanUrl || pageImage(page);
  const points = plan.layoutPoints ?? [];
  const fpTpl = floorplanTemplate(plan.floorplanTemplate);
  /**
   * 与 PPTX **同口径**（planPptx.floorplanSlide）：
   * 编号清单的判定直接用 `deliverPointCount` —— 页序与画不画清单是同一份口径。
   * - render / compare 模版图上没有徽章，不列编号清单（否则客户按编号回图里找，找不到）
   * - icon 模版标记上是产品图，编号无意义，只列品类汇总
   *
   * 之前这里只做品类汇总，编号清单与图例都只在 PPTX 里 —— 门店在页面上看到的
   * 和客户收到的 PPT 不是同一份东西。
   */
  const numbered = deliverPointCount(plan) > 0;
  /**
   * compare（原图对照）模版：左客户原图、右 AI 精装修效果图，并排对照。
   *
   * 以前前端**完全没有**这个分支 —— 门店在页面上预览看到的是单图，
   * 客户在 PPT 里收到的是左右对照，两边对不上。
   * 两张都不叠点位（AI 图是模型重画的，叠上去必然错位），编号清单因此也不出。
   */
  const isCompare = fpTpl === 'compare' && Boolean(images.compareLeft && images.compareRight);
  const start = listNo * POINT_ROWS_PER_PAGE;
  const rows = numbered ? points.slice(start, start + POINT_ROWS_PER_PAGE) : [];
  const remaining = numbered ? Math.max(0, points.length - start - rows.length) : 0;
  // 品类汇总：全量不截断（截断会让客户看不到自己买的那几类）
  const summary = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of points) m.set(p.category, (m.get(p.category) ?? 0) + 1);
    return [...m.entries()].map(([category, count]) => ({ label: catMeta(category).label, color: catMeta(category).color, count }));
  }, [points]);
  // 图例：品类色块 + 名称 + 数量。行业规范要求「每张规范的图纸都有符号说明」，
  // 这里不按数量截断 —— 图上有 7 种颜色的点，图例只写 5 种，客户会对不上。
  const legend = summary;

  return (
    <Frame t={t} style={{ padding: '4.5% 5% 5.5%' }}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{ display: 'flex', gap: '4%', flex: 1, minHeight: 0 }}>
          {isCompare ? (
            <>
              <ImagePanel
                src={images.compareLeft as string}
                t={t}
                label={COMPARE_LEFT_LABEL}
                fit="contain"
                style={{ flex: 1, minWidth: 0 }}
              />
              <ImagePanel
                src={images.compareRight as string}
                t={t}
                label={images.compareRightLabel}
                fit="contain"
                style={{ flex: 1, minWidth: 0 }}
              />
            </>
          ) : (
            <ImagePanel
              src={src}
              t={t}
              label={label}
              fit={fit}
              style={{ flex: 1, minWidth: 0 }}
            />
          )}
          <div style={{ width: '30%', flex: 'none', display: 'flex', flexDirection: 'column' }}>
            <Folio page={page} index={index} t={t} label={floorplanPageCopy(fpTpl).typeLabel} />
            <Claim page={page} t={t} size="clamp(8px,2.2cqw,17px)" />
            <div style={{ fontSize: 'clamp(6px,1.3cqw,11px)', color: t.sub, lineHeight: 1.75, marginTop: '1.4cqw' }}>{page.body}</div>
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: '0.8cqw', marginTop: '1.8cqw' }}>
              {numbered
                ? rows.map((pt, ri) => {
                  const no = start + ri + 1;
                  const meta = catMeta(pt.category);
                  return (
                    <div key={`${pt.name}-${no}`} style={{ display: 'flex', alignItems: 'center', gap: '0.8cqw', padding: '0.35cqw 0.7cqw', background: t.surface, borderRadius: '0.6cqw', border: `1px solid ${t.accent}1a`, flex: '1 1 0', minHeight: 0 }}>
                      <span style={{ width: '1.6cqw', height: '1.6cqw', minWidth: '1.6cqw', borderRadius: '50%', background: meta.color, color: '#fff', fontSize: 'clamp(5px,0.85cqw,8px)', fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>{no}</span>
                      <span style={{ fontSize: 'clamp(5px,1.05cqw,9.5px)', color: t.text, fontWeight: 700, flex: 1, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap' }}>{pt.name}</span>
                      {/* 房间列：与 PPTX 同口径。没有房间名时不渲染（不写占位符） */}
                      {pt.room ? (
                        <span style={{ fontSize: 'clamp(5px,0.9cqw,8px)', color: t.accent, flex: 'none', maxWidth: '5.6cqw', overflow: 'hidden', whiteSpace: 'nowrap' }}>{pt.room}</span>
                      ) : null}
                      <span style={{ fontSize: 'clamp(5px,0.95cqw,8.5px)', color: t.sub, flex: 'none' }}>{meta.label}</span>
                    </div>
                  );
                })
                : summary.map((s) => (
                  <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: '1.2cqw', padding: '0.7cqw 1.2cqw', background: t.surface, borderRadius: '1cqw', border: `1px solid ${t.accent}1a`, flex: '1 1 0', minHeight: 0 }}>
                    <span style={{ fontSize: 'clamp(6px,1.25cqw,10.5px)', color: t.text, fontWeight: 700, flex: 1, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap' }}>{s.label}</span>
                    <span style={{ fontSize: 'clamp(6px,1.5cqw,12px)', color: t.accent, fontWeight: 800 }}>{s.count}</span>
                  </div>
                ))}
            </div>
            {remaining > 0 ? (
              <div style={{ fontSize: 'clamp(5px,0.95cqw,8.5px)', color: t.accent, textAlign: 'right', marginTop: '0.5cqw' }}>
                续下页 · 还有 {remaining} 台
              </div>
            ) : null}
          </div>
        </div>
        {/* 图例：与 PPTX 同款（全量不截断），多行自动换行 */}
        {legend.length ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.4cqw 1.1cqw', marginTop: '1.2cqw' }}>
            <span style={{ fontSize: 'clamp(5px,0.95cqw,8.5px)', color: t.sub, fontWeight: 700, flex: 'none' }}>图例</span>
            {legend.map((l) => (
              <span key={l.label} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4cqw', fontSize: 'clamp(5px,0.95cqw,8.5px)', flex: 'none' }}>
                <span style={{ width: '0.8cqw', height: '0.8cqw', minWidth: '0.8cqw', borderRadius: '50%', background: l.color, display: 'inline-block' }} />
                <span style={{ color: t.sub }}>{l.label}</span>
                <span style={{ color: t.accent, fontWeight: 800 }}>{l.count}</span>
              </span>
            ))}
          </div>
        ) : null}
        <div style={{ display: 'flex', alignItems: 'center', gap: '2cqw', marginTop: '1.8cqw' }}>
          <div style={{ flex: 1 }}><QuoteBar quote={page.quote} t={t} /></div>
          <Footer plan={plan} t={t} />
        </div>
      </div>
    </Frame>
  );
}
