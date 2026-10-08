/** 自建智能体（localStorage 持久化；后端 agents 表 0.2.0 接入后替换为 API） */
export interface CustomAgent {
  id: string;
  name: string;
  description: string;
  /** 自定义 system prompt（人设），对话时注入 */
  systemPrompt: string;
  createdAt: number;
}

const STORAGE_KEY = 'ai_custom_agents';

export function loadCustomAgents(): CustomAgent[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as CustomAgent[]) : [];
  } catch {
    return [];
  }
}

export function saveCustomAgents(list: CustomAgent[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}
