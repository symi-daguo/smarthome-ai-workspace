import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { App as AntApp, Button, Select, Space, Typography } from 'antd';
import { api } from '../lib/api';
import { getCurrentPlanId, setCurrentPlanId, subscribeCurrentPlan } from '../lib/currentPlan';

const { Text } = Typography;

interface PlanOption {
  id: string;
  title: string;
  customer?: string | null;
}

/**
 * 当前工程选择器。
 *
 * 用途：把「正在做的项目」显式选出来，之后所有工具（生图、生视频、点位布置…）
 * 都能把自己的产物挂到这个工程上 —— 这就是「工具与项目关联」的连接点。
 *
 * 为什么放在顶栏而不是每个工具页里各选一次：
 * 工程是**跨工具**的概念。门店的活是「一单到底」，
 * 选一次工程，后面每一步的产出都自动归属它 —— 这才叫相互关联，
 * 而不是每个工具各自记一个互不相通的项目。
 */
export function CurrentPlanPicker({ compact = false }: { compact?: boolean }): ReactNode {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const [plans, setPlans] = useState<PlanOption[]>([]);
  const [current, setCurrent] = useState<string>(getCurrentPlanId());
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const list = await api<PlanOption[]>('/api/plans');
      setPlans(list);
      // 当前选的方案可能已被删除 —— 这时清掉，别留一个指不到的工程
      setCurrent((prev) => {
        if (prev && !list.some((p) => p.id === prev)) {
          setCurrentPlanId('');
          return '';
        }
        return prev;
      });
    } catch {
      setPlans([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return subscribeCurrentPlan(() => setCurrent(getCurrentPlanId()));
  }, [load]);

  const onChange = (id: string): void => {
    setCurrentPlanId(id);
    setCurrent(id);
    if (id) {
      const p = plans.find((x) => x.id === id);
      message.success(`当前工程：${p?.title ?? '已切换'}`);
    } else {
      message.info('已取消工程归属，产物将留在「我的作品」里');
    }
  };

  if (compact) {
    return (
      <Select
        value={current || undefined}
        loading={loading}
        placeholder="选择当前工程"
        style={{ minWidth: 180 }}
        allowClear
        onChange={onChange}
        options={plans.map((p) => ({
          value: p.id,
          label: p.customer ? `${p.title}（${p.customer}）` : p.title,
        }))}
      />
    );
  }

  return (
    <Space size={8} wrap>
      <Text type="secondary" style={{ fontSize: 12.5 }}>当前工程</Text>
      <Select
        value={current || undefined}
        loading={loading}
        placeholder="选择当前工程"
        style={{ minWidth: 220 }}
        allowClear
        onChange={onChange}
        options={plans.map((p) => ({
          value: p.id,
          label: p.customer ? `${p.title}（${p.customer}）` : p.title,
        }))}
      />
      {current ? (
        <Button size="small" onClick={() => navigate(`/plan?id=${current}`)}>打开方案</Button>
      ) : (
        <Button size="small" onClick={() => navigate('/plan')}>先建一个方案</Button>
      )}
    </Space>
  );
}
