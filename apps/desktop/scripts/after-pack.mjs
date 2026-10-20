/**
 * afterPack 钩子：裁掉 Electron 的多语言资源包。
 *
 * 为什么裁：
 * Electron 自带 220 个 `.lproj` 语言包（每个 0.5~1.7MB），合计 **48.8MB**。
 * 它们只是 Chromium 的本地化字符串（菜单、报错、日期格式），对本项目毫无价值，
 * 而安装包是要用户下载的 —— 48.8MB 是实打实的下载时间。
 *
 * 只留两种：
 *   - en.lproj      英文兜底（系统语言不在名单里时 Chromium 回落到这里）
 *   - zh_CN.lproj   简体中文（本项目面向中文用户）
 *
 * 为什么用 afterPack 而不是 electron-builder 的配置项：
 * electron-builder 26.x 没有 `electronLanguages` 选项（实测全量搜索无此字段），
 * 而 `files` 过滤器只作用于 app 自身目录，管不到 `Contents/Frameworks` 里的
 * Electron Framework —— 那是从官方 zip 解出来的，不是「文件」。
 *
 * 为什么在签名之前裁（afterPack 早于 doSignAfterPack）：
 * 删掉的文件本来就不需要签名（electron-builder.yml 的 signIgnore 已跳过
 * `Electron Framework.framework/.*Resources/`），裁完再签名，
 * codesign 的封印与最终内容一致，不会出现「签名与内容不匹配」。
 *
 * 裁完必须仍能跑：语言包缺失只影响显示语言，Electron 会回落到 en。
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const KEEP = new Set(['en.lproj', 'zh_CN.lproj']);

/** 递归量目录体积（字节），用于报告省了多少 */
function dirSizeBytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += dirSizeBytes(p);
    else if (entry.isFile()) total += statSync(p).size;
  }
  return total;
}

export default async function afterPack(context) {
  const outDir = context.appOutDir;
  if (!outDir) {
    console.log('[after-pack] 拿不到 appOutDir，跳过语言包裁剪');
    return;
  }

  // appOutDir 的实际含义随 electron-builder 的版本与调用方式变化：
  //   - 常规打包：appOutDir = <output>/mac-arm64（.app 的**父目录**）
  //   - prepackaged：appOutDir = <prepackaged 指向的 .app 本身>
  // 所以两种布局都要认，找到 .app 根目录再动手。
  let appRoot = null;
  if (existsSync(join(outDir, 'Contents', 'Frameworks'))) {
    appRoot = outDir; // 本身就是 .app
  } else {
    for (const name of readdirSync(outDir)) {
      if (!name.endsWith('.app')) continue;
      if (existsSync(join(outDir, name, 'Contents', 'Frameworks'))) {
        appRoot = join(outDir, name);
        break;
      }
    }
  }
  if (!appRoot) {
    console.log(`[after-pack] 在 ${outDir} 下没找到 .app，跳过语言包裁剪`);
    return;
  }

  const frameworks = join(appRoot, 'Contents', 'Frameworks');
  console.log(`[after-pack] 目标 app：${appRoot}`);

  let removed = 0;
  let freedBytes = 0;
  let kept = 0;

  for (const fw of readdirSync(frameworks)) {
    if (!fw.endsWith('.framework')) continue;
    // Electron Framework 的资源在 Versions/A/Resources 下（Versions/Current 是软链）
    const resDir = join(frameworks, fw, 'Versions', 'A', 'Resources');
    if (!existsSync(resDir)) continue;
    for (const entry of readdirSync(resDir)) {
      if (!entry.endsWith('.lproj')) continue;
      if (KEEP.has(entry)) {
        kept += 1;
        continue;
      }
      const target = join(resDir, entry);
      freedBytes += dirSizeBytes(target);
      rmSync(target, { recursive: true, force: true });
      removed += 1;
    }
  }

  if (removed === 0) {
    console.log('[after-pack] 没有需要裁剪的语言包');
    return;
  }
  console.log(
    `[after-pack] 裁掉 ${removed} 个语言包（保留 ${kept} 个：${[...KEEP].join(', ')}），` +
      `省下约 ${(freedBytes / 1024 / 1024).toFixed(1)}MB`,
  );
}
