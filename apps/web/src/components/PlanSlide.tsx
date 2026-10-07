import { PAGE_TYPE_LABEL, PAGE_IMAGE, sceneImage, imgFilter, imgPosition, imgSize, CARD_SHADOW, CARD_SHADOW_SOFT, type PlanPage, type PlanTheme } from '../data/planThemes';
import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { compositePoints, type PointLike } from '../lib/pointOverlay';

interface SlidePlan {
  store: string;
  /** 客户户型平面图（点位编辑器挂接；空间动线页优先用它+点位叠加） */
  floorplanUrl?: string | null;
  layoutPoints?: PointLike[] | null;
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

/** 页型→配图（场景页按副标题细化） */
function pageImage(page: PlanPage): string {
  return page.type === 'scene' ? sceneImage(page.subtitle + page.heading) : PAGE_IMAGE[page.type];
}

export function PlanSlide({ page, index, plan, t }: { page: PlanPage; index: number; plan: SlidePlan; t: PlanTheme }): ReactNode {
  switch (page.type) {
    case 'cover': return <CoverSlide page={page} plan={plan} t={t} />;
    case 'brand': return <BrandSlide page={page} index={index} plan={plan} t={t} />;
    case 'layout': return <LayoutSlide page={page} index={index} plan={plan} t={t} />;
    case 'needs': return <NeedsSlide page={page} index={index} plan={plan} t={t} />;
    case 'ecosystem': return <EcosystemSlide page={page} index={index} plan={plan} t={t} />;
    case 'scene': return <SceneSlide page={page} index={index} plan={plan} t={t} />;
    case 'budget': return <BudgetSlide page={page} index={index} plan={plan} t={t} />;
    case 'delivery': return <DeliverySlide page={page} index={index} plan={plan} t={t} />;
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

function Folio({ page, index, t }: { page: PlanPage; index: number; t: PlanTheme }): ReactNode {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: '1.6cqw' }}>
      <span style={{ fontSize: 'clamp(6px,1.3cqw,11px)', fontWeight: 800, color: t.accent, letterSpacing: '0.1em' }}>
        {String(index + 1).padStart(2, '0')}
      </span>
      <span style={{ width: 2, height: '1.6cqw', minHeight: 8, background: t.accent, alignSelf: 'center' }} />
      <span style={{ fontSize: 'clamp(6px,1.3cqw,11px)', fontWeight: 700, color: t.text }}>{PAGE_TYPE_LABEL[page.type]}</span>
      {page.subtitle ? <span style={{ fontSize: 'clamp(5px,1.15cqw,10px)', color: t.sub, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{page.subtitle}</span> : null}
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
    <div style={{ display: 'flex', alignItems: 'center', gap: '1.6cqw', background: t.surface, borderRadius: '1.4cqw', padding: '1.3cqw 1.8cqw', boxShadow: CARD_SHADOW, border: `1px solid ${t.accent}1a` }}>
      <span style={{ width: '3.4cqw', height: '3.4cqw', minWidth: 13, minHeight: 13, borderRadius: '50%', background: `linear-gradient(135deg, ${t.accent}, ${t.accent}bb)`, color: '#fff', fontSize: '1.5cqw', fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none', boxShadow: `0 2px 5px ${t.accent}66` }}>
        {String(n).padStart(2, '0')}
      </span>
      <span style={{ fontSize: 'clamp(6px,1.45cqw,12px)', color: t.text, lineHeight: 1.5 }}>
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
    <Frame t={t} style={{ padding: '4.5% 5% 3.5%' }}>
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

/** 空间动线：左竖实景图 + 右编号要点卡列；挂接了户型图则左图换成"户型+点位"合成图（与 PPTX 共用 compositePoints，像素一致） */
function LayoutSlide({ page, index, plan, t }: { page: PlanPage; index: number; plan: SlidePlan; t: PlanTheme }): ReactNode {
  const hasFloorplan = Boolean(plan.floorplanUrl && plan.layoutPoints?.length);
  const [composite, setComposite] = useState<string | null>(null);
  useEffect(() => {
    if (!hasFloorplan) {
      setComposite(null);
      return;
    }
    let alive = true;
    void compositePoints(plan.floorplanUrl as string, plan.layoutPoints ?? [], 1200)
      .then((url) => { if (alive) setComposite(url); })
      .catch(() => { if (alive) setComposite(null); });
    return () => { alive = false; };
  }, [hasFloorplan, plan.floorplanUrl, plan.layoutPoints]);
  const src = hasFloorplan ? composite ?? (plan.floorplanUrl as string) : pageImage(page);
  return (
    <Frame t={t} style={{ padding: '4.5% 5% 3.5%' }}>
      <div style={{ display: 'flex', gap: '4%', height: '100%' }}>
        <ImagePanel
          src={src}
          t={t}
          label={hasFloorplan ? '客户户型 · 设备点位图' : '空间动线实景'}
          fit={hasFloorplan ? 'contain' : 'cover'}
          style={{ width: '32%', flex: 'none' }}
        />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <Folio page={page} index={index} t={t} />
          <Claim page={page} t={t} />
          <div style={{ fontSize: 'clamp(6px,1.35cqw,11.5px)', color: t.sub, lineHeight: 1.75, marginTop: '1.4cqw', marginBottom: '1.6cqw' }}>{page.body}</div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '1.1cqw' }}>
            {page.bullets.slice(0, 6).map((b, i) => <PointCard key={i} n={i + 1} text={b} t={t} />)}
          </div>
          <div style={{ marginTop: '1.4cqw', display: 'flex', alignItems: 'center', gap: '2cqw' }}>
            <QuoteBar quote={page.quote} t={t} />
          </div>
          <div style={{ marginTop: '1.2cqw' }}><Footer plan={plan} t={t} /></div>
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
      <div style={{ padding: '2.6cqw 5% 3%', display: 'flex', gap: '3.5%', height: '64%' }}>
        <div style={{ width: '34%', display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 'clamp(6px,1.35cqw,11.5px)', color: t.sub, lineHeight: 1.8 }}>{page.body}</div>
          <div style={{ marginTop: 'auto' }}><QuoteBar quote={page.quote} t={t} /></div>
          <div style={{ marginTop: '1.2cqw' }}><Footer plan={plan} t={t} /></div>
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '1.1cqw' }}>
          {page.bullets.slice(0, 5).map((b, i) => <PointCard key={i} n={i + 1} text={b} t={t} />)}
        </div>
      </div>
    </Frame>
  );
}

/** 生态规划：右图 + 左文 + 底部生态卡横排 */
function EcosystemSlide({ page, index, plan, t }: { page: PlanPage; index: number; plan: SlidePlan; t: PlanTheme }): ReactNode {
  return (
    <Frame t={t} style={{ padding: '4.5% 5% 3.5%' }}>
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
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '1.1cqw' }}>
          {page.bullets.slice(0, 5).map((b, i) => <PointCard key={i} n={i + 1} text={b} t={t} />)}
        </div>
        <div style={{ marginTop: '1.6cqw' }}><QuoteBar quote={page.quote} t={t} /></div>
        <div style={{ marginTop: '1.2cqw' }}><Footer plan={plan} t={t} /></div>
      </div>
    </Frame>
  );
}

/** 预算规划：左文+合规，右阴影面板内条形图 */
function BudgetSlide({ page, index, plan, t }: { page: PlanPage; index: number; plan: SlidePlan; t: PlanTheme }): ReactNode {
  const items = parseBudget(page.bullets)?.slice(0, 6);
  const maxVal = items ? Math.max(...items.map((it) => it.max)) : 0;
  return (
    <Frame t={t} style={{ padding: '4.5% 5% 3.5%' }}>
      <div style={{ display: 'flex', gap: '4%', height: '100%' }}>
        <div style={{ width: '32%', display: 'flex', flexDirection: 'column' }}>
          <Folio page={page} index={index} t={t} />
          <Claim page={page} t={t} />
          <div style={{ fontSize: 'clamp(6px,1.3cqw,11px)', color: t.sub, lineHeight: 1.75, marginTop: '1.4cqw' }}>{page.body}</div>
          <div style={{ marginTop: 'auto' }}>
            <QuoteBar quote={page.quote} t={t} />
            <div style={{ marginTop: '1.2cqw' }}><Footer plan={plan} t={t} /></div>
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
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '1.1cqw', justifyContent: 'center' }}>
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
    <Frame t={t} style={{ padding: '4.5% 5% 3.5%' }}>
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
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '1.1cqw', marginTop: '2cqw' }}>
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
