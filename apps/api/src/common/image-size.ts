/**
 * 从文件头读图片宽高（PNG / JPEG / WebP），零依赖。
 *
 * 为什么不装库：这里只需要「三个格式的宽高」这一件事。
 * sharp 是原生模块（部署镜像要额外编译、桌面端 runtime 要多带一份二进制），
 * image-size 是一个依赖；而这三个格式的头部结构是公开且稳定的，读几十字节就够。
 * 认不出来的格式返回 null，调用方按「不知道尺寸」降级 —— 绝不猜一个值出来。
 */

export interface ImageSize {
  width: number;
  height: number;
}

export function probeImageSize(buf: Buffer): ImageSize | null {
  // 只要够读签名 + 一个最短的段头就往下走：各分支自己校验自己的最小长度。
  // 写死 24 会让小尺寸 JPEG 直接判 null —— SOF 段可能在 20 字节内就结束了。
  if (buf.length < 8) return null;

  // PNG：签名 8 字节 + IHDR 长度/类型 8 字节，宽高在 16..23
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }

  // WebP：RIFF....WEBP + 子格式
  if (buf.length >= 32 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fmt = buf.toString('ascii', 12, 16);
    if (fmt === 'VP8 ') {
      // 有损：关键帧头在 26 起的 10 字节，宽高各占 14 位
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (fmt === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (fmt === 'VP8X') {
      return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    }
    return null;
  }

  // JPEG：0xFFD8 起逐段扫描，遇到 SOF0/SOF1/SOF2 等取宽高
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      // 无长度字段的标记
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      // SOF0..SOF15，排除 DHT(0xC4) / JPG(0xC8) / DAC(0xCC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = buf.readUInt16BE(i + 5);
        const width = buf.readUInt16BE(i + 7);
        return width > 0 && height > 0 ? { width, height } : null;
      }
      if (len < 2) return null;
      i += 2 + len;
    }
  }

  return null;
}
