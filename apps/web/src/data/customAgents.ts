import { api } from '../lib/api';

/**
 * 自建智能体：落库持久化（CustomAgent 表）。
 * 早期版本存 localStorage，换设备/清缓存即丢；现在是真正的租户级数据，团队成员可见。
 */

export interface CustomAgent {
  id: string;
  name: string;
  description: string;
  /** 自定义 system prompt（人设），对话时注入 */
  systemPrompt: string;
  avatarColor: string;
  enabled: boolean;
  createdAt: string;
}

export async function listCustomAgents(): Promise<CustomAgent[]> {
  return api<CustomAgent[]>('/api/agents');
}

export async function createCustomAgent(input: { name: string; description?: string; systemPrompt: string; avatarColor?: string }): Promise<CustomAgent> {
  return api<CustomAgent>('/api/agents', { method: 'POST', body: JSON.stringify(input) });
}

export async function updateCustomAgent(id: string, patch: Partial<Pick<CustomAgent, 'name' | 'description' | 'systemPrompt' | 'avatarColor' | 'enabled'>>): Promise<CustomAgent> {
  return api<CustomAgent>(`/api/agents/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export async function deleteCustomAgent(id: string): Promise<void> {
  await api(`/api/agents/${id}`, { method: 'DELETE' });
}