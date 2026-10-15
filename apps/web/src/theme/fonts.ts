/**
 * 字体栈（0.1.57 收敛为单一来源）
 *
 * ## 许可证立场（重要，别改错）
 *
 * 本项目**不打包任何字体文件**（仓库内无 woff/ttf/otf/eot，smoke 有断言守着）。
 * 字体栈里写的都是**系统字体名**——按名字引用系统已安装的字体是业界标准做法，
 * **不构成字体再分发**，因此引用 PingFang SC / 微软雅黑这类商业字体并不违反其许可。
 *
 * ## 那为什么要改
 *
 * 不是许可问题，是**交付质量问题**：原栈的第一顺位全是 mac 字体、Windows 落到微软雅黑，
 * 而精简版 Linux / Chromium OS 上**根本没有中文字体**，于是：
 *   - canvas 生成的点位图标注、WiFi 热力图上的中文会变成豆腐块 □□□
 *   - PPTX 里写死的字体名在缺字体的机器上被替换，字距全变
 * 所以在系统字体之后补上两个 **SIL OFL 1.1（免费商用）** 的开源中文字体兜底：
 *   - `Noto Sans SC`（Google）/ `Source Han Sans SC`（Adobe）—— 同一套字形，两个名字
 *   - OFL 1.1 原文：https://github.com/googlefonts/noto-cjk/blob/main/Sans/LICENSE
 *   - 关键条款：「The requirement for fonts to remain under this license does not apply
 *     to any document created using the fonts」——用它们生成的 PPT/PNG 不受许可约束
 *   - OFL 1.1 允许免费商用、允许随软件捆绑分发，唯一禁止是**单独出售字体文件**
 *
 * 本项目不打包字体，所以只用到「按名引用」这一条，风险为零。
 *
 * ## 使用
 *
 * - Web 界面：`FONT_STACK_CSS`
 * - canvas 绘制（点位图 / 热力图 / 灯光图）：`FONT_STACK_CANVAS` —— canvas 的 font 属性
 *   不吃逗号分隔的完整栈时，用 `FONT_STACK_CANVAS_FIRST` 只取首个可用名
 * - PPTX：`FONT_PPTX` —— pptxgenjs 只接受**单个**字体名，写栈会失效
 */

/**
 * 字体栈的**唯一来源是 styles.css 的 `:root { font-family }`**，
 * 这里用 Vite 的 `?raw` 直接读取并提取，不再维护第二份副本。
 *
 * 为什么不各写一份：0.1.57 最初把 CSS 栈与 TS 常量分开写了两遍，
 * 结果 smoke 立刻报「两者不一致」——两份副本本身就是漂移风险源。
 * 一份之后就不可能不一致。
 */
import cssSource from '../styles.css?raw';

const CSS_FONT_STACK = (cssSource.match(/font-family:\s*([^;]+);/) ?? [, ''])[1]
  .replace(/\/\*[^]*?\*\//g, '')
  .replace(/\s+/g, ' ')
  .trim();

/** 若提取失败（例如 CSS 结构变了），必须炸出来而不是静默给一个空字体栈 */
if (!CSS_FONT_STACK || !CSS_FONT_STACK.includes('Microsoft YaHei')) {
  throw new Error(
    '字体栈提取失败：styles.css 里 :root 的 font-family 未找到或结构已变。'
    + '请更新 apps/web/src/theme/fonts.ts 的提取正则。',
  );
}

/**
 * CSS font-family 完整栈（含 OFL 开源中文兜底，详见文件头许可证说明）。
 * canvas 的 ctx.font 同样接受这个逗号分隔的候选列表。
 */
export const FONT_STACK_CSS = CSS_FONT_STACK;

/** canvas 绘制（点位图 / 热力图 / 灯光图）用同一份栈 */
export const FONT_STACK_CANVAS = CSS_FONT_STACK;

/**
 * PPTX 专用：pptxgenjs 只接受单个字体名。
 *
 * 选微软雅黑是因为中文用户里 Windows 占比最高、客户机大概率已装。
 * macOS 用户打开时 PowerPoint 会自行替换为系统中文字体（字距会有差异），
 * 这是格式限制而非许可问题 —— 换任何单名都有同样问题，除非随包分发字体（那才需要 OFL 全文）。
 */
export const FONT_PPTX = 'Microsoft YaHei';
