/**
 * 上传文件名的字符集纠正。
 *
 * 背景：浏览器按 RFC 7578 用 UTF-8 发送 multipart 的 `filename` 头，
 * 而 multer（底层 busboy）默认按 **latin1** 解读这一段 —— 中文名会变成
 * `äº§å\x93\x81æ¸\x85å\x8d\x95` 这种乱码。库里存的是乱码，
 * 界面显示的也是乱码，导出给客户的产品清单看上去像坏文件。
 *
 * 规则：只有当 latin1 字节序列**同时是合法 UTF-8** 时才改用 UTF-8 解码。
 * - 原本就是 ASCII 的文件名：不动
 * - 原本是 latin1 的文件名（如旧系统导出的 `café.txt`）：
 *   latin1 → 字节 → UTF-8 解码会正确还原成 `café.txt`，不会反向弄坏
 * - 字节序列不是合法 UTF-8（说明对方本来就用的别的编码）：保持原样，宁可不动
 */

/** 只含可见 ASCII 的文件名：无需处理 */
const ASCII_ONLY = /^[\x20-\x7E]*$/;

export function decodeUploadName(name: string): string {
  if (!name || ASCII_ONLY.test(name)) return name;
  const bytes = Buffer.from(name, 'latin1');
  const utf8 = bytes.toString('utf8');
  // 非法 UTF-8 序列会被 toString 换成 U+FFFD，出现即说明原名不是 UTF-8
  return utf8.includes('\uFFFD') ? name : utf8;
}
