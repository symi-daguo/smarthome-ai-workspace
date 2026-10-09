/**
 * 上传图片统一压缩（canvas 原生实现，零依赖）：
 * 产品图/户型图等经 canvas 等比缩放到最长边 ≤1024 再上传——
 * 手机原图动辄 4000x3000/5MB，既超 nginx 体积限制，也让点位合成与列表缩略卡顿。
 * 输出：原为 PNG 保留透明（image/png），其余转 JPEG 质量 0.85。
 */
const MAX_EDGE = 1024;
const JPEG_QUALITY = 0.85;

export async function compressImage(file: File): Promise<File> {
  const img = new Image();
  const url = URL.createObjectURL(file);
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('IMAGE_DECODE_FAILED'));
      img.src = url;
    });
    const { width, height } = img;
    if (!width || !height) throw new Error('IMAGE_EMPTY');
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    // 尺寸未超限且体积不大（<800KB）直接放行，避免无谓重编码
    if (scale === 1 && file.size < 800 * 1024) return file;
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('CANVAS_UNAVAILABLE');
    ctx.drawImage(img, 0, 0, w, h);
    const isPng = file.type === 'image/png';
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, isPng ? 'image/png' : 'image/jpeg', JPEG_QUALITY),
    );
    if (!blob) throw new Error('IMAGE_ENCODE_FAILED');
    const ext = isPng ? 'png' : 'jpg';
    const base = file.name.replace(/\.[^.]+$/, '') || 'image';
    return new File([blob], `${base}.${ext}`, { type: isPng ? 'image/png' : 'image/jpeg' });
  } finally {
    URL.revokeObjectURL(url);
  }
}
