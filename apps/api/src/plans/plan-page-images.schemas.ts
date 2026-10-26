import { z } from 'zod';

/**
 * 页型标识（pageType）的取值形态校验。
 *
 * 为什么只校验形态、**不校验具体取值**：
 * 页型清单的唯一来源在前端 `apps/web/src/data/planThemes.ts` 的 `PAGE_IMAGE`
 * （`PlanPage['type']` 就是它的键）。后端再抄一份枚举必然与前端漂移 ——
 * 前端加一个页型，后端就开始拒收该页型的配图，且没有任何提示。
 * 所以这里只保证「是个像页型的标识」，具体页型合不合法由前端负责。
 */
export const pageTypeSchema = z
  .string()
  .min(1, '页型不能为空')
  .max(32, '页型标识过长')
  .regex(/^[a-z][a-z0-9_]*$/, '页型标识只能是小写字母、数字与下划线');

/** 指定页型的配图素材 */
export const setPageImageSchema = z.object({
  /** 素材 id（MediaAsset.id）；服务端会校验它属于当前租户 */
  mediaAssetId: z.string().uuid('素材 id 不合法'),
});
export type SetPageImageDto = z.infer<typeof setPageImageSchema>;
