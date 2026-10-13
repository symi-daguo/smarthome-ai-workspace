import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { App as AntApp, Button, Modal, Space, Tag, Typography } from 'antd';
import { HighlightOutlined } from '@ant-design/icons';

const { Text } = Typography;

export interface RegionSelection {
  /** 遮罩 dataURL：被圈选区域透明、其余不透明（OpenAI images/edits 的约定） */
  maskDataUrl: string;
  /** 原图资产 id，供后端取原图 */
  imageAssetId: string;
}

/** 从 `/api/media/assets/{id}/file` 形式的 URL 里取资产 id */
export function assetIdFromUrl(url: string): string {
  const m = url.match(/\/api\/media\/assets\/([0-9a-f-]{36})/i);
  return m ? m[1] : '';
}

interface Props {
  open: boolean;
  /** 原图可访问地址（用于显示底图与取像素尺寸） */
  imageUrl: string;
  onCancel: () => void;
  onConfirm: (sel: RegionSelection) => void;
}

/**
 * 圈选局部重绘
 *
 * 交互：在效果图上按住拖动画出要重绘的区域 → 生成遮罩 → 交给后端走 images/edits。
 * 遮罩按 OpenAI 约定生成：**圈选区域透明、其余不透明**。
 * 遮罩直接用 base64 内联随请求提交，不落盘——它只是一次性的操作参数。
 */
export function RegionSelector({ open, imageUrl, onCancel, onConfirm }: Props): ReactNode {
  const { message } = AntApp.useApp();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drawing, setDrawing] = useState(false);
  const [hasMarks, setHasMarks] = useState(false);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const marksRef = useRef<{ x: number; y: number }[][]>([]);
  const curRef = useRef<{ x: number; y: number }[] | null>(null);

  useEffect(() => {
    if (!open) {
      marksRef.current = [];
      curRef.current = null;
      setHasMarks(false);
      return;
    }
    const el = new Image();
    el.crossOrigin = 'anonymous';
    el.onload = () => {
      setImg(el);
      const c = canvasRef.current;
      if (!c) return;
      c.width = el.naturalWidth;
      c.height = el.naturalHeight;
    };
    el.src = imageUrl.includes('?') ? imageUrl : imageUrl;
  }, [open, imageUrl]);

  /** 重绘画布：底图 + 已画笔迹 + 当前笔迹 */
  const repaint = useCallback(() => {
    const c = canvasRef.current;
    if (!c || !img) return;
    const g = c.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.lineWidth = Math.max(8, c.width * 0.012);
    g.strokeStyle = 'rgba(79,70,229,.85)';
    for (const stroke of [...marksRef.current, ...(curRef.current ? [curRef.current] : [])]) {
      if (stroke.length < 2) {
        if (stroke.length === 1) {
          g.beginPath();
          g.arc(stroke[0].x, stroke[0].y, g.lineWidth / 2, 0, Math.PI * 2);
          g.fillStyle = 'rgba(79,70,229,.85)';
          g.fill();
        }
        continue;
      }
      g.beginPath();
      g.moveTo(stroke[0].x, stroke[0].y);
      for (let i = 1; i < stroke.length; i += 1) g.lineTo(stroke[i].x, stroke[i].y);
      g.stroke();
    }
  }, [img]);

  useEffect(() => {
    repaint();
  }, [repaint, drawing, hasMarks]);

  const toPoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvasRef.current;
    if (!c) return { x: 0, y: 0 };
    const r = c.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * c.width,
      y: ((e.clientY - r.top) / r.height) * c.height,
    };
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId);
    curRef.current = [toPoint(e)];
    setDrawing(true);
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!curRef.current) return;
    curRef.current.push(toPoint(e));
    setDrawing((d) => !d); // 触发重绘
  };
  const onUp = (): void => {
    if (curRef.current && curRef.current.length > 1) {
      marksRef.current.push(curRef.current);
      setHasMarks(true);
    }
    curRef.current = null;
    setDrawing(false);
  };

  const confirm = (): void => {
    const c = canvasRef.current;
    if (!c || marksRef.current.length === 0) {
      message.warning('请先在图上圈出要重绘的区域');
      return;
    }
    const assetId = assetIdFromUrl(imageUrl);
    if (!assetId) {
      message.error('这张图不是本平台产物，无法作为局部重绘的原图');
      return;
    }
    // 生成遮罩：整幅不透明 → 把圈选区域「擦」成透明（OpenAI 约定：透明处被重绘）
    const mask = document.createElement('canvas');
    mask.width = c.width;
    mask.height = c.height;
    const mg = mask.getContext('2d');
    if (!mg) return;
    mg.fillStyle = '#ffffff';
    mg.fillRect(0, 0, mask.width, mask.height);
    mg.globalCompositeOperation = 'destination-out';
    mg.lineCap = 'round';
    mg.lineJoin = 'round';
    mg.lineWidth = Math.max(16, c.width * 0.03); // 比描边粗，确保圈得住
    mg.strokeStyle = '#000';
    for (const stroke of marksRef.current) {
      if (stroke.length < 2) continue;
      mg.beginPath();
      mg.moveTo(stroke[0].x, stroke[0].y);
      for (let i = 1; i < stroke.length; i += 1) mg.lineTo(stroke[i].x, stroke[i].y);
      mg.stroke();
    }
    onConfirm({ maskDataUrl: mask.toDataURL('image/png'), imageAssetId: assetId });
  };

  return (
    <Modal
      open={open}
      title="圈选局部重绘"
      onCancel={onCancel}
      width={880}
      footer={
        <Space>
          <Button onClick={onCancel}>取消</Button>
          <Button onClick={() => { marksRef.current = []; setHasMarks(false); }} disabled={!hasMarks}>
            清除圈选
          </Button>
          <Button type="primary" onClick={confirm} disabled={!hasMarks}>
            对圈选区域重绘
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Text type="secondary" style={{ fontSize: 12.5 }}>
          按住鼠标或手指在图上涂抹，圈出想重做的区域。圈外的部分会原样保留。
        </Text>
        <Tag color={hasMarks ? 'blue' : 'default'}>
          <HighlightOutlined style={{ marginInlineEnd: 4 }} />
          {hasMarks ? '已圈选，可提交' : '尚未圈选'}
        </Tag>
        <div style={{ position: 'relative', background: '#f5f5f7', borderRadius: 12, overflow: 'hidden' }}>
          <canvas
            ref={canvasRef}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            style={{ display: 'block', width: '100%', cursor: 'crosshair', touchAction: 'none' }}
          />
          {!img && <div style={{ padding: 48, textAlign: 'center' }}>图片加载中…</div>}
        </div>
      </Space>
    </Modal>
  );
}
