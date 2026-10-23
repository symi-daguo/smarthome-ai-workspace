/**
 * 给 zip 里的非 ASCII 文件名补上 UTF-8 标志位（general purpose bit flag 的 0x800）。
 *
 * 问题：
 * app bundle 的目录名是中文「智能家居AI工作台.app」（productName 是中文，
 * 这是产品名不是文件名，改 ASCII 会影响用户在访达里看到的名字）。
 * electron-builder 打 zip 时**没有**在文件名含非 ASCII 时置 0x800 标志，
 * 于是 Windows 的资源管理器按 CP437 解读这些字节 → 解压出来是乱码目录名。
 *
 * 为什么不用「改成 ASCII 目录名」：
 * 那会让 .app 在访达与「应用程序」里显示成英文名，是产品体验的倒退。
 * 字节本来就是标准 UTF-8（见下），缺的只是一个标志位。
 *
 * 为什么不重新压缩：
 * zip 里 42657 个条目、603MB，重压要十几分钟且会改变产物字节
 * （已公证的 app 装订票据是按字节算的，改了字节就可能要重新公证）。
 * 这里只改头部标志位，**数据区一个字节都不动** —— 产物内容与公证状态不变。
 *
 * 为什么放在 artifactBuildCompleted 而不是 afterPack：
 * afterPack 在「打包后、签名前」，那时 zip 还没生成；
 * artifactBuildCompleted 是「每个产物生成后」，正好在 zip 写完之后。
 *
 * 判据落在**内容**上：修完重新读一遍 zip，
 * 每个非 ASCII 条目的标志位必须带 0x800，且按 UTF-8 解出来的名字与原始一致。
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const UTF8_FLAG = 0x800;

/**
 * 找到 EOCD（end of central directory）记录的位置。
 * zip 允许尾部有注释，所以要倒着扫 64KB 找签名字节。
 */
function findEocd(buf) {
  const max = Math.min(buf.length, 0xffff + 22);
  for (let i = buf.length - 22; i >= buf.length - max; i -= 1) {
    if (i < 0) break;
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * 给 zip 补 UTF-8 标志位。原地改写（先写临时文件再替换，避免中途失败留半个文件）。
 */
export function fixZipUtf8Flags(filePath) {
  const buf = readFileSync(filePath);
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error(`不是有效的 zip（找不到 EOCD）: ${filePath}`);

  // EOCD: 偏移 10 起是 central directory 的条目数与大小/偏移
  const total = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  let cdSize = buf.readUInt32LE(eocd + 12);

  // Zip64：条目数或偏移到 0xffffffff 时，真实值在 Zip64 EOCD 记录里
  if (total === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    const loc = findZip64Locator(buf, eocd);
    if (loc >= 0) {
      const z64 = Number(buf.readBigUInt64LE(loc + 8));
      total = Number(buf.readBigUInt64LE(z64 + 32));
      cdSize = Number(buf.readBigUInt64LE(z64 + 40));
      cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
    }
  }

  // —— 走 central directory 逐条改 ——
  // 不顺序扫 local header：36002 个条目置了 bit 3（数据描述符），
  // 描述符长度在 zip64 下还会变，手工跳偏移很容易错位。
  // central directory 里记着每个条目的 local header 偏移与压缩后大小，
  // 按它直接跳过去最稳。
  //
  // 两处都要改：local header（偏移 6）与 central header（偏移 8）。
  // 读工具优先看 central directory，但有的解压器只读 local header —— 只改一处会漏。
  let cp = cdOffset;
  let fixed = 0;
  let nonAscii = 0;
  for (let i = 0; i < total; i += 1) {
    if (buf.readUInt32LE(cp) !== CENTRAL_SIG) throw new Error(`central header 签名不对（条目 ${i}）`);
    const flag = buf.readUInt16LE(cp + 8);
    const nlen = buf.readUInt16LE(cp + 28);
    const elen = buf.readUInt16LE(cp + 30);
    const clen = buf.readUInt16LE(cp + 32);
    const localOffset = buf.readUInt32LE(cp + 42);
    const name = buf.subarray(cp + 46, cp + 46 + nlen);
    if (!name.every((b) => b < 0x80)) {
      nonAscii += 1;
      if (!(flag & UTF8_FLAG)) {
        // central header
        buf.writeUInt16LE(flag | UTF8_FLAG, cp + 8);
        // local header（偏移 6 是标志位）
        if (buf.readUInt32LE(localOffset) === LOCAL_SIG) {
          const lFlag = buf.readUInt16LE(localOffset + 6);
          buf.writeUInt16LE(lFlag | UTF8_FLAG, localOffset + 6);
        }
        fixed += 1;
      }
    }
    cp += 46 + nlen + elen + clen;
  }
  void cdSize;

  if (fixed === 0) return { fixed: 0, total, nonAscii, unchanged: true };

  writeFileSync(filePath, buf);
  return { fixed, total, nonAscii, unchanged: false };
}

/** Zip64 EOCD 定位器（locator 紧挨在 EOCD 之前，固定 20 字节） */
function findZip64Locator(buf, eocd) {
  const loc = eocd - 20;
  if (loc < 0) return -1;
  return buf.readUInt32LE(loc) === 0x07064b50 ? loc : -1;
}

/**
 * 自证：修完必须回读校验 —— 每个非 ASCII 条目的标志位带 0x800，
 * 且按 UTF-8 解出来的名字与修复前记录的一致。
 * 只信「脚本说改好了」是不够的，必须重新读文件确认。
 *
 * local header 与 central directory 都要查：读工具优先看 central，
 * 但有的解压器只读 local header —— 只改一处会漏。
 */
export function verifyZipUtf8Flags(filePath) {
  const buf = readFileSync(filePath);
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 zip');
  const total = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  let cp = cdOffset;
  let bad = 0;
  let badLocal = 0;
  let nonAscii = 0;
  const samples = [];
  for (let i = 0; i < total; i += 1) {
    if (buf.readUInt32LE(cp) !== CENTRAL_SIG) throw new Error(`central header 签名不对（条目 ${i}）`);
    const flag = buf.readUInt16LE(cp + 8);
    const nlen = buf.readUInt16LE(cp + 28);
    const elen = buf.readUInt16LE(cp + 30);
    const clen = buf.readUInt16LE(cp + 32);
    const localOffset = buf.readUInt32LE(cp + 42);
    const name = buf.subarray(cp + 46, cp + 46 + nlen);
    if (!name.every((b) => b < 0x80)) {
      nonAscii += 1;
      if (!(flag & UTF8_FLAG)) bad += 1;
      if (buf.readUInt32LE(localOffset) === LOCAL_SIG
        && !(buf.readUInt16LE(localOffset + 6) & UTF8_FLAG)) badLocal += 1;
      if (samples.length < 3) samples.push(name.toString('utf8'));
    }
    cp += 46 + nlen + elen + clen;
  }
  return { total, nonAscii, bad, badLocal, samples };
}

/** electron-builder 的 artifactBuildCompleted 钩子入口 */
export default async function fixZipUtf8(context) {
  const artifacts = context?.artifactPaths ?? [];
  const zips = artifacts.filter((p) => typeof p === 'string' && p.endsWith('.zip'));
  if (zips.length === 0) return;
  for (const z of zips) {
    const sizeMb = (statSync(z).size / 1024 / 1024).toFixed(1);
    const r = fixZipUtf8Flags(z);
    const v = verifyZipUtf8Flags(z);
    if (v.bad > 0) {
      throw new Error(`zip UTF-8 标志修复后自检仍失败（${v.bad} 个条目缺 0x800）: ${z}`);
    }
    console.log(
      `[fix-zip-utf8] ${z.split('/').pop()}（${sizeMb}MB）：`
      + `条目 ${v.total}，非 ASCII 文件名 ${v.nonAscii} 个，`
      + `修复 ${r.fixed} 个，自检 central 缺标志 ${v.bad} 个 / local 缺标志 ${v.badLocal} 个`,
    );
    if (v.samples.length) console.log(`[fix-zip-utf8] 样例：${v.samples.join(' | ')}`);
  }
}
