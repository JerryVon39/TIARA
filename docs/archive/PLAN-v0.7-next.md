# 下一阶段改进方案（v0.7 / 2026-11-05）

> 这一份是**体检结论 + 排期**，不是愿望清单。每条都有可复现的证据、明确的改法和验收标准；
> 立绘/表情/语音按你的要求**本阶段不碰**。

## 完成情况（2026-11-05 收尾，v0.16.0）

| 条目 | 状态 | 落点 |
| --- | --- | --- |
| A1 写锁 / 缓存自净 | ✅ | `server.mjs` `withWriteLock`；`tools/clean_cache.mjs`；`doctor` 体积检查 |
| A2 季度缓存保留窗口 | ✅ | `lib/season-cache.mjs` `KEEP_SPAN=3` + `pruneSeasonCache` |
| A3 服务端日志 + 面板诊断 | ✅ | `cache/server.log`（1MB 轮转）、`GET /api/logs`、底栏「诊断」 |
| A4 版本单一来源 | ✅ | `package.json` + `tools/sync_docs.mjs` |
| A5 从备份恢复 | ✅ | `tools/restore_library.mjs`（`--list/--latest/--check-only`）+ 写库指纹日志 |
| B1 桌宠功耗 | ✅ | `Pet.cs` 三档 ticker + 托盘「省电模式」，静置 7.8% → 1.0% 单核 |
| B2 面板首屏 | ✅ | `/api/state` 22.2 KB → 12.6 KB；`/api/say`；搜索防抖 |
| B3 测试补齐 | ✅ | 43 → 62 例（http-util / season-cache / zip） |
| C1 首次向导 | ✅ | 空库三步引导 + `?welcome=1` |
| C2 便携包 | ✅ | `tools/pack_portable.mjs` → `dist/TIARA-portable-0.16.0.zip` |
| C3 历史轮转 | ✅ | `server.mjs` `rotateHistory()`，超 5000 行按年归档 |

剩下的「不做」项见 README §13（立绘差分、SSP 里读实时数据等，按你的要求本阶段不碰）。

## 0. 体检快照

| 项目 | 现状 |
| --- | --- |
| 代码量 | `server.mjs` 1029 行、`panel/index.html` 1252 行、`pet/Pet.cs` 2035 行、`lib/` 931 行 |
| 仓库体积 | 除 `cache/` 外约 98 MB（其中 `runtime/node.exe` 94.2 MB）、`data/` 1.1 MB |
| `cache/` | 体检时 **498.9 MB / 8629 文件**，清理后 33.4 MB（见 A1） |
| 单测 | 43 例全过，覆盖 `lib/today.mjs`、`lib/bgm.mjs` |
| 自检 | `doctor` 1 条提醒（`554779` 有播出日无时刻）、`check_panel_ui` 全 PASS |
| 接口 | 19 条路由，写接口全部 `withWriteLock`，写库走「备份 → tmp → rename」 |
| 面板 | 33 个函数、33 处 `addEventListener`、0 处内联 `on*=`、0 处 BOM 问题 |

## A. P0 卫生与可观测性（半天，收益最大）

### A1 缓存目录会无声膨胀 — 已处理 + 要上锁

- **证据**：`cache/` 里 6 个 `cdp_profile_*`（63.2 / 59.3 / 57.9 / 57 / 55.5 / 20.5 MB）＋ `probe_prof_*` 14.6 MB，
  都是 `check_panel_ui.mjs` 和临时 CDP 探针起 Edge 时用的 `--user-data-dir`，脚本结束只 kill 进程、不删目录。
  体检时一键清掉 **465.6 MB**（498.9 → 33.4 MB）。
- **改法**：
  1. `tools/check_panel_ui.mjs` 用 `try/finally` 删 profile（跑完 cache 增量必须 < 5 MB）；
  2. 新增 `tools/clean_cache.mjs`：`--dry-run` 只报数、`--keep-audit-days 7` 保留近期截图、默认清临时 profile；
  3. `doctor` 增加一行 `cache/ < 200 MB` 的健康检查。
- **验收**：连跑 5 次自检，`cache/` 增量 < 5 MB；`clean_cache --dry-run` 能报出每类占用。

### A2 季度缓存只增不减

- **证据**：`data/season/` 8 个季度文件 96–140 KB（合计约 930 KB）。`lib/season-cache.mjs` 的 `TTL_MS`
  只决定「新鲜度」，**从不删旧文件**，跨年用下去会一直涨。
- **改法**：每次写缓存后只保留「当前季 ± 3 季」，其余删除；页面再点到会自动重拉（本来就有回退逻辑）。
- **验收**：造 12 个季度文件后，目录里 ≤ 7 个。

### A3 服务端日志等于没有（最影响排障）

- **证据**：全部诊断走 `console.log/error`（`server.mjs:318/328/346/990/1012/1045/1047`），
  而启动器是 `start "tiara-panel" /min cmd /c node server.mjs`——窗口最小化，出问题没人看得到；
  尤其 `server.mjs:346` 的 `[rebuild] failed` 是静默的：进度记上了但 `today.txt` 没重算，桌宠还是旧数据。
- **改法**：写 `cache/server.log`（时间戳 + 1 MB 轮转 3 份）；新增 `GET /api/logs?tail=200`；
  面板底栏加「诊断」按钮弹窗；rebuild 失败时除了写日志，还在面板 toast 里说一句。
- **验收**：手动把 `tools/build_today.mjs` 改名模拟失败 → 点「记一话」→ 面板能直接看到失败原因。

### A4 文档与产物跟实现脱节

- **证据**：`README.md:9` 还写「当前版本 v0.5 · 2026-11-04」，而变更记录已经到 v0.15；
  `dist/` 里仍是 `小春-ssp.zip` / `小春-yaya.zip`（改名脚本跳过了 `dist/`）。
- **改法**：版本号收敛到单一来源（`package.json` 或 `data/settings.json` 的 `version`），README 由脚本注入；
  `dist/*` 重打包为 `TIARA-*.zip`；`tools/rename.mjs` 的跳过列表去掉 `dist/`（只保留 `cache/.git`）。
- **验收**：`grep -r "小春" --include=*.md --include=*.zip` 无命中；README 头与变更记录同版本。

### A5 库可能被写成乱码（体检时抓到的真事，已加护栏）

- **现象**：体检过程中 `data/library.json` 被写成「GBK 双重编码」的样子
  （`"note": "绾湰鍦扮暘缁勫簱…"`、`name_cn` 全是 `绀轰緥…`），同时 `watching` 少了两条。
  已从 git 恢复，并把 `today.txt` / `words.txt` 一并重算。
- **成因**：写库路径上任何一个用错编码的写手（PowerShell `Set-Content` 默认按 GBK 解码最典型）
  都能造成这种「字节合法但内容全废」的结果，而此前没有任何护栏。
- **已落盘的护栏**：
  1. `server.mjs` 的 `writeLibrary()` 在落盘前自检——序列化结果必须能 `JSON.parse` 回来，
     且不能含 `U+FFFD`，否则**拒绝写入并抛错**（宁可这次记不上，也不把库写坏）；
  2. `doctor` 新增「library.json 编码」检查：非干净 UTF-8 或命中 `锛/銆/绾/鐢/瓒/鍦/鏄` 这种双重编码特征
     直接报 **error**，并提示从 `data/backups/` 恢复。
- **还欠一步（放进第 1 批）**：`tools/restore_library.mjs --latest`，把「从备份恢复」变成一条命令；
  以及每次写库时在 `cache/server.log` 记一行指纹（watching 条数 + 内容哈希），下次再出问题能定位到哪一次写。



### B1 桌宠常驻功耗

- **证据**：`pet/Pet.cs` 里 6 个 `DispatcherTimer`：`_ticker` 50 ms（20 fps 呼吸/跳动，常驻）、
  `_settingsTimer` 4 s、`_remindTimer` 20 s、`_midnightTimer` 1 min、`_idleTalk` 45–90 s、`_typer` 28 ms。
  早前实测静置 CPU 约 4–20% 单核（取决于是否在说话/跳动）。
- **改法**：`_ticker` 只在「窗口可见 + 未最小化 + 未开启省电」时跑；把 4 s / 20 s 两个轮询合并成一个 4 s 的调度器；
  空闲 60 s 后降到 5 fps；托盘菜单加「省电模式」持久化到 `data/settings.json`。
- **验收**：静置 5 分钟平均 CPU < 1.5%，拖动与摸头手感不变。

### B2 面板首屏

- **证据**：`/api/state` 28.4 KB / 102 ms（含 166 条 `images`），`/api/season` 55–79 KB / 36–38 ms；
  本季表 167 行一次性 `innerHTML`，搜索框没有防抖。
- **改法**：`images` 从 `/api/state` 移除（本季页自己带 `image`，已满足）；搜索加 120 ms 防抖；
  本季表首屏只渲染「TV + 今天及以后」的前 80 行，其余按「加载更多」。
- **验收**：`/api/state` < 15 KB；`?tab=season` 首屏可交互 < 300 ms（Edge Performance 面板）。

### B3 测试补齐

- **证据**：`lib/season-cache.mjs` 无测试；`server.mjs` 1029 行只有 e2e（`check_panel_ui`），没有单测。
- **改法**：`season-cache` 补 6 例（TTL 过期、内存缓存命中、坏 JSON、目录缺失、写入后 age_ms=0、prune 保留窗口）；
  把 `readJsonBody / guardWrite / json` 抽到 `lib/http-util.mjs` 并补单测（含 413 与跨站 403）。
- **验收**：`node --test` ≥ 55 例，`lib/` 三个模块全覆盖。

## C. P2 功能（1 天，按需）

### C1 首次使用向导

- **证据**：空库时今天页只给一句「去本季挑几部」，没有「选季 → 勾选 → 补时刻 → 同步」的连续路径。
- **改法**：库为空时自动跳「本季」页并显示 3 步引导条；`?welcome=1` 可重看。
- **验收**：全新目录双击 `启动TIARA.bat`，30 秒内能追上一部并看到明天的时间。

### C2 分发包

- **证据**：有 `dist/*.zip` 但只是 SSP 人格包；`runtime/node.exe` 94 MB 没进任何发行物。
- **改法**：`tools/pack_portable.mjs` → `dist/TIARA-portable-<ver>.zip`
  （`pet/*.exe`、三个 bat、`runtime/`、`shell/`、`data/` 模板、`node_modules` 无；排除 `cache/.git/.vscode`）。
- **验收**：新机器解压即用（不装 Node），`doctor` 全绿。

### C3 历史轮转

- **证据**：`data/history.jsonl` 87 行 / 12.9 KB，无轮转策略。
- **改法**：> 5000 行时归档到 `data/history-YYYY.jsonl`；`/api/history` 只读当年。
- **验收**：造 6000 行后主文件回落，归档文件可读。

## D. 暂不做（明确记录）

- 立绘/表情差分、语音（你说过「太麻烦，先功能性」）。
- SSP 平台内的到点提醒（YAYA 版已可，等真机验证）。
- 移动端布局（720 px 断点已有，够用）。

## 排期建议

| 批次 | 内容 | 预估 | 交付标准 |
| --- | --- | --- | --- |
| 1 | A1–A4 | 半天 | 清理脚本 + 日志/诊断 + 文档版本一致 + 缓存上限 |
| 2 | B1–B3 | 1–2 天 | CPU <1.5%、首屏 <300 ms、单测 ≥55 |
| 3 | C1–C3 | 1 天 | 首次向导、portable zip、历史轮转 |

> 每批做完都跑：`node --test`、`node tools/doctor.mjs`、`node tools/check_panel_ui.mjs`，然后 `git commit`。
