/**
 * 默认对话模型（唯一事实源）
 *
 * 运行时兜底、「模型配置」页默认值、连通性测试、前端展示文案全部取这里。
 * 之前这些值散落在十余个文件里手写字符串，改一处漏一处就会漂
 * （版本号就是这么漂成三处不一致的），故收敛到常量并由 smoke 断言守一致性。
 *
 * 取值依据（2026-10-21 对 MiniMax OpenAI 兼容端点实测）：
 * - `MiniMax-M3.1-Flash` 可用，支持 `response_format=json_object`，reasoning token 很小
 *   （实测 44），结构化输出（接单解析、方案生成）比纯 reasoning 模型更稳；
 * - 纯 `MiniMax-M3.1` **不存在**，API 报 `unknown model 'minimax-m3.1'`，不要照字面写；
 * - `MiniMax-M3` 仍可用，但把思考过程内嵌在 content 里（需剥离），且实测明显更慢更贵。
 *
 * 客户自部署时用「模型配置」页换成自己的云端或本地模型（Ollama / LM Studio / vLLM 等
 * OpenAI 兼容端点）即可，这里的默认值只影响「还没配置时」的兜底行为。
 */
export const DEFAULT_CHAT_MODEL = 'MiniMax-M3.1-Flash';
