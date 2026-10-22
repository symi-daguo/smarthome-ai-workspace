import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { App as AntApp, Button, Select, Space, Tooltip, Typography } from 'antd';
import { LinkOutlined } from '@ant-design/icons';
import { api } from '../lib/api';
import { getCurrentPlanId, subscribeCurrentPlan } from '../lib/currentPlan';

const { Text } = Typography;

interface PlanOption {
  id: string;
  title: string;
  customer?: string | null;
}

export type AttachSlot = 'render' | 'video' | 'floorplan';

/**
 * 「挂到工程」按钮：把当前工具的一件产物挂到某个方案上。
 *
 * 为什么做成一个通用组件而不是各页各写：
 * 生图、生视频、点位、画布…每个工具都要「产出→归属」这一步，
 * 而归属的规则（校验归属、写入方案对应字段、失败要有话说）是同一套。
 * 复制四遍就会有四个版本的行为不一致 —— 所以收敛成一个。
 *
 * 不选方案时按钮是禁用态并说明原因：用户看不到一个点不动的按钮，
 * 那是「界面坏了」而不是「你还没选工程」。
 */
export function AttachToPlanButton({
  assetId,
  slot,
  size = 'small',
  label = '挂到工程',
  layoutPoints,
  onDone,
}: {
  assetId: string;
  slot: AttachSlot;
  size?: 'small' | 'middle';
  label?: string;
  /** floorplan 时可一并写入点位（点位编辑器改完一次提交） */
  layoutPoints?: unknown[] | null;
  onDone?: (planId: string) => void;
}): ReactNode {
  const { message } = AntApp.useApp();
  const [plans, setPlans] = useState<PlanOption[]>([]);
  const [current, setCurrent] = useState(getCurrentPlanId());
  const [target, setTarget] = useState(getCurrentPlanId());
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setPlans(await api<PlanOption[]>('/api/plans'));
    } catch {
      setPlans([]);
    }
  }, []);

  useEffect(() => {
    void load();
    return subscribeCurrentPlan(() => {
      const id = getCurrentPlanId();
      setCurrent(id);
      setTarget(id);
    });
  }, [load]);

  const doAttach = async (planId: string): Promise<void> => {
    setLoading(true);
    try {
      await api(`/api/plans/${planId}/assets`, {
        method: 'PATCH',
        body: JSON.stringify({ assetId, slot, ...(layoutPoints ? { layoutPoints } : {}) }),
      });
      const p = plans.find((x) => x.id === planId);
      message.success(`已挂到「${p?.title ?? '方案'}」，重新导出 PPT 即可带上`);
      setOpen(false);
      onDone?.(planId);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // 有当前工程时一点就挂；没有则要先选 —— 但也允许临时选别的工程
  const quickTarget = target || current;

  if (!open) {
    return (
      <Tooltip title={current ? '挂到当前工程' : '先在百宝箱选一个当前工程，或点这里临时选择'}>
        <Button
          size={size}
          icon={<LinkOutlined />}
          loading={loading && !!quickTarget}
          disabled={!assetId}
          onClick={() => {
            if (quickTarget) void doAttach(quickTarget);
            else setOpen(true);
          }}
        >
          {label}
        </Button>
      </Tooltip>
    );
  }

  return (
    <Space.Compact>
      <Select
        size={size}
        value={target || undefined}
        placeholder="选择要挂到哪个方案"
        style={{ minWidth: 180 }}
        loading={loading}
        onChange={setTarget}
        options={plans.map((p) => ({ value: p.id, label: p.customer ? `${p.title}（${p.customer}）` : p.title }))}
      />
      <Button size={size} type="primary" loading={loading} disabled={!target} onClick={() => void doAttach(target)}>
        确认挂入
      </Button>
      <Button size={size} onClick={() => setOpen(false)}>取消</Button>
    </Space.Compact>
  );
}
