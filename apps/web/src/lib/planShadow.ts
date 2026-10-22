/**
 * PPTX 阴影参数。
 *
 * ⚠️ 这里必须是**工厂函数**，不能是共享常量 —— 这是实测踩过的坑。
 *
 * pptxgenjs 4.0.1 在生成**文字**阴影的 XML 时会**原地改写**传入的 shadow 对象：
 * 它把 pt 换算成 EMU、把 opacity 换算成 alpha，直接写回那个对象
 * （pptxgenjs.cjs.js 里 `slideItemObj.options.shadow.blur = valToPts(...)` 那几行）。
 *
 * 如果把 shadow 定义成模块级常量再到处复用，每用一次就被**再换算一次**：
 *   第 1 次  blur 10 → 127000（EMU）
 *   第 2 次  127000 → 127000 × 12700
 *   第 3 次  再乘一次……
 * 几十次之后，导出的 XML 里就是这些数：
 *   blurRad="2.4405380440023213e+95"  dist="7.321614132006959e+94"
 *   dir="972000000000"  alpha="75000000000000000000"
 *
 * 后果不是「阴影不好看」，而是**整个形状不显示**：
 * PowerPoint / WPS 解析阴影参数失败，那一页的形状整块被跳过，
 * 用户看到的现象是「要点播放才能看到」「预览框在但内容不出来」。
 * 实测这份 PPTX 的 15 页里 14 页的阴影参数是天文数字。
 *
 * 每次调用返回新对象，pptxgenjs 改的是副本，定义本身永远干净。
 */
export interface PptxShadow {
  type: 'outer';
  color: string;
  /** pt */
  blur: number;
  /** pt */
  offset: number;
  /** 度 */
  angle: number;
  /** 0-1 */
  opacity: number;
}

/** 卡片阴影（主） */
export function cardShadow(): PptxShadow {
  return { type: 'outer', color: '1E160E', blur: 10, offset: 3, angle: 90, opacity: 0.16 };
}

/** 卡片阴影（轻） */
export function cardShadowSoft(): PptxShadow {
  return { type: 'outer', color: '1E160E', blur: 6, offset: 2, angle: 90, opacity: 0.1 };
}

/**
 * 阴影参数是否仍在合法范围内。
 *
 * 给自检脚本用：pptxgenjs 改过之后，opacity 会变成 alpha 值（0.16 → 16000）、
 * blur 会变成 EMU（10 → 127000），两者都越界 —— 这就是「被污染」的信号。
 */
export function shadowParamsSafe(s: PptxShadow): boolean {
  return (
    Number.isFinite(s.blur) && s.blur >= 0 && s.blur <= 200
    && Number.isFinite(s.offset) && s.offset >= 0 && s.offset <= 200
    && Number.isFinite(s.angle) && s.angle >= 0 && s.angle <= 360
    && Number.isFinite(s.opacity) && s.opacity >= 0 && s.opacity <= 1
  );
}
