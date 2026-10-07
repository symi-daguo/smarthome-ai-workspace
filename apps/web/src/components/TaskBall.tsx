import { ClearOutlined, RobotOutlined } from '@ant-design/icons';
import { Badge, Button, Popover, Typography, theme } from 'antd';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChatStore } from '../store/ChatStore';

const { Text } = Typography;

const BALL_SIZE = 52;
const MARGIN = 24;

function formatTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 右下角任务球：生成任务浮球（可拖拽、Esc 收起、Home 复位、红点角标） */
export function TaskBall(): ReactNode {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const { tasks, clearFinished, unreadDone, markTasksRead } = useChatStore();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [open, setOpen] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  const ballRef = useRef<HTMLDivElement>(null);

  const defaultPos = useCallback((): { x: number; y: number } => ({
    x: window.innerWidth - BALL_SIZE - MARGIN,
    y: window.innerHeight - BALL_SIZE - MARGIN,
  }), []);

  const resetHome = useCallback(() => setPos(defaultPos()), [defaultPos]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
      if (e.key === 'Home') resetHome();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [resetHome]);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement;
      if (ballRef.current?.contains(target)) return;
      if (target.closest('.ant-popover')) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  const onPointerDown = (e: React.PointerEvent): void => {
    const current = pos ?? defaultPos();
    dragRef.current = { startX: e.clientX, startY: e.clientY, originX: current.x, originY: current.y, moved: false };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent): void => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (drag.moved) {
      setPos({
        x: Math.min(Math.max(8, drag.originX + dx), window.innerWidth - BALL_SIZE - 8),
        y: Math.min(Math.max(8, drag.originY + dy), window.innerHeight - BALL_SIZE - 8),
      });
    }
  };

  const onPointerUp = (): void => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag && !drag.moved) {
      const next = !open;
      setOpen(next);
      if (next) markTasksRead();
    }
  };

  const running = tasks.filter((t) => t.status === 'running');
  const finished = tasks.filter((t) => t.status === 'done');
  const current = pos ?? defaultPos();

  const panel: ReactNode = (
    <div style={{ width: 300 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <Text strong>生成任务</Text>
        <Button size="small" type="text" icon={<ClearOutlined />} disabled={finished.length === 0} onClick={clearFinished}>
          清空已结束（{finished.length}）
        </Button>
      </div>
      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
        生成会在后台继续，完成后这里亮红点。可同时查看多个任务。
      </Text>
      {tasks.length === 0 ? (
        <Text type="secondary" style={{ fontSize: 12 }}>
          当前没有待处理任务，历史作品仍可查看
        </Text>
      ) : (
        <div style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {[...running, ...finished].map((t) => (
            <div
              key={t.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 8px',
                borderRadius: 8,
                border: `1px solid ${token.colorBorderSecondary}`,
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  flex: 'none',
                  background: t.status === 'running' ? token.colorPrimary : token.colorSuccess,
                }}
              />
              <Text style={{ flex: 1, fontSize: 12 }} ellipsis={{ tooltip: t.title }}>
                {t.title}
              </Text>
              <Text type="secondary" style={{ fontSize: 11, flex: 'none' }}>
                {t.status === 'running' ? '生成中' : formatTime(t.createdAt)}
              </Text>
            </div>
          ))}
        </div>
      )}
      <Button type="link" size="small" style={{ padding: 0, marginTop: 8 }} onClick={() => navigate('/')}>
        查看全部历史
      </Button>
    </div>
  );

  return (
    <div
      ref={ballRef}
      style={{ position: 'fixed', left: current.x, top: current.y, zIndex: 1000, touchAction: 'none' }}
    >
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) markTasksRead();
        }}
        content={panel}
        trigger={[]}
        placement="topRight"
      >
        <Badge count={unreadDone} size="small" offset={[-2, 2]}>
          <div
            role="button"
            aria-label={`生成任务，${tasks.length}条任务，${open ? '收起' : '展开'}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            style={{
              width: BALL_SIZE,
              height: BALL_SIZE,
              borderRadius: '50%',
              background: '#151515',
              color: '#ffffff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'grab',
              boxShadow: token.boxShadowSecondary,
              userSelect: 'none',
            }}
          >
            <RobotOutlined style={{ fontSize: 24 }} />
          </div>
        </Badge>
      </Popover>
    </div>
  );
}
