# TIARA 下一步更新方案（v0.26 → v0.27）

> 依据：`docs/AUDIT-round4.md`（2026-11-09，P0 16 / P1 36 / P2 58 / 卫生 9）
> 原则：**先止血，再手感，再结构**。每一批都能单独发版、单独回滚；结构重构排在 P0 之后，不拿「拆分」当修 bug 的替代品。

## 版本节奏

| 批次 | 版本 | 主题 | 条目 | 预估 |
| --- | --- | --- | --- | --- |
| 一 | **v0.26.0** | 止血：坏请求、坏数据、坏入口 | 16 条 P0 + 4 条低成本 P1 | 1.5 – 2 人日 |
| 二 | **v0.26.1** | 手感：桌宠不卡、面板不错 | P1 里影响日常的 14 条 | 2 – 3 人日 |
| 三 | **v0.27.0** | 结构：拆分 + 契约测试 + 版本真源 | 拆分、`lib/library.mjs`、`test/server.test.mjs` | 3 – 5 人日 |
| 四 | **v0.27.1** | 卫生与发布：生成物、dist、README、CI | 卫生 10 条 | 1 – 1.5 人日 |

**明确不做**（至少本轮之外）：README §13 路线图第 1 条「真按时刻抓各站节目表」（成本高、易崩，且当前 P0 未清）、i18n、多套立绘切换、面板改框架。

## 实施状态（2026-11-09 更新）

这份方案原本按四个版本分批走；实际落地时四批**一起做完了**，统一记在 **v0.26.0**（见 `docs/CHANGELOG.md`）。下面只记「做完了什么、还剩什么」，条目编号与下文一致。

| 批次 | 状态 | 说明 |
| --- | --- | --- |
| 一 · 止血（16 条 P0 + 4 条顺带 P1） | ✅ 全部落地 | 服务端坏请求不再 exit、`restore` 走白名单+原子写、`apiWatch` 继承 `eps`、删 `reload`、时刻单一口径、`writeLibrary` 时间戳；桌宠 `ReadWriteTimeout` + `RunNode` 统一走 `runtime\node.exe`；面板 XSS / `q` / 键盘 / `ok` 判定 / 工具条；两个 bat。 |
| 二 · 手感（桌宠 8 + 面板 6 + 后端 2） | ✅ 全部落地 | 桌宠：单实例、尺寸夹紧到工作区、占位符实时填充、空闲档真的进档、跨日重试、双击去重、alpha 遮罩跟随表情、`FindPanelPort` 并发探测。面板：行内数字、断网保留视图、`auto` 主题、刷新保留筛选/焦点、`.ops` 触屏常显、待看弹窗 grid。后端：`rebuild` 挪出写锁（十连点 4183ms → 939ms）、`pruneSeasonCache` 双基准。 |
| 三 · 结构（拆面板 / `lib/library.mjs` / 拆 server / 测试 / 版本真源） | ✅ 主要项落地 | `panel/` 拆成 `index.html` + `style.css` + `app.js`（经典脚本，`file://` 不白屏）；新增 `lib/library.mjs`、`lib/atomic.mjs`、`lib/time.mjs`、`lib/version.mjs`；单测 90 → **124**，新增 `server` / `library` / `atomic` / `time` / `season-cache` 五组；`/api/health` 与 `/api/version` 带版本号，`tools/sync_docs.mjs` 从 CHANGELOG 取发版日。**server.mjs 没有按路由拆文件**——`lib/` 抽出的是状态与写盘，路由仍在一个文件里（1560 行左右），下一轮再按 `/api/progress`、`/api/watch`、`/api/season`、静态服务四段切。 |
| 四 · 卫生（10 条） | 🟡 9 条 | 文档归档（10 份 → `docs/archive/`）、README 重构（§14 446 行搬进 `docs/CHANGELOG.md`）、`tools/ci.mjs`、`PET_DEBUG=1` 收敛、`.gitignore` 补 `*.tmp`、dist 重打、台词池补厚、`idleLong` 文案跟阈值、9 个死池接线。**唯一没做：把 `ghost/master/words.txt`、`ghost-yaya/master/{yaya.txt,basis.dic}` 取消跟踪**——那要 `git rm --cached` 并提交，本轮按约定不创建提交，留到下次提交时一起做。 |

**顺带做掉的 P1/P2（原本不在四批里）**：`isLocalOrigin` 的恒真 `|| true`、ICS `DTSTAMP` 时区与 75 字节折行、代理串 `user:pass@`、`getJson` 只对网络层错误重试、`serveFile` 的 `/api/*` JSON 404、`logLine` 改 CST、`--root`（测试挂临时库）、`--force-new`（并存两只服务）、`writeFileAtomic` 的 Windows `EPERM` 重试、`restoreLibrary` 不污染 `.bak`、面板 `role=dialog` / `focus-visible` / `aria-live`。

**明确仍然没做**（不是遗漏，是判断后留下）：

1. `server.mjs` 按路由拆文件（见批次三说明）。
2. i18n、多套立绘、面板换框架（原方案就排除）。
3. 托盘 `GetHicon` 没 `DestroyIcon`（每次重建托盘图标泄漏一个 GDI 句柄，重建次数极少，优先级低于其他项）。
4. `tools/check_panel_ui.mjs` 用 `/(\d+)\/(\d+)/` 解析进度，遇到小数 `eps` 会误判——测试库目前全是整数，等真的出现半话制式再改。
5. 多显示器与 200% 缩放的**真机**回归（代码已按「所在屏工作区 DIP」算，但没有第二块屏可验）。
6. README §13 第 1 条「真按时刻抓各站节目表」。

---

# 批次一 · v0.26.0「止血」

**目标**：坏 JSON 打不死进程、回滚不再污染数据、新加的番能记进度、跨季加番有名字、本季表不再能执行脚本、没装 Node 的机器也能重建、两个 bat 都把用户带到正确的页面。

## 1.1 清单（按改动顺序）

| # | 文件 | 改什么 | 验收 |
| --- | --- | --- | --- |
| 1 | `server.mjs` | 9 处 `(await readJsonBody(req,res)) \|\| {}` → `const body = await readJsonBody(req,res); if (!body) return;`（`851/891/908/930/998/1047/1108/1124/1154`） | `POST /api/settings -d '{oops'` → 400，进程**仍在**，后续请求正常 |
| 2 | `server.mjs` | `json()` 开头加 `if (res.headersSent \|\| res.writableEnded) return;`；**`status >= 400` 时自动补 `ok:false`**（一处改，U4 全覆盖） | 任意 4xx 响应体含 `"ok": false` |
| 3 | `server.mjs` | `apiRestore`（848-877）：`if(!body)return;` → 校验 → `writeLibrary(next)` → `rebuildToday()` → catch 500；备份改名为 `pre-restore-*` 保留「回滚前」副本 | 坏请求后库**字节不变**；正常回滚后 `today.txt` 同步更新 |
| 4 | `server.mjs` | `apiWatch` add（765）：`eps` 从 `data/season/*.json` → 星期表 → `null` 依次继承；`apiProgress` 在 `eps <= 0` 时不设上限 | 新加一部 → `POST /api/progress {delta:1}` 返回 `changed:true` |
| 5 | `server.mjs` | 删 `apiReload`（879-883）与路由 `1425`；`apiState` 删掉 281 行无用的 `readJSON('data/talks.json')` | `GET /api/reload` → 404；把 `talks.json` 改坏后面板仍正常 |
| 6 | `server.mjs` | `writeLibrary`：`lib.updated = date` 挪到 `JSON.stringify` **之前**（564-593） | 写一次 → 落盘 `updated` 是本次日期 |
| 7 | `pet/Pet.cs` | `PostJson`（3715-3736）补 `ReadWriteTimeout = 3000`；`BumpShow`/`UndoLast`/`RefreshData` 改为 `Task.Run` + `Dispatcher.Invoke` | 把面板进程 suspend，点「记一话」→ 3s 内回「服务没响应」，UI 全程可拖 |
| 8 | `pet/Pet.cs` | 合并 `RunNodeOnce`(3449) / `RunNodeRebuild`(3493) / `SyncBangumi`(3379) 成一个 `RunNode`：优先 `runtime\node.exe`；异步收流；超时 `Kill(true)` | 临时改名 `runtime\node.exe` 并清空 PATH 里的 node → 重建/同步仍成功；超时后 `tasklist` 无孤儿 `node.exe` |
| 9 | `panel/index.html` | 1371 → `{ q: SEASON_Q, add: ids }` | 换到 2025Q2 勾一部加入 → 星期表出现、名字是中文 |
| 10 | `panel/index.html` | 990 → `esc(x.eps)`；`cover()` 的 `onerror` 改 `addEventListener` | `eps` 塞 `<img onerror=...>` → DOM 里是纯文本，`document.title` 不变 |
| 11 | `panel/index.html` | `1588-1591` 排除 `BUTTON\|A`；`#mask.show` 时短路；`1601-1605` 只在 `SEL` 非空时接管 | 焦点在主题按钮按 Enter → 主题切换；按空格不写库 |
| 12 | `panel/index.html` | 1198/1209/1279/1372 改判 `j.ok === false \|\| j.error`；1317 改 `r.count ?? ids.length` | 25:30 → 提示失败；批量 0 条时提示「先加入在追」 |
| 13 | `panel/index.html` | 889 的 `.bar season-bar` 去掉 `.bar`，新写 `.season-bar`（`position:static`、取变量色） | 滚动后顶栏可见；亮色主题对比 ≥ 4.5:1 |
| 14 | `打开番组表.bat` | 21-33：起服务后从 `cache\panel_port.txt` 读端口再开浏览器；`/api/health` 校验 `"app":"tiara"` | 先用别的程序占住 7788 → 点 bat 打开的是 TIARA 的 7789；连点 3 次只有 1 个服务 |
| 15 | `启动TIARA.bat` | 起桌宠前探测并 `start /min` 起 server（已在跑则跳过） | 冷启动 → 点桌宠「打开网页番组表」直接进面板，不出错误页 |
| 16 | `server.mjs` + `lib/` | 进程级 `unhandledRejection` / `uncaughtException` → `logLine('error', stack)`，吞掉 `ERR_HTTP_HEADERS_SENT` 后继续 | 人为制造 rejection → `cache/server.log` 有栈，进程不退 |

**顺手带上的 4 条低成本 P1**（都在同一批文件里，改了不增加回归面）：
- `lib/http-util.mjs:21` `isLocalOrigin` 恒真 → 改成 `Number(u.port) === PORT`（或进程级一次性 token）；
- `lib/season-cache.mjs` prune 基准改用当前季（S1，翻旧季不再删当前季缓存）；
- `server.mjs:639-647` `logLine` 改用 `+08:00`（与面板口径一致）；
- `build_today.mjs:154/179` 改 `tmp + rename` 原子写（B4）。

## 1.2 建议的 6 个 commit

```
fix(server): 坏 JSON 不再打死进程；4xx 统一带 ok:false
fix(server): restore 走 writeLibrary；health/version 带 app 与 version
fix(server): 新番继承 eps；删 /api/reload 与无用 talks 预读
fix(pet): PostJson 补 ReadWriteTimeout；子进程统一 RunNode（认 runtime\node.exe）
fix(panel): 跨季加番传 q；eps 转义；键盘不抢按钮
fix(launcher): 两个 bat 按实际端口打开；启动器顺带起服务
```

## 1.3 本批新增的测试（`test/server.test.mjs`，约 180 行）

起服务的方式：把 `data/` 复制到临时目录 → `spawn(process.execPath, ['server.mjs','--port',0])` 取实际端口 → 用 Node 内置 `fetch` 打。**不引入任何依赖。**

| 用例 | 断言 |
| --- | --- |
| `bad json on 9 endpoints` | 9 个 POST 各发一次 `{oops` → 400；之后 `GET /api/health` 仍 200 |
| `4xx carries ok:false` | 任一 4xx 响应体 `ok === false` |
| `restore rejects bad body without writing` | 发坏 body → 库文件 mtime/内容不变 |
| `restore happy path updates today.txt` | 回滚后 `ghost/master/today.txt` 的 mtime 变化 |
| `watch add inherits eps then progress works` | add → progress(+1) → `changed:true`、`ep_status:1` |
| `reload is gone` | `GET /api/reload` → 404 |
| `cross-origin write blocked` | `Origin: http://evil.com` → 403 |
| `progress delta abc` | 400（不再静默当 0） |

## 1.4 验收门

```powershell
node --test "test/*.test.mjs"     # 90 + 新增 ≈ 98，全绿
node tools/doctor.mjs             # 只允许「今天没在跑 / 缓存过期」这类预期 warn
node tools/check_panel_ui.mjs     # PASS
# 手工三条：
#   1. 开面板 → 本季换到上一季 → 勾一部 → 加入在追 → 回来能看见名字
#   2. 面板开 DevTools → POST 坏 JSON ×9 → 面板不白屏
#   3. 把 runtime\node.exe 改名 → 右键「重算今日数据」→ pet.log 有成功记录
```

## 1.5 风险与回滚

- **风险最高的两处**：`json()` 里补 `ok:false`（影响所有响应）与 `RunNode` 合并（桌宠唯一的重建通道）。两者都先在沙箱/临时副本验证，再落主干；`git revert` 单个 commit 即可回到现状。
- `apiRestore` 改走 `writeLibrary` 后行为变化：会写 `updated` 并触发 `rebuildToday`（+0.3s）。可接受。
- `打开番组表.bat` 依赖 `curl.exe`（Win10+ 自带）；保留「读不到端口就退回 7788」的兜底分支。

---

# 批次二 · v0.26.1「手感」

**目标**：桌宠不再 20fps 常驻、不再双击双触发、面板不再「点了没反应」、本季表与待看弹窗不再变形。

## 2.1 桌宠（8 条）

| # | 改什么 | 位置 | 验收 |
| --- | --- | --- | --- |
| P4-1 | 空闲说话改「真空闲」：`ScheduleIdleTalk` 前先看 `_idleFor > 90s`；`Say→Touch` 不再无条件触发重绘 | `2342-2356`、`420`、`2164` | 挂着不动 5 分钟 → `pet.log` 帧数落回 1-2fps，`idleLong` 台词能出现 |
| P4-2 | 「尺寸」以 `settings.json` 为准：菜单写完立即回写 settings，或改读 settings 不再覆盖 | `3049-3053`、`3170-3173` | 菜单选 150% → 60s 后仍是 150% |
| P4-3 | 200% 上限按**工作区高度**动态夹：`maxScale = min(2.0, (workAreaH - 120) / 底图高)` | `158-167`、`898-925` | 1080p@125% 下选 200% → 自动落到 130% 左右，立绘完整 |
| P4-4 | 布局改「窗所在屏」+ 统一 DIP：`Screen.FromHandle` 取当前屏工作区，物理像素处除 `DpiScale` | `543-571`、`2268-2270` | 拖到副屏 → 不跳回主屏；气泡不越界 |
| P4-5 | `CheckNewDay` 改为「成功后才置 `_dayChecked`」 | `3274-3287` | 拔网线跨日 → 联网后当天能补算 |
| P4-6 | `today.txt` 键 `Trim()` + 大小写归一；读失败保留上次数据并气泡提示 | `1001-1051` | 手工把某个键前后加空格 → 仍能解析 |
| P4-7 | 双击去重：600ms 内已执行单击动作就跳过「抱」，或改成「单击=摸头 / 双击=抱」二选一 | `2817-2824`、`2782-2789` | 双击 → 好感 +2，只说一句 |
| P4-8 | hit-test 遮罩按当前脸重建（缓存 4 张） | `3593-3618` | 换到 surface2 后，能点的区域与显示一致 |

`FindPanelPort`（P12）与本批一起做：先读 `cache/panel_port.txt` 直连，失败再并发探测（`Task.WhenAll`，总超时 800ms），彻底消灭「点一下卡 6s」。

## 2.2 面板（6 条）

| # | 改什么 | 位置 | 验收 |
| --- | --- | --- | --- |
| U1 | `paintWatch` 也更新本季行的数字（按 `[data-season-id]` 找） | `1120-1147` | 本季行内点 + → 数字立刻变 |
| U3 | 刷新失败不换整页：保留上次视图 + 顶部条「连不上本地服务 · 重试」；端口读 `/api/health` 返回的 `port` | `590-613` | 杀掉服务 → 页面仍是表格，顶部出现重试条 |
| U4 | 主题 auto 用 `matchMedia('(prefers-color-scheme: dark)')` + 监听变化 | `1565-1582` | 系统切深色 → 1s 内跟随 |
| U5 | `refresh()` 后恢复本季筛选值与焦点 | `628-635`、`895-900` | 筛选「只看 TV」→ 刷新后仍是「只看 TV」 |
| U6 | `.ops` 常显（低对比度），`@media (hover:hover)` 才隐藏 | `209-210` | 触屏/键盘 Tab 能点到「记一话」 |
| U7 | `.trow` 补 `display:grid`（对齐表头列宽） | `1175-1177`、`374` | 待看弹窗列不错位 |

## 2.3 后端（2 条）

- **rebuild 出锁**（S2）：写库后只置 `dirty=true` 并 `setTimeout(200ms)` 去抖，`rebuildToday` 在锁外串行执行；`/api/progress` 立刻返回。验收：10 连点总耗时从 4183ms 降到 < 800ms，`today.txt` 仍最终一致。
- **单实例**（S3）：启动时读 `panel_port.txt` + `GET /api/health` 带 `app:'tiara'` 探测，命中就**复用并退出**（打印实际地址）。验收：连开两次 → 只有一个 node 进程。

---

# 批次三 · v0.27.0「结构」

**目标**：把「只能靠人读」的东西变成「靠测试守」的东西。**不改变任何对外行为**，唯一例外是 `/api/version` 开始返回版本号。

## 3.1 拆 `panel/index.html`（1650 行 → 3 个文件）

服务端静态服务已经按目录走（`server.mjs:1452` 的 `safeJoin(panel, url)`），所以**不需要改服务端**：

```
panel/index.html   ← 只剩 <head> + 骨架 + <script src="./app.js">
panel/style.css    ← 现在 11-386 行的 CSS 原样搬
panel/app.js       ← 现在 440-1648 行的 JS，按注释分段拆 6 个 IIFE 模块
```

`app.js` 内部顺序：`util / state / render / season / dialog / boot`。拆完顺手把 `dispShow` 与 `lib/today.mjs:26-40` 的重复实现收成一处（前端只信 `/api/state` 的 `timeline`）。

## 3.2 抽 `lib/library.mjs`（唯一写入口）

现在有 5 条路径会碰 `library.json`：`writeLibrary`、`apiRestore` 的 `fs.writeFile`、`bgm.mjs` 的同步、`build_today` 的读、`tools/restore_library.mjs`。收成一个模块：

```js
// lib/library.mjs
export async function readLibrary(root)
export async function writeLibrary(root, lib, { reason })   // tmp+rename+updated+指纹
export async function mutateLibrary(root, fn, { reason })    // 内部走 writeLock
```

所有调用点（含 `build_today`）只从这里进出；`updated` 与原子写在模块内保证，不再依赖调用方自觉。

## 3.3 拆 `server.mjs`（1548 行）

建议形状（不追求一次到位，先拆三块）：

```
server.mjs            ← 启动 + listen + 静态服务（~250 行）
routes/index.mjs      ← 路由表（[method, 正则, handler] 数组，替掉 23 条 startsWith）
routes/state.mjs      ← /api/state /stats /version /health /logs
routes/write.mjs      ← progress / watch / undo / restore / settings / nickname
routes/season.mjs     ← season* / sync / token / export
```

路由表化之后，`1425` 那种「不分方法」的漏洞在结构上就不可能再出现（每条路由必须声明 method）。

## 3.4 测试补齐

| 新文件 | 内容 |
| --- | --- |
| `test/library.test.mjs` | 原子写、并发 mutate 不丢字段、`updated` 正确、坏 JSON 不覆盖原文件 |
| `test/season-cache.test.mjs` | prune 不删当前季（S1 的回归锁） |
| `test/time.test.mjs` | `parseHhmm`：`25:30`/`29:00`/`abc`/空/`7:5` 的判定表 |
| `test/build_today.golden.test.mjs` | 用 `--date 2026-11-05` 跑三次，输出**逐字节相同**；与 `test/fixtures/today-2026-11-05.txt` 对比 |
| `tools/logic_test.cs` + `tools/logic_test.mjs` | 把 `Pet.cs` 里的纯逻辑（`toMin`、`Fill` 占位符、`IsOpaque`、分区命中）搬到 `pet/TiaraLogic.cs`，用现成的 `csc.exe`（`build_pet.mjs:17-22` 已定位）编个 console harness 跑断言 |

## 3.5 单一版本真源

```js
// lib/version.mjs
export const APP = 'tiara';
export const VERSION = JSON.parse(readFile('package.json')).version;
```

- `/api/version` → `{ app, version, pid, port, started }`（**去掉 `root` 绝对路径**，S12）
- `/api/health` → `{ ok:true, app, version, port }`（给 bat 与桌宠探测用）
- `tools/pack_portable.mjs` / `manifest.mjs` / `pack_ssp.mjs` 全部改读 `lib/version.mjs`
- `tools/sync_docs.mjs` 已在管 README 那行版本号，扩成同时校验 `dist/manifest.json` 与 `package.json` 一致（`--check` 供 CI）

---

# 批次四 · v0.27.1「卫生与发布」

| # | 做什么 | 验收 |
| --- | --- | --- |
| B1 | 生成物去跟踪：`ghost*/master/{words.txt,yaya.txt,basis.dic,today.*}` 加进 `.gitignore` + `git rm --cached`；README 说明「首次运行会生成」 | `git status` 干净且 `node tools/build_*.mjs` 后仍干净 |
| B2 | 时区统一：对外一律 `+08:00`（`logLine`、备份命名、`today.generated_at`、ICS `DTSTAMP`、`build_ghost.mjs:107`） | grep 不到裸 `toISOString()` |
| B3 | `dist/` 重打：`node tools/pack_ssp.mjs && node tools/pack_ssp.mjs --yaya && node tools/pack_portable.mjs`，包名/`built_at`/文件清单与 v0.27.x 一致 | `dist/manifest.json` 的版本 = `package.json` |
| B4 | README：§14 变更记录挪到 `docs/CHANGELOG.md`（1194 → ~750 行）；修 §13 两条重复「5.」；补充「已知限制」：200% 尺寸、`PET_*` 开关、单实例缺失。**顺带改 `sync_docs`**：版本行日期取自 `CHANGELOG` 最新条目（而不是运行当天），否则停摆几天后补跑就会在 README 上伪造一个发版日 | `node tools/sync_docs.mjs --check` 通过 |
| B5 | 归档 `PLAN-v0.9-menu-ghost.md` → `docs/PLAN-v0.9-menu-ghost.md`，头部标注「已落地（v0.19）」 | 根目录只剩 3 个 bat + package.json + README + .gitignore |
| B6 | 死代码清理：9 个死池（`praise` `worry` `goodnight` `selfIntro` `wheel` `catchup` `imaginationHigh` `flusterHigh` `pending`）二选一——**接线**（推荐：`goodnight` 接 23:00 提醒、`praise` 接「看齐」、`pending` 接待看队列非空）或删除；`tools/ImageTool.exe`、`make_icon.mjs` 要么进 `package.json` 脚本，要么删 | `talks.json` 里每个池都能被 `Pet.cs` 引用（脚本核对） |
| B7 | `PET_*` 14 个开关收敛成 `PET_DEBUG=1`（旧名保留一个版本并打印 deprecation） | grep 只剩 `PET_DEBUG` 与 `PET_SAY/PET_SELFTEST` 两个 |
| B8 | 加一道门：`tools/ci.mjs` = `test` + `doctor --strict` + `check_panel_ui` + `sync_docs --check`，非零即失败；`.github/workflows` 可后置（先能本地一键跑） | 一条命令、退出码可信 |

---

# 每批都要过的门（Definition of Done）

1. `node --test "test/*.test.mjs"` 全绿，且**新增测试覆盖本批每一条 P0**（一条 P0 至少一个断言，见 1.3 表）。
2. `node tools/doctor.mjs` 不新增 warn；`node tools/check_panel_ui.mjs` PASS。
3. 手工冒烟三件套：面板记一话 / 桌宠托盘记一话 / 停止后再启动。
4. `docs/AUDIT-round4.md` 里对应条目加上 `~~删除线~~ → 已修 vX.Y.Z`。
5. README §14 加一条变更记录（批次四之前放 README，之后放 `docs/CHANGELOG.md`）。

---

# 今天就能做的 3 件事（30 分钟内）

```powershell
# 1. 备份当前工作区状态（含那两个挂了 4 天的未提交改动）
git stash list; git status --short
#   建议先把 data/library.json + ghost/master/words.txt 提交成 chore(data)：它们是「删掉 2 部在追」的结果

# 2. 把「一行改」的三件事一起做掉（U5 / U1 / S4）
#    panel/index.html:990  esc(x.eps)
#    panel/index.html:1371 { q: SEASON_Q, add: ids }
#    server.mjs:879-883 + 1425  删掉 /api/reload

# 3. 拿 §8 的复现命令验一遍：坏 JSON 不再打死进程（这条要等 1.1-#1 做完）
```

> 顺序建议：**#1 与 #3 先做**（崩溃与数据污染是同一条链上的两个开关），再做 #4/#9/#10（各一行，直接影响日常），最后做桌宠的 #7/#8 与两个 bat（要重新编译 `Pet.exe`、要在真机上验）。
