import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { useActiveConfig } from '../lib/configStore';
import { DEFAULT_CHAT_MODEL } from '../theme/tokens';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
}

/** 随请求上行的附件最小形状（内容用 dataURL 内联） */
export interface SendAttachment {
  name: string;
  dataUrl: string;
}

export interface WorkbenchConversation {
  key: string;
  label: string;
  messages: ChatMessage[];
  updatedAt: number;
  /** 由智能体市场进入时记录的智能体名 */
  agent?: string;
  /** 自建智能体的自定义人设（有值时优先于内置 systemPromptFor） */
  systemPrompt?: string;
}

/** 任务球使用的轻量生成任务队列（"生成任务"面板） */
export interface GenTask {
  id: string;
  title: string;
  status: 'running' | 'done';
  createdAt: number;
}

const CONV_STORAGE_KEY = 'ai_workbench_conversations_v1';
const TASK_STORAGE_KEY = 'ai_generation_tasks_v1';

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadList<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as T[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 落盘时保留的最近条数（会话 / 任务各一份） */
const MAX_PERSIST_ITEMS = 20;

/**
 * 落盘一份列表：**只写最近 N 条**，写入撞上配额时再砍一半重试一次。
 *
 * 为什么必须裁：
 * - 会话正文越存越大，而 localStorage 只有 5MB 上限；
 * - 全量写一旦撞上配额，`setItem` 直接抛 QuotaExceededError ——
 *   那一次之后**整份历史都存不下去**（不是只丢最新的一条，是从此再也写不进去），
 *   页面却看不出哪里出了问题。
 *
 * 为什么失败不抛：内存里的数据还在，只是这一次没落盘。
 * 抛出去会把「写本地存储失败」变成一次白屏级异常，比少几条历史糟得多。
 */
function persistList<T>(key: string, list: T[]): void {
  // 列表是**新的在前**（setConversations / setTasks 都是 [new, ...prev]），
  // 所以取头部就是最近的那些。
  const trimmed = list.length > MAX_PERSIST_ITEMS ? list.slice(0, MAX_PERSIST_ITEMS) : list;
  try {
    localStorage.setItem(key, JSON.stringify(trimmed));
  } catch (err) {
    // 配额异常：砍掉最旧的一半（旧的在尾部）再试一次
    console.warn('[ChatStore] 本地存储写入失败，裁剪后重试', err);
    const half = trimmed.slice(0, Math.ceil(trimmed.length / 2));
    try {
      localStorage.setItem(key, JSON.stringify(half));
    } catch (err2) {
      console.warn('[ChatStore] 裁剪后仍无法写入本地存储，本次不落盘', err2);
    }
  }
}

/** 后端 LLM 不可用时的兜底回复（key 未配置或上游异常） */
function offlineReply(prompt: string): string {
  return '模型服务暂时不可用（API Key 未配置或上游异常），已记录你的需求：「' + prompt.slice(0, 30) + '」。请在「系统管理 - 模型配置」检查 provider 与 Key 后重试。';
}

/** 智能体人设：按市场卡片名称注入 system prompt */
function systemPromptFor(agent?: string): string {
  if (!agent || agent.includes('通用对话')) {
    return '你是智能家居 AI 工作站的助手，服务智能家居服务商（门店老板、销售、设计师）。回答简洁实用，中文，优先给出可直接使用的文案、脚本或方案要点。';
  }
  if (agent.includes('朋友圈')) {
    return '你是朋友圈文案智能体。为智能家居服务商写朋友圈文案：口语化、有现场感，200 字内，结尾给发布建议（配图与定位）。不要使用夸张承诺。';
  }
  if (agent.includes('短视频脚本') || agent.includes('脚本')) {
    return '你是短视频脚本智能体。输出分镜脚本：镜头序号、画面、口播、时长，适合工地实拍或产品演示，中文。';
  }
  if (agent.includes('直播')) {
    return '你是直播逐字稿智能体。按开场、卖点讲解、互动、逼单四段输出完整逐字稿，中文。';
  }
  if (agent.includes('小红书')) {
    return '你是小红书图文智能体。输出标题、正文、标签，风格真实分享，避免硬广与违规词。';
  }
  if (agent.includes('投流')) {
    return '你是本地推投流文案智能体。按城市+门店+服务区域产出投放文案与人群定向建议，中文。';
  }
  if (agent.includes('诊断')) {
    return '你是经营问题诊断智能体。先定位问题环节（获客/转化/交付），再给 3 条可执行建议，中文。';
  }
  if (agent.includes('方案')) {
    return '你是全屋智能方案助手。按空间逐个列出设备与场景联动，给出预算区间，中文。';
  }
  return `你是「${agent}」智能体，围绕智能家居业务回答用户问题，中文，给出可直接使用的成果。`;
}

interface ChatStoreValue {
  conversations: WorkbenchConversation[];
  activeConversation: WorkbenchConversation | null;
  activeKey: string | null;
  setActiveKey: (key: string | null) => void;
  createNew: () => void;
  remove: (key: string) => void;
  send: (text: string, agent?: string, systemPrompt?: string, attachments?: SendAttachment[]) => void;
  sending: boolean;
  tasks: GenTask[];
  clearFinished: () => void;
  unreadDone: number;
  markTasksRead: () => void;
}

const ChatStoreContext = createContext<ChatStoreValue | null>(null);

export function ChatStoreProvider({ children }: { children: ReactNode }): ReactNode {
  const [conversations, setConversations] = useState<WorkbenchConversation[]>(() =>
    loadList<WorkbenchConversation>(CONV_STORAGE_KEY),
  );
  const [tasks, setTasks] = useState<GenTask[]>(() => loadList<GenTask>(TASK_STORAGE_KEY));
  const [readAt, setReadAt] = useState<number>(() => Number(localStorage.getItem('ai_task_read_at') ?? 0));
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // 读取当前激活模型方案（ConfigProvider 注入），发送时把模型名传给后端
  const { config } = useActiveConfig();

  useEffect(() => {
    persistList(CONV_STORAGE_KEY, conversations);
  }, [conversations]);

  useEffect(() => {
    persistList(TASK_STORAGE_KEY, tasks);
  }, [tasks]);

  const activeConversation = conversations.find((c) => c.key === activeKey) ?? null;

  const createNew = useCallback(() => {
    setActiveKey(null);
  }, []);

  const remove = useCallback(
    (key: string) => {
      setConversations((prev) => prev.filter((c) => c.key !== key));
      if (activeKey === key) setActiveKey(null);
    },
    [activeKey],
  );

  const send = useCallback(
    (text: string, agent?: string, systemPrompt?: string, attachments?: SendAttachment[]) => {
      const content = text.trim();
      if (!content || sending) return;

      const userMessage: ChatMessage = { id: uid(), role: 'user', content, createdAt: Date.now() };
      // 新会话的 key 在状态更新前确定，避免在 updater 内产生副作用
      const existingConv = activeKey ? conversations.find((c) => c.key === activeKey) : undefined;
      const convKey = existingConv ? existingConv.key : uid();
      const taskId = uid();
      // 续聊沿用会话原有人设；新会话用本次传入的
      const effAgent = existingConv?.agent ?? agent;
      const effPrompt = existingConv?.systemPrompt ?? systemPrompt;

      setTasks((prev) => [
        { id: taskId, title: content.length > 20 ? `${content.slice(0, 20)}…` : content, status: 'running', createdAt: Date.now() },
        ...prev,
      ]);

      if (existingConv) {
        setConversations((prev) =>
          prev.map((c) =>
            c.key === convKey
              ? { ...c, messages: [...c.messages, userMessage], updatedAt: Date.now() }
              : c,
          ),
        );
      } else {
        const created: WorkbenchConversation = {
          key: convKey,
          label: content.length > 18 ? `${content.slice(0, 18)}…` : content,
          messages: [userMessage],
          updatedAt: Date.now(),
          agent,
          systemPrompt,
        };
        setConversations((prev) => [created, ...prev]);
        setActiveKey(convKey);
      }
      setSending(true);

      const finish = (replyText: string): void => {
        const reply: ChatMessage = {
          id: uid(),
          role: 'assistant',
          content: replyText,
          createdAt: Date.now(),
        };
        setConversations((prev) =>
          prev.map((c) =>
            c.key === convKey
              ? { ...c, messages: [...c.messages, reply], updatedAt: Date.now() }
              : c,
          ),
        );
        setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: 'done' } : t)));
        setSending(false);
      };

      // 真实调用后端 LLM；key 缺失/上游异常时降级为离线说明，不阻塞会话
      api<{ reply: string }>('/api/llm/chat', {
        method: 'POST',
        body: JSON.stringify({
          model: config.chatModel || DEFAULT_CHAT_MODEL,
          prompt: content,
          systemPrompt: effPrompt ?? systemPromptFor(effAgent),
          // 附件真内容随请求上行；此前只把「文件名(类型,大小)」拼进 prompt，
          // 模型其实什么都没看到（见 llm.service.ts 的 buildUserContent 注释）
          ...(attachments?.length
            ? { attachments: attachments.map((a) => ({ name: a.name, dataUrl: a.dataUrl })) }
            : {}),
        }),
      })
        .then((r) => finish(r.reply))
        .catch(() => finish(offlineReply(content)));
    },
    [activeKey, conversations, sending, config.chatModel],
  );

  const clearFinished = useCallback(() => {
    setTasks((prev) => prev.filter((t) => t.status !== 'done'));
  }, []);

  const markTasksRead = useCallback(() => {
    const now = Date.now();
    setReadAt(now);
    try {
      localStorage.setItem('ai_task_read_at', String(now));
    } catch (err) {
      // 配额满时「标记已读」不该把整个回调炸掉：内存里的已读状态已经生效
      console.warn('[ChatStore] 已读标记写入失败', err);
    }
  }, []);

  const unreadDone = useMemo(
    () => tasks.filter((t) => t.status === 'done' && t.createdAt > readAt).length,
    [tasks, readAt],
  );

  const value = useMemo(
    () => ({
      conversations,
      activeConversation,
      activeKey,
      setActiveKey,
      createNew,
      remove,
      send,
      sending,
      tasks,
      clearFinished,
      unreadDone,
      markTasksRead,
    }),
    [conversations, activeConversation, activeKey, createNew, remove, send, sending, tasks, clearFinished, unreadDone, markTasksRead],
  );

  return <ChatStoreContext.Provider value={value}>{children}</ChatStoreContext.Provider>;
}

export function useChatStore(): ChatStoreValue {
  const context = useContext(ChatStoreContext);
  if (!context) throw new Error('useChatStore must be used within ChatStoreProvider');
  return context;
}
