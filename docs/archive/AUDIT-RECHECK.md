# 伪春菜 · 改进项复核（2026-11-04 03:55 CST）

> 复核对象：[AUDIT.md](AUDIT.md) 列出的 30 项。
> 复核方式：重读当前源码 + 重跑进程/接口 + 重新实测 CPU + 逐项对账。
> **重要前提**：`03:38:48–03:44:16` 之间 `pet/Pet.cs`、`pet/Pet.exe`、`server.mjs`、`panel/index.html`、`README.md`、`tools/build_ghost.mjs`、`tools/import_shell.mjs`、`tools/switch_shell.mjs`、`shell/tiara2/*` 都有过改动，Pet（pid 7356，03:44:27 启动）与面板服务（pid 35580，03:40:26 启动）已重启。
> 所以 AUDIT.md 写于 03:30，其中一部分结论**已经过时**。以下是按当前代码重新确认的结果。

---

## 一、已经修好 / 已经不算问题（4 项，撤回或改写）

| 原编号 | 原结论 | 现在 | 证据 |
| --- | --- | --- | --- |
| P0-1 | 面板跑的是旧进程 | ✅ 已解决（但诱因还在） | 服务 pid 35580 起于 03:40:26，晚于 `server.mjs` 03:39:43；`/api/state` 已返回新结构。**但 `server.mjs:161-168` 仍是 `EADDRINUSE → exit(0)`，下次改完照样会悄悄跑旧进程**，建议保留「版本自检」这一条 |
| P2-22 | README 说 tiara 有 6 表情 | ✅ 已改正 | `README.md:84-98` 现在写明 4 张 + `talk.png`，并明确「sleepy/think 没有素材 → 退回 normal」 |
| P2-23 | `shell/tiara/CREDITS.txt` 说「网络公开素材」自相矛盾 | ✅ 已改正 | 目录已改名 `shell/tiara2/`，`CREDITS.txt` 写明「用户提供、画师已授权」+ 来源路径 + 逐图对应 |
| P1-16（原写「105%」笔误）/ CPU | 原写「33ms 定时器占满一个核 ≈20%」 | ⚠️ 实测降级 | 10 秒采样：`CPU 11.44s → 11.84s，Δ0.41s = 4.1% 单核`（此前 20% 的样本是 Playwright 拖动/快照期间测的）。**改为「空闲约 4%，仅影响续航，不构成问题」**，优化优先级下调 |

另外新增能力（AUDIT.md 里没有的）：
- **口型帧 `talk.png`**：打字机吐字时换张口图，打完切回表情（`Pet.cs:570,590`、`panel/index.html:331-341`）。
- **开机台词改成串行播报**：部数 → 落后 → 下一部，每 4.2s 一句（`Pet.cs:511-558`）。
- **立绘组改名 `tiara2`**，`switch_shell` 会删掉目标套没有的 `surfaceN.png`/`talk.png`，切套不残留。

---

## 二、仍然存在的改进项（去重后 22 项）

### P0 · 会让「说的」和「数据」对不上（5 项，全部复现）

| # | 问题 | 当前代码证据 | 复核判定 |
| --- | --- | --- | --- |
| **A1** | 「重读数据」不重算，**也不重建台词** | `Pet.cs:330` 只 `LoadData()`；`LoadData`(`376-421`) 只读 `ghost/master/today.txt`；`_linesReady`(`626-632`) 永不复位；`SayBoot` 不重跑 | 确认。改 `library.json` → 点「重读数据」→ 只弹一句「数据重读过了」，随后的随机台词仍是启动时算的旧值。这是**当前最容易让人以为「坏了」的一条** |
| **A2** | 跨日不刷新 | 全文只有 5 个 `DispatcherTimer`：呼吸 33ms、打字 28ms、隐藏 6s、随机 45–90s、播报序列 4.2s；**没有日期/零点定时器** | 确认。桌宠常年不关，0 点后仍报昨天，且 `date`/`weekday_cn` 全来自启动快照 |
| **A3** | 到点提醒缺失 | 无任何按 `showN_time` 比对的逻辑；`_clock` 只用于呼吸 `sin` | 确认。PLAN 的 P1 第一条，也是「番组管家」唯一没兑现的核心承诺 |
| **A4** | 退出不说再见 | `BuildMenu` 的「退出」直接 `Close()`（`Pet.cs:332`），无 `Closing`/`Closed` 订阅 | 确认。`talks.close` 两套台词（面板/SSP）从未被触发 |
| **A5** | 表情退化面很大 | `shell/master` 只有 `surface0..3` + `talk.png` | 确认且**已量化**：`talks.json` 26 句里 10 句（**38%**）用 `sleepy/think`，Pet 内置随机池 14 句里 5 句（**36%**）同样退化。补两张差分（`comfy_face_edit --face sleepy --face think`）能一次性把这 38% 找回来 |

### P1 · 让管家真正有用（9 项）

| # | 事项 | 当前状态 / 证据 |
| --- | --- | --- |
| B1 | **本地 +1 记账** | `server.mjs:13` 注释仍写「不写库」；无 POST 路由，无 `ep_status` 写回。面板只能看不能记 |
| B2 | **全量落后检测** | `lib/today.mjs:51` 仍是 `today.filter(t => t.behind > 0)`，只在当天有番时报 |
| B3 | 面板不刷新 | `panel/index.html:592` 只在启动 fetch 一次；页面内唯一的 `setInterval` 是打字机（`:365`）。跨日、改库后都得手动 F5 |
| B4 | `timeline.aired/upcoming`、`rate`、`last_watched`、`clock` 白算 | 面板只用到 `timeline.next`（`:429`）；其余字段服务端算了没人用 |
| B5 | 本周排片只在「今天为空」时出现 | `panel/index.html:489`、`Pet.cs:705` 两处都是 `if (count === 0)` 分支 |
| B6 | 桌宠无时间概念 | `Pet.cs:464-508` 台词池硬编码，`lateNight` 只有面板在用（1 条） |
| B7 | 台词两套 | `Pet.cs:464-508`（24 句硬编码）vs `data/talks.json`（26 句）。改文案要重编译 Pet.exe |
| B8 | 窗口位置不记忆、无托盘/自启 | 无 `state.json`、无 `NotifyIcon`、无启动项；每次启动 DPI 吸附回右下角（`Pet.cs:209-244`） |
| B9 | 透明区域仍吃点击 | `Image` 矩形命中，PNG 透明像素也挡住下层窗口；无 alpha 蒙版 / `HTTRANSPARENT` |

### P2 · 结构性 / 体验（8 项）

| # | 事项 | 当前状态 |
| --- | --- | --- |
| C1 | 名字/时间两处维护 | `library.json` 的 `watching` 与 `weekday` 各存一份名字与时间，改一边不联动 |
| C2 | 立绘反复解码 | `SetFace`（`Pet.cs:442-450`）每次都 `new BitmapImage` 从磁盘读 160KB PNG；配合口型帧，**每句话解码 2 次**。建议缓存 6 张 `ImageSource` |
| C3 | 播报序列不可取消 | `RunSequence`（`Pet.cs:548-558`）的 4.2s 定时器没有取消机制；中途摸头/点「说句话」，剩余台词照样覆盖上来。且 4.2s 固定间隔不随字数伸缩 |
| C4 | 番组表 Popup 无滚动 | 固定 `Width = 306`（`Pet.cs:351`）、`StackPanel` 无 `MaxHeight`/`ScrollViewer`；7 天排片 + 待补 + 一句叠起来会超出屏幕 |
| C5 | 点击周排片行语义错误 | 面板周行 `data-behind="0"`（`:499`），点了会答「看齐了」——它不是某部番的进度 |
| C6 | `data/today.json` 无人消费 | 仍只有 `tools/build_today.mjs:98` 写；要么给 Pet 读（顺便解决 A1），要么删掉 |
| C7 | 多屏只认主屏 | `GetSystemMetrics(0/1)`（`Pet.cs:220-221`）取的是主屏尺寸，副屏上会被拉回主屏 |
| C8 | SSP 装不进 | `ghost/master/` 只有 `descript.txt`/`today.txt`/`words.txt`，**缺 `shiori/` 与 `install.txt`**；`shell/master/descript.txt` 3 行、无 `surface.size`/`collision`；`ghost` 里声明了 `kero.name` 但没有 kero 立绘 |

### 工程（原 P3，全部仍缺）

- 无 `git`、无 `.gitignore`（`cache/` 238MB、`*.exe`、`pet/pet.log` 都裸放）
- 无任何测试（`lib/today.mjs` 是纯函数，最适合 `node --test`）
- 无 `library.json` 校验（`ep_status ≤ eps`、`weekday.id` 必须存在于 `watching`、`time_cst` 格式）
- `safeJoin` 仍只 `startsWith`，未加 `path.sep`（`server.mjs:67-73`）
- 全站 `Access-Control-Allow-Origin: *`（`server.mjs:82,96`）——本地无密钥，风险低，属顺手修

---

## 三、复核中被推翻/降级的两条

1. **「长台词会被窗口切掉」→ 降级为潜在风险。**
   `WinH - SpriteH = 104px`，字号 14、行高约 20 → 容纳 3 行；当前最长台词 31 字约排 2 行，**暂时不会切**。真正的隐患是 C3（4.2s 强制换句）和未来的长句/多行台词，不是现在的 `ApplyHeight`。
2. **「CPU 占满 20%」→ 改为 4.1%。** 之前那次采样正好撞上 Playwright 截图/拖动。优化仍值得做（`33ms` 常驻 → 说话/跳跃时再动画），但不再算问题。

---

## 四、确认后的行动顺序

**第一批（半天，改完立刻能感知）**
1. A1：`LoadData()` 里复位 `_linesReady`，并把「重读数据」改成 `node tools/build_today.mjs` → `LoadData()` → `SayBoot()`；顺带把 C6 一起解决（Pet 直接读 `data/today.json`）。
2. A2：加一个「下次 0 点」定时器，到点 `LoadData()` + 换日台词。
3. B3：面板 30s 轮询 `/api/state`（`document.hidden` 时停），并把 B4 的 `aired/upcoming/进度条` 一起渲染。

**第二批（1–2 天，把管家做实）**
4. B1：`POST /api/progress` + 原子写 `library.json`（临时文件 + rename），面板行内 `+1`。
5. A3：30s 扫描 `showN_time`，T-10min / 开播各说一次，已提醒集合写 `data/state.json`（顺便承载 B8 的窗口位置）。
6. A5：`comfy_face_edit` 补 `sleepy`/`think` 两张差分，把 38% 的表情退化补回来。
7. A4 + B6：`Closed` 事件说再见；台词池按时段分早/午/晚/深夜。

**第三批（结构）**
8. B2 + C1：`watching` 增 `start_date` 推算应看话数；`weekday` 只留 `{id,time_cst,ep_expected}`，名字从 `watching` join。
9. B7：`build_ghost` 顺带导出 `pet_lines.txt`，Pet 读文件不再硬编码。
10. C2/C3/C4：缓存 `ImageSource`、序列可取消、Popup 加 `ScrollViewer`。
11. C8 + 工程项：打 `.nar`、`git init`、`node --test`、`validate_library.mjs`。

---

## 五、一句话结论

上一版 30 项里，**4 项已被这轮改动解决或降级**（旧进程、README 两处、CREDITS、CPU 高估），
**22 项确认仍然存在**，其中真正卡住「管家」体验的还是那三条：
**重读不重算（A1）、跨日不刷新（A2）、不会到点提醒（A3）**。
先做这三条 + 面板轮询，桌宠才和面板共用同一条事实来源。
