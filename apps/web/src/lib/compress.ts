/**
 * 上传图片统一压缩（canvas 原生实现，零依赖）：
 * 手机原图动辄 4000x3000/5MB，既超 nginx 体积限制，也让点位合成与列表缩略卡顿。
 * - square=true（产品主图 / 点位图标）：等比 cover 后**中心裁切为正方形**，保证 1:1 口径
 * - square=false（效果图、现场照片等展示图）：等比缩放到最长边 ≤1024，**保持原始比例**
 * 户型图不走这里（压缩会毁掉墙线与尺寸标注），它有自己的 20MB 硬上限。
 * 输出：原为 PNG 保留透明（image/png），其余转 JPEG 质量 0.85。
 */
const MAX_EDGE = 1024;
const JPEG_QUALITY = 0.85;

interface CompressOptions {
  /** true=输出正方形（中心裁切）；false=保持宽高比 */
  square?: boolean;
}

async function decode(file: File): Promise<HTMLImageElement> {
  const img = new Image();
  const url = URL.createObjectURL(file);
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('IMAGE_DECODE_FAILED'));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
  if (!img.naturalWidth || !img.naturalHeight) throw new Error('IMAGE_EMPTY');
  return img;
}

function encode(canvas: HTMLCanvasElement, isPng: boolean): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('IMAGE_ENCODE_FAILED'))),
      isPng ? 'image/png' : 'image/jpeg',
      JPEG_QUALITY,
    );
  });
}

function toFile(blob: Blob, name: string, isPng: boolean): File {
  const ext = isPng ? 'png' : 'jpg';
  const base = name.replace(/\.[^.]+$/, '') || 'image';
  return new File([blob], `${base}.${ext}`, { type: isPng ? 'image/png' : 'image/jpeg' });
}

export async function compressImage(file: File, opts: CompressOptions = {}): Promise<File> {
  const { square = false } = opts;
  const img = await decode(file);
  const { naturalWidth: w, naturalHeight: h } = img;
  const isPng = file.type === 'image/png';

  // 正方形口径：已是 1:1 且尺寸/体积达标则原样放行，避免无谓重编码
  const alreadySquare = w === h;
  if (square && alreadySquare && w <= MAX_EDGE && file.size < 800 * 1024) return file;
  if (!square && w <= MAX_EDGE && h <= MAX_EDGE && file.size < 800 * 1024) return file;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('CANVAS_UNAVAILABLE');

  if (square) {
    // cover 中心裁切：短边对齐 MAX_EDGE（小图不放大），长边超出部分居中丢弃
    const side = Math.min(MAX_EDGE, Math.min(w, h));
    canvas.width = side;
    canvas.height = side;
    const scale = side / Math.min(w, h);
    const dw = w * scale;
    const dh = h * scale;
    ctx.drawImage(img, (side - dw) / 2, (side - dh) / 2, dw, dh);
  } else {
    const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  }

  return toFile(await encode(canvas, isPng), file.name, isPng);
}
