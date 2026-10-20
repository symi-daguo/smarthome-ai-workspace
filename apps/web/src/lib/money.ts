/** 记账单位 token 与展示单位元的换算（100 token = ¥1 仅为展示层口径，实际计费由部署者配置） */
const TOKENS_PER_YUAN = 100;

export function tokenToYuan(tokens: number): string {
  return `¥${(tokens / TOKENS_PER_YUAN).toFixed(2)}`;
}
