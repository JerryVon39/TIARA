/**
 * lib/version.mjs — 全项目唯一的版本真源
 *
 * 以前版本号散在四处：package.json、README 顶部一行、dist/manifest.json、面板页脚，
 * 手工同步的结果是 portable 包的版本落后了 8 个版本（0.17.1 vs 0.25.0）。
 * 现在只有 package.json 是权威值，其它地方都要 import 这里（或由 tools/manifest.mjs 写）。
 *
 * 注意：这里用同步读——ESM 的顶层只能 await 或同步，同步读一个 1 KB 的文件
 * 在整个进程生命周期里只发生一次，比把每个调用点改成 async 划算。
 */

import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** 应用标识（面板 /api/health 靠它判断「对面是不是另一个 TIARA」） */
export const APP_ID = 'tiara';

/** 语义化版本，例如 0.26.0 */
export const VERSION = String(pkg.version || '0.0.0');

/** 'v0.26.0' —— 给 README / 面板显示用 */
export const VERSION_TAG = 'v' + VERSION;

/** '0.26' —— 给 dist 包名这种不需要补丁号的地方用 */
export const VERSION_MINOR = VERSION.split('.').slice(0, 2).join('.');
