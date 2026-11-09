# 全项目审查 · 第四轮（v0.25.0）

> 审查日期：2026-11-09　·　审查对象：`15fc912`（v0.25.0）+ 工作区未提交改动
> 覆盖：`server.mjs`、`lib/*.mjs`（8 个）、`pet/Pet.cs`（3924 行）、`panel/index.html`（1650 行）、`tools/*`（32 个）、`data/*`、三个 `.bat` 启动器、文档与打包链
> 结论：**P0 16 条（会坏数据 / 打死进程 / 核心功能完全失效）、P1 36 条、P2 58 条、工程卫生 10 条**
> 与第三轮（`docs/AUDIT-round3.md`）的关系：不重复其已修项，纠错 4 条见 §7

---

## 0. 怎么审的（可复现）

| 手段 | 做法 | 产物 |
| --- | --- | --- |
| 静态读 | 三路并行：后端 / 桌宠 / 面板，逐函数读，结论必须带 `文件:行` | `cache/audit/round4/{server,pet,panel}.md`（18K/34K/29K） |
| 黑盒实测 | 复制一份项目到 `cache/audit/round4/sandbox` 与 `.../tmp/lab`，`node server.mjs --port 7793/7799` 起真服务，用 fetch 打全部路由 | `probe*.mjs`、`srv-err.log`、`t-restore.resp` |
| 浏览器实测 | Chrome headless + CDP（无第三方依赖），7 组夹具 × 30 张截图 | `cache/audit/round4/*.png`、`fixtures.mjs rich\|rich2\|many\|cross\|empty\|orig\|season-xss` |
| 数据体检 | 直读 `data/library.json`、`talks.json`、`history.jsonl`、`season/` | `cache/audit/data-check.mjs` |
| 回归基线 | `node --test "test/*.test.mjs"` → **90/90 通过**（611ms）；`node tools/doctor.mjs` → 4 警告 3 信息 | 见 §6 |
| 交叉复核 | lead 亲自复现每条 P0，逐行确认 §2 里的行号 | 见 §2 每条「证据」 |

**隔离原则**：所有写入都在副本里，真实 `data/` 未被修改（`git status` 仍只有那 2 个已知文件）。

---

## 1. 结论摘要

| 模块 | P0 | P1 | P2 | 一句话 |
| --- | --- | --- | --- | --- |
| 后端 `server.mjs` + `lib/` | 6 | 14 | 21 | 一个坏 JSON 就能把面板进程打死；`/api/restore` 会在 400 之后照样回滚数据 |
| 桌宠 `pet/Pet.cs` | 2 | 12 | 19 | 同步/重建全部硬编码 PATH 里的 `node`；`PostJson` 能冻结 UI 最长 5 分钟 |
| 面板 `panel/index.html` | 6 | 10 | 18 | 跨季度加番会写坏库；本季表 `eps` 是一处存储型 XSS |
| 启动/构建链（本轮新增） | 2 | — | — | `打开番组表.bat` 硬编码 7788 会开错页并堆进程；`启动TIARA.bat` 根本不起服务 |
| 工程与发布 | — | — | — | 见 §5（生成物入库、版本真源、dist 停在 0.17.1） |
| **合计** | **16** | **36** | **58** | — |

**健康的一面**（不是只挑毛病，§6 有完整清单）：单测 90/90 绿、路径穿越挡得住、跨站写拦得住、备份与撤销有白名单、114 张卡渲染 61ms、台词占位符零泄漏、today.txt 691 个键与 `data/today.json` 完全同步、面板 0 个外网请求（「纯本地」这个承诺是成立的）。

**最要紧的三件事**：
1. **面板进程可被一个坏请求打死**（§2 S1）——用户侧表现是「面板突然打不开」，日志里查不到原因（§3 S10）。
2. **跨季度「加入在追」会写出一条三页都看不见的脏数据**（§2 U1），而 `restore` 又绕过了写库保护（§2 S2）——两者叠加就是「数据坏了、备份也是坏的」。
3. **桌宠在没装 Node 的机器上，重算/同步/开机同步全部失效**（§2 T2）——这直接打在「纯本地零依赖便携包」的卖点上。

---

## 2. P0（16 条，全部已复现）

### 后端

#### S1 · 一个坏 JSON POST 就能打死面板进程（9 处同构）　`[实测]`
- **现象**：`POST /api/settings` 带 `{oops` → 返回 400，随后**进程退出**（沙箱 7793 复现）。
- **根因**：`readJsonBody` 在 `server.mjs:246-259` 已经发过 400 并 `return null`，9 个调用点却写成 `(await readJsonBody(req, res)) || {}` → 继续执行 → 第二次 `json()` 抛 `ERR_HTTP_HEADERS_SENT` → 从 async 回调逃逸，全文件没有 `unhandledRejection` 处理器 → Node 直接退出。
- **9 处**：`server.mjs:851`(restore) `:891`(settings) `:908`(nickname) `:930`(sync) `:998`(token) `:1047`(season/apply) `:1108`(season/subject) `:1124`(season/time) `:1154`(season/time-batch)
- **正确范式就在同一个文件里**：`apiProgress`（`server.mjs:686-687`）写的是 `const body = await readJsonBody(req,res); if (!body) return;`
- **证据**：`Error [ERR_HTTP_HEADERS_SENT]: Cannot write headers after they are sent to the client` `at json (…/server.mjs:259:7)` `at Server.<anonymous> (…/server.mjs:1456:5)`
- **修**：① 9 处统一成 `if (!body) return;`；② `json()` 开头加 `if (res.headersSent || res.writableEnded) return;`（兜底所有未来误用）；③ 进程级 `unhandledRejection` 记日志不退出（见 §3 S10）。

#### S2 · `/api/restore`：400 之后照样回滚数据，且绕过了所有写库保护　`[实测+逐行]`
- **位置**：`server.mjs:848-877`
- **三宗罪**：
  1. `851` `|| {}` → 请求体坏了也继续，`body.name` 为 `undefined` → 走默认回滚分支；
  2. `869` 先 `backupLibrary()`，把**当前（好的）状态**写成 `.bak`，再把备份覆盖上去 → 回滚之后想反悔，`library.json.bak` 里已经是被污染的那一份；
  3. `870` 在写锁里直接 `fs.writeFile(LIB_PATH, …)`：非原子、不更新 `updated`、不 `pushUndo`、不触发 `rebuildToday` → 面板显示的回滚成功了，`ghost/master/today.txt` 却还是旧的。
- **并且** `874` 的 catch 用 400 而不是 500。
- **修**：`if (!body) return;` → 校验 `name` 在白名单内 → `writeLibrary(next)` → `await rebuildToday()` → catch 500。备份要留「回滚前」的副本，命名加 `pre-restore` 前缀。

#### S3 · `eps=null` 的番永远记不上进度　`[实测]`
- **链路**：`apiWatch` 的 add 分支硬写 `eps: null`（`server.mjs:765`，且它是面板加番的**唯一**入口）→ `apiProgress` 算出 `const eps = Number(w.eps) || 0`（`:697`）→ `Math.min(eps, …)`（`:702`）上限恒为 0 → `changed:false`。
- **用户看到的是**：面板 `panel/index.html:1080-1102` 先乐观 +1，260ms 后收到服务端 `ep_status:0`，`1112-1114` 静默把数字改回去 → **「点了没反应」，没有任何提示**。
- **修**：`apiWatch` add 时从 `data/season/*.json` / 星期表继承 `eps`（这两处都有集数）；`apiProgress` 在 `eps <= 0` 时不要夹上限；面板在 `changed:false && next===prev` 时给一句「这部还没有集数，先在 Bangumi 同步一次」。

#### S4 · `/api/reload` 无门：任意网页一个 GET 就能拉起 3 个 node 子进程　`[实测]`
- **位置**：`server.mjs:879-883`（无 `guardWrite`、不校验方法）；路由 `1425` 按前缀匹配，不分方法。
- **后果**：任意本机页面 `<img src="http://127.0.0.1:7788/api/reload">` 就能让 TIARA 连跑 `build_today → build_ghost → build_yaya`（约 1-2s 的 CPU）。
- **且**：面板 17 个接口里没有任何地方调用它（死接口）。
- **修**：直接删掉；或保留则 `guardWrite` + `POST`。

#### S5 · 时刻校验两套标准：拒 `25:00`、收 `abc`，批量与单条互相矛盾　`[实测]`
- `lib/today.mjs:55-59` 的 `toMin` 对非法串**返回 1441**（= 23:61，一个「合法的哨兵值」）→ 调用方无法区分「非法」与「23:59 之后」。
- 单条接口 `server.mjs:1129` 把 `> 24:59` 判 400（所以 `25:00` 被拒，而面板 placeholder 正写着「支持 25:30」）；`abc` → `toMin` 返回 1441 → 通过，落盘成垃圾。
- 批量接口 `server.mjs:1162` 上限却是 **28:59**，与单条相反。
- **修**：抽 `lib/time.mjs` 出 `parseHhmm(s) → {ok, min} | {ok:false, reason}`，单条/批量共用一套上限（建议统一 06:00 之前的 24-29 点都算次日），非数字 400。

#### S6 · `talks.json` 缺失或损坏 → 首屏整体 500，并泄露绝对路径　`[推断+读码]`
- `server.mjs:281` `const talks = await readJSON('data/talks.json');` —— 没有 try，且**这个变量后面根本没用**（`apiState` 其余字段都来自 `library/today/settings`）。
- 后果：`data/talks.json` 一旦是坏 JSON，`/api/state` 500，整块面板白屏；错误信息里带 `C:\Users\…` 绝对路径。
- **修**：删掉这一行（最省事）；要保留预检就 `try{}catch{}` 并把路径换成文件名。

### 桌宠

#### T1 · `PostJson` 没设 `ReadWriteTimeout`：面板不回包时桌宠冻结最长 5 分钟　`[代码已证]`
- **位置**：`pet/Pet.cs:3715-3736`，只设了 `Timeout = 6000`（这是**连接 + 响应头**的超时）。.NET 的 `HttpWebRequest.ReadWriteTimeout` 默认 **300000ms**，所以「连上了、但迟迟不写 body」的情况会挂 5 分钟。
- **同步调用点全在 UI 线程**：`BumpShow`（`3682`）、`UndoLast`（`3336`）、`RefreshData`（`3489`）→ 主线程冻结时托盘菜单、拖拽、气泡全部无响应，用户只能杀进程。
- **修**：补 `ReadWriteTimeout = 3000`；把三个调用点改成 `async`/`Task.Run` + `Dispatcher.Invoke` 回 UI；`PostJson` 里手拼 JSON（`3680-3681` 只转义 `\` 和 `"`）换成最小的 `JsonEncode(string)`。

#### T2 · 所有子进程都硬编码 PATH 里的 `node`，超时也不 Kill　`[代码已证]`
- **可移植性**：`RunNodeOnce`（`pet/Pet.cs:3449`）与 `RunNodeRebuild`（`:3493`）都是 `new ProcessStartInfo("node", …)`；`SyncBangumi`（`:3379-3386`）同样。而 `runtime\node.exe`（94MB）就在根目录、`.bat` 也在优先用它 —— **只有桌宠不认它**。没装 Node 的机器上，右键「重算今日数据 / 同步 Bangumi / 开机自动同步」全失败，日志只有一句 `rebuild failed（node 不在 PATH？）`。
- **死锁**：`3379-3386`（同型 `3465-3467`、`3509-3511`）先 `ReadToEnd()` stdout 再 `ReadToEnd()` stderr，然后才 `WaitForExit(25000)`；子进程输出超过管道缓冲就会互相等；超时分支**不 Kill**，留下孤儿 node 继续写 `library.json`。
- **修**：合并成一个 `RunNode(script, timeoutMs)`：优先 `Path.Combine(ROOT,"runtime","node.exe")`，退回 `node`；`RedirectStandardOutput/Error` + `BeginOutputReadLine` 异步收流；`WaitForExit(timeout)` 失败则 `proc.Kill(entireProcessTree: true)`。

### 面板

#### U1 · 跨季度「加入在追」写坏库：新条目没名字、没星期、永远不出现　`[实测]`
- `panel/index.html:1371`：`post('/api/season/apply', { add: ids })` —— **不传 `q`**（单条版本 `:1221` 传了 `q: SEASON_Q`）。
- 服务端 `server.mjs:1062` 用 `body.q || 当前季` 去匹配 items → 拿别的季的 id 在当前季里找不到 → 落盘 `name_cn="363957"`（数字 id）、`name` 同、`air_weekday=null` → 星期表没有、今天没有、待看没有，**三页都看不见，UI 里也删不掉**。
- **修**：`{ q: SEASON_Q, add: ids }`；服务端再兜一层——匹配不到 items 就 400，别写 `name_cn = id`。

#### U2 · 「批量时刻」必然失效，提示还漏数字　`[实测]`
- 面板只让勾**未在追**的行（`panel/index.html:984-985`），服务端只把**在追**条目算进 `changed`（`server.mjs:1169-1205`）→ 永远是 `changed: []`。
- 提示 `panel/index.html:1317` `toast('已给 ' + (r.changed || ids.length) + ' 部写好时刻')`：空数组是 truthy → 拼出「已给　部写好时刻」。
- 更糟：`server.mjs:1175-1186` 其实已经改了星期表条目，`1205` 因为 `changed` 为空提前 return，**跳过了 `writeLibrary`** → 改动蒸发（实测 id=390200 磁盘 `time_cst` 仍为 null）。
- **修**：服务端把星期表命中数并入 `changed`/新增 `updated` 计数，`changed` 为空但星期表有改动也要写盘；面板改 `r.count ?? ids.length`，为 0 时提示「先把它加入在追」。

#### U3 · 全局键盘抢走 Space/Enter：所有按钮不能用键盘按，还会静默记一话　`[实测]`
- `panel/index.html:1588-1591` 只排除 `INPUT|TEXTAREA|SELECT`，**不排除 `BUTTON`**；`:1601-1605` Space/Enter → `bump(id, 1)`。
- 后果：焦点在「主题」按钮上按 Enter 不生效（被 `preventDefault` 吃掉）；若此前用 `j/k` 选过行，按空格直接**写库**（实测 12 → 12.5）。
- **修**：`if (tag && /INPUT|TEXTAREA|SELECT|BUTTON|A/.test(tag)) return;`；弹窗打开时（`#mask.show`）直接短路；Space/Enter 只在 `SEL` 非空且事件目标不是交互元素时接管。

#### U4 · 服务端 4xx 只回 `{error}`，前端判 `j.ok === false` 一律漏判 → 失败提示成成功　`[实测]`
- 前端漏判点：`panel/index.html:1198`（移出）、`:1209`（加入）、`:1279`（单条时刻）、`:1372`（批量加入）。
- 服务端对应错误响应：`server.mjs:748`、`:1129`、`:874` 都只有 `{error}`，没有 `ok`。
- 反证：`/api/sync`（`server.mjs:950`）失败也带 `ok:false`，说明前端这套判断本来就是按「服务端会带 ok」写的——是写接口没跟上。
- **修**：`json()` 在 `status >= 400` 时自动补 `ok:false`（一处改、全覆盖）；前端同时改判 `j.ok === false || j.error`。

#### U5 · 本季表 `eps` 未转义 → 存储型 XSS（面板同源，可写库）　`[实测]`
- `panel/index.html:990`：`'<td class="cn">' + (x.eps ? x.eps + ' 话' : '—') + '</td>'` —— 同一张表其余字段都走了 `esc()`，只有这个没走。
- 触发条件：`data/season/<季>.json` 里某条 `eps` 是字符串（缓存文件来自 Bangumi 或被手改过）。实测把 `document.title` 改成 `SEASON-EPS-XSS`。
- 危害不是「弹个框」：面板与 `/api/*` 同源，XSS 能调 `/api/progress`、`/api/restore` 写库，也能读 `/api/token`。
- **修**：`esc(x.eps)`；顺手给 `cover()` 的内联 `onerror`（`:581-587`）换成 `addEventListener`，别拼字符串。

#### U6 · 本季工具条复用顶栏类 `.bar`：压住顶栏 + 亮色主题几乎不可读　`[实测]`
- `panel/index.html:889` `<div class="bar season-bar">` 复用了顶栏 `:74-81` 的 `.bar`（`position:sticky; top:0; z-index:20` + 硬编码深色底）。
- 而 `:316` 的注释正写着「本季工具条别用 .bar」——注释与实现互相矛盾。
- 后果：滚动后本季工具条盖住页签与搜索；亮色主题下底色仍是深色、文字浅色混排，实测对比度 **1.30:1**。
- **修**：`season-bar` 不复用 `.bar`，单独一套 `position:static` + 变量取色。

### 启动 / 构建链（本轮新增）

#### L1 · `打开番组表.bat` 硬编码 7788：端口一回退就开错页，还会堆进程　`[读码已证]`
- `打开番组表.bat:21` `set "PORT=7788"`；`:23` 探 `/api/health`；`:25-31` 非 200 就 `start … server.mjs --port 7788`；`:33` 浏览器打开 `7788`。
- 但服务端 `listenWithFallback`（`server.mjs:1460-1489`）在 7788 被占时会**静默 +1** 到 7789…7800，并改写 `cache\panel_port.txt`。于是：
  - 7788 被别的程序占 → 起服务在 7789 → **浏览器打开的是别人家的 7788**；
  - 每点一次这个 bat 就多起一个服务（最多 12 个），它们的 `writeChain` 互不相识 → `library.json` 互相覆盖（见 §3 S3 单实例）。
- **修**：`:28` 的 `timeout /t 2` 之后读 `cache\panel_port.txt` 再打开；或让 bat 先把探测结果写进变量。顺带把 `/api/health` 的响应加上 `"app":"tiara"`，避免把别人的 200 当自己。

#### L2 · `启动TIARA.bat` 根本不起服务：点「打开网页番组表」落到报错页　`[读码已证]`
- `启动TIARA.bat:13-16` 跑完三个 build，`:31` 只 `start pet\Pet.exe` —— **全程不启动 server**。
- 而桌宠「打开网页番组表」（`Pet.cs:2911`）在找不到服务时会 `file://` 打开 `panel/index.html`；`panel/index.html:589-612` 的 `refresh()` 在 `file://` 下 fetch 失败 → 显示「读不到本地服务」错误页（文案还把端口写死成 7788）。
- 净效果：用户按说明双击「启动TIARA.bat」，然后点桌宠菜单，得到一页报错。
- **修**：`启动TIARA.bat` 在起桌宠前顺带 `start /min` 起 server（探测到已有实例就跳过）；或在 `Pet.cs` 打开面板前自起 `server.mjs` 并等端口就绪。

---

## 3. P1（36 条）

### 后端 `server.mjs` + `lib/`（14）

| # | 结论 | 位置 |
| --- | --- | --- |
| S1 | 季度缓存被误删：`pruneSeasonCache` 以「刚写入的季度」为基准，`abs(idx-base) > 3` 就删 → 翻一次 2018Q1 会删掉 2026Q3/Q4 | `lib/season-cache.mjs:59-71`、`87-111` |
| S2 | 写锁内跑子进程：`progress`/`watch`/`sync`/`apply` 都在 `withWriteLock` 里 `rebuildToday()` → 单次 +1 约 450ms，10 连点 4183ms | `server.mjs:722`、`774`、`940-951`、`1066` |
| S3 | 没有单实例保护：端口被占就静默 +1 并覆盖 `cache/panel_port.txt`，两个实例互不知情 | `server.mjs:1461-1489`、`1499` |
| S4 | `isLocalOrigin` 恒真：`return port == null \|\| String(u.port\|\|'')==='' \|\| true;` → 带 `Host: evil.example.com` 也能读 `/api/token` | `lib/http-util.mjs:21` |
| S5 | `settings` / `token` 写不在锁内，且是「读-改-写」+ 直接 `writeFile` | `server.mjs:892`、`999`；`69-94`、`972-982` |
| S6 | ICS 时间戳早 8 小时（先 +8h 再取 `getUTC*` 又拼 `Z`）；且不按 75 字节折行（实测最长 130 字节） | `lib/ics.mjs:21-27`、`58-113` |
| S7 | 403/404 仍然重试：`throw` 写在 `try` 里，被 catch 后照常 `sleep(1200*(i+1))` → 本地 403 发了 3 次共 3656ms | `lib/bgm.mjs:150-152` |
| S8 | 代理含凭据时解析错：`http://user:pass@host:port` → `ph='user'`、`pp='pass@host'` | `lib/bgm.mjs:70` |
| S9 | `apiExport` 读库无 try，库半写时直接 500（同文件其他读库路径都有保护） | `server.mjs:1232` |
| S10 | 崩溃不可观测：全文件无 `uncaughtException` / `unhandledRejection`，崩溃栈只在 stderr，`cache/server.log` 里查不到 | 全文 |
| S11 | 日志时间戳 `toISOString()`（UTC）与面板 CST 差 8 小时，排查时对不上 | `server.mjs:639-647` |
| S12 | 绝对路径外泄：`/api/version` 回 `root`，`/api/health` 回 `ROOT`，ENOENT 也回绝对路径 | `server.mjs:1391-1397`、`1435`、`281` |
| S13 | 批量设时刻对「只在星期表、不在追」的条目静默不落盘（`changed` 空则提前 return） | `server.mjs:1169-1205` |
| S14 | `writeLibrary` 的 `updated` 永远落后一次写：565 行先 `JSON.stringify`，586 才 `lib.updated = date`，587 写的是旧 `text` | `server.mjs:564-593` |

> S14 说明：全仓 `library.updated` **没有任何消费者**（只出现在 `server.mjs:586` 与 `lib/bgm.mjs:416/462/548`），所以它是**契约错误**而非数据事故——但它是「库时间」的唯一标记，接 `--check` 类工具时就会咬人，顺手改掉（把 `lib.updated = date` 挪到 `JSON.stringify` 之前）。

### 桌宠 `pet/Pet.cs`（12）

| # | 结论 | 位置 |
| --- | --- | --- |
| P1 | 无单实例锁 → 双开双托盘/双提醒、`state.json` 抢写、每日计数互相覆盖 | `45-51` |
| P2 | 菜单「尺寸」被 `data/settings.json` 在 ≤60s 内掰回；`state.json.pet_scale` 是死字段 | `3049-3053`、`3170-3173` |
| P3 | 台词占位符在 `BuildLines` 时冻结 → 「第 N 次」永停启动值 | `1348`、`1428`、`1442-1464` |
| P4 | 45-90s 无条件说话 + `Say→Touch` → 20fps 常驻、省电/空闲档永不进、`idleLong` 成为死池 | `2342-2356`、`420`、`2164`、`1757-1764`、`2962-2966` |
| P5 | 200% 尺寸放不下：1080p@125% 工作区 832 DIP，窗高 1132 → 26% 立绘永远在屏外（而面板允许选 200%） | `158-167`、`898-925`、`543-571`、`panel/index.html:420-422` |
| P6 | 布局一律按主屏、物理像素与 DIP 混用 → 副屏上跳屏、气泡算错 room 跑出屏外 | `543-571`、`2268-2270` |
| P7 | `CheckNewDay` 先置 `_dayChecked` 再 `RefreshData` → 重算失败当天不再重试，全天旧番单 | `3274-3287` |
| P8 | `today.txt` 键不 Trim；读失败静默降级成「今天没番」 | `1001-1051` |
| P9 | 双击 = 摸头 + 抱（第一次 up 已执行单击动作）→ 好感 +4、两句话互顶 | `2817-2824`、`2782-2789` |
| P10 | hit-test alpha 遮罩只取 surface0 且只建一次 → 换脸后「能点的」≠「看到的」；`_alpha==null` 时整窗可点 | `3593-3618` |
| P11 | `PET_SELFTEST` 不是只读：会真撤销一条记录、真跑 node 同步并改写库 | `2528-2614`（`2611-2613`） |
| P12 | `FindPanelPort` 串行 ping 12 个端口 × 500ms → 服务未启动时每点一次「记一话」先卡 6s | `3637-3654`、`3682` |

> 补一条节奏校正：`today.txt` 是**每 60s** 检查一次（`Pet.cs:3135-3140` 的 `_remindBeat`；`_beat` 1s 只在跨分/跨刻时派发），不是 4s。这反而降低了「读到半截文件」的概率，但没有消除（§5 B4）。

### 面板 `panel/index.html`（10）

| # | 结论 | 位置 |
| --- | --- | --- |
| U1 | 本季行内 `−/+` 写库成功但行内数字不动（`paintWatch` 只找 `[data-card]`，本季 `tr` 没有这个属性） | `1120-1147` |
| U2 | 番名以 `'` 开头时，封面回退的内联 `onerror` 拼出语法错误，每次重绘抛异常 | `586` |
| U3 | 一次刷新失败就把整页换成错误面板；提示里的端口写死 7788；没有重试按钮 | `590-613` |
| U4 | 主题「自动」不跟随系统（CSS 没有 `prefers-color-scheme`，JS 只是「取反」） | `1565-1582` |
| U5 | `refresh()` 之后本季筛选与焦点被重置 | `628-635`、`895-900` |
| U6 | 记一话/移出只能 hover 才出现：触屏与键盘都够不到 | `209-210` |
| U7 | 待看弹窗布局塌陷（`.trow` 缺 `display:grid`） | `1175-1177`、`374` |
| U8 | 搜索没有结果时，整板空态说「本周还没有在追的番」 | `727-730` |
| U9 | 集数可以是小数：`12.5` 能写进库并被当成「看齐」 | `1086`、`server.mjs:700` |
| U10 | 换季的代理错误原样贴给用户（info 行里出现 `connect ECONNREFUSED 127.0.0.1:7890`） | `995-997` |

> P2 一共 58 条（后端 21 / 桌宠 19 / 面板 18），逐条在 `cache/audit/round4/*.md` 里；`docs/PLAN-v0.26.md` 只挑其中会影响手感与可维护性的进批次，其余留在报告里备查。其中值得优先的三条：`.meta` 对比度 3.03-3.52:1 不达 AA、「今天」所有时刻都标红（没有做时间比较）、`doSync` 的 `dry_run:false` 分支没有 `.catch` 会让 `BUSY` 永久卡死。

---

## 4. 数据与内容审查

| 项 | 结论 |
| --- | --- |
| `data/library.json` | 8 个顶层键；`watching` 只有 1 部（554779，0/12）；`dropped` 0 部；**id 唯一、`ep_status ≤ eps`、无字段异常**；星期表 7 天 114 条无重复，在追项目都在表内 ✔ |
| `updated` 字段 | 停在 `2026-11-05`——S14 的直接证据（也被黑盒复现：写入后仍是 11-05） |
| `data/talks.json` | 54 个池全非空；但有 **7 个池只有 1 句**（`todayHas` `birthday` `askSync` `undoWait` `undoFail` `noServer` `pending`），而 `random` 12 句、`rules` 10 句、`nade` 5 句——越少触发的场景越重复（**v0.26.0 已补到每池 ≥2 句**） |
| 占位符 | 15 个占位符，`Fill()`（`Pet.cs:1442-1464`）+ 8 个调用点的 `FillCtx` 全部对上，**零泄漏**；反向核对 35 个池引用全部存在 ✔ |
| **死池** | 9 个池定义了但 `Pet.cs` 全文件零调用：`praise` `worry` `goodnight` `selfIntro` `wheel` `catchup` `imaginationHigh` `flusterHigh` `pending`（约 20 句写好的台词永不播放）。`menu` 不是池，是菜单标签对象（`Pet.cs:1065`）。**v0.26.0 已全部接线**（触发点与冷却见 `docs/CHANGELOG.md`） |
| `data/history.jsonl` | 198 行、只有 2026-11-04(46) 与 11-05(152) 两天、无坏行无未来日期——这就是 `/api/stats` 显示 `days=2`、`streak=0` 的原因（数据真实，不是 bug） |
| `data/season/` | 8 份缓存，doctor 报「0 份在 12 小时内」→ 项目自 11-05 起停摆 4 天 |
| `data/covers/` | 426 张；`/cover/` 只认 `/^\d{1,10}$/`，非数字 id 的番永远只有首字方块（面板 P2） |
| 备份/撤销 | `data/backups` 5 份 + `snapshot_daily` 的 `backups/2026-11-09/` 5 个；`data/undo` 10 份。命名混用 UTC（`library-20261108-174920.json`，CST 其实是 11-09） |
| 生成物一致性 | `ghost/master/today.txt` 691 个周表键与 `data/today.json` 完全同步；CRLF、无 BOM ✔ |

---

## 5. 工程与发布卫生（10 条）

| # | 结论 | 证据 |
| --- | --- | --- |
| B1 | **生成物入库**：`ghost/master/words.txt`、`ghost-yaya/master/{yaya.txt,basis.dic}` 被 git 跟踪 → 每天/每次改库都产生 diff 噪声（当前工作区那 8 行删除就是它） | `git status` |
| B2 | **没有单一版本真源**：`package.json` 0.25.0、`dist/manifest.json` 0.17.1、`Pet.exe` 无版本、README 版本行、`/api/version` **不返回 version**（只回 pid/port/mtime） | `server.mjs:1390-1397` |
| B3 | `dist/` 严重过期：100MB / 4 个文件 / `built_at 2026-11-04` / `TIARA-portable-0.17.1.zip`——`pack_portable.mjs:31` 用 `pkg.version` 命名，说明只是**没重打** | `dist/manifest.json` |
| B4 | **写库非原子**：`build_today.mjs:154`（`today.txt`）与 `:179`（`data/today.json`）都是直接覆写，没有 tmp+rename；`server` 与桌宠都可能同时跑 build，Pet 每 60s 读一次，仍有读到半截文件的窗口 | 代码 |
| B5 | **时区口径三套并存**：UTC（备份命名、`logLine`、`today.generated_at`、ICS `DTSTAMP`）／CST（`date`、`clock`、面板）／系统本地时区（`build_ghost.mjs:107` 的 `new Date(now).getHours()`） | 代码 |
| B6 | `README.md` 1194 行，**§14 变更记录占 446 行（37%）**；§13 路线图有**两条重复的「5.」**；§13「已知限制」没写 200% 尺寸缺陷与 `PET_*` 开关 | `README.md:726-745`、`746-1192` |
| B7 | `PLAN-v0.9-menu-ghost.md` 留在**根目录**、标题写「v0.19」，内容（菜单重做 + 天愛星人格）已落地 | 文件头 |
| B8 | 未引用资产：`tools/ImageTool.exe`、`tools/make_icon.mjs` 没有任何 `package.json`/README/bat 引用；`/api/reload` 是死接口；`state.json.pet_scale` 是死字段 | grep |
| B9 | **无 CI 门**：90 个单测 611ms 就能跑完，但没有任何自动触发点；`doctor` / `check_panel_ui` 全靠手动 | `package.json` |
| B10 | **`sync_docs --check` 当前是红的**：README 版本行写「v0.25.0 · 2026-11-05」，工具要求是「今天」（2026-11-09）。而该工具的做法是**直接把日期改成运行当天**——项目停摆 4 天后补跑，等于在 README 上写「今天发过版」。发版日期应由变更本身决定，不该由「谁在什么时候跑了哪个脚本」决定 | `node tools/sync_docs.mjs --check` 退出码 1 |

---

## 6. 本次确认无问题（不用改，别误伤）

- **路径穿越**：`/../package.json`、`/%2e%2e/package.json` → 404，`serveFile` 的 `safeJoin` 守住了 ✔
- **跨站写**：`Origin: http://evil.com` → `403 cross-origin write blocked` ✔（但 S4 是漏网之鱼）
- **XSS 覆盖面**：番名 / 优先级 / 时刻 / `data-*` 属性全部走 `esc()`，只有 §2 U5 那一处漏了
- **撤销与恢复**：`/api/undo` 有栈深上限 10；`/api/restore` 有文件名白名单 + `known` 列表校验（问题在写回路径，不在校验）
- **渲染性能**：114 张卡 61-65ms；本季 167 行整表重建 8ms；`_opsBound` 守卫住监听器不泄漏
- **24/30 小时制**：跨夜归属（25:30 → 次日）实测正确，`tsOf` 的 `extraDays` 处理没问题
- **空态与坏库**：0 部时显示引导页；`library.json` 坏掉时面板显示 500 错误面板（不该坏的只有文案，U3）
- **`today.txt` 契约**：691 个键、CRLF、无 BOM，与 `data/today.json` 同步；Pet 侧只读其中 4 类键，周表键是给 SSP 用的（README §6 已声明为外部接口）
- **桌宠已实现且正确**：跨日定时器（`ScheduleMidnight`/`CheckNewDay`，`Pet.cs:3261/3273/1922`，第三轮 A2 已闭环）、`today.txt` mtime 轮询、托盘动态「记一话」最多 8 部、`Notify` 气泡、`IsOpaque` 阈值 24
- **纯本地承诺成立**：面板 0 个外网请求，封面全部走 `/cover/<id>.jpg`
- **单测**：90/90 通过，覆盖 `lib/*`（9 个模块）+ `check_faces` + `build_yaya` 的纯函数

---

## 7. 对旧审查的纠错

| 旧结论 | 实际 |
| --- | --- |
| round3 §7「面板 XSS：所有插值走 `esc()`；`data-*` 用 `escAttr()`」 | 仓库里**没有 `escAttr`** 这个函数（只有 `esc`，`panel/index.html:467-471`）；且 `:990` 的 `eps` 未转义 —— 安全结论下得太早 |
| round3 §9「`check_panel_ui.mjs` → PASS（含键盘/主题/待看）」 | 三项都有实际缺陷：键盘抢按钮并误写库（U3）、「自动」主题不生效（P1-U4） 、待看弹窗布局塌（U7）。那个 PASS 只验证了「不报错」 |
| round3 §1.1「`panel/index.html` 1651 行」 | 实际 **1650** 行 |
| round3 P0「把 `PET_HIT_LOG`/`PET_DEBUG_HIT`/`PET_DEBUG_BG`/`PET_CHOICE_TEST` 合并成 `PET_DEBUG=1`」 | **未做**，现在仍是 14 个 `PET_*` 开关 |
| round3 P0「拆 `panel/index.html`」 | 仍未拆，但**优先级应让给本轮 16 条 P0**（拆分不改变任何一条的严重性） |

---

## 8. 复现方法

```powershell
# 1) 起一份隔离副本（真实 data/ 不动）
Copy-Item -Recurse lib,panel,tools,shell,ghost,data cache\audit\round4\sandbox
Copy-Item server.mjs,package.json cache\audit\round4\sandbox
cd cache\audit\round4\sandbox; node server.mjs --port 7793

# 2) S1 崩溃（在另一个窗口）
curl.exe -s -X POST http://127.0.0.1:7793/api/settings -d "{oops" -H "Origin: http://127.0.0.1:7793"
#   → 400 + 进程 exit 1；stderr 出现 ERR_HTTP_HEADERS_SENT

# 3) S3 eps=null
curl.exe -s -X POST http://127.0.0.1:7793/api/watch -H "Origin: http://127.0.0.1:7793" -H "Content-Type: application/json" -d "{\"id\":\"390200\",\"action\":\"add\"}"
curl.exe -s -X POST http://127.0.0.1:7793/api/progress -H "Origin: http://127.0.0.1:7793" -H "Content-Type: application/json" -d "{\"id\":\"390200\",\"delta\":1}"
#   → {"ok":true,"changed":false,...}

# 4) 面板（CDP 无依赖）
cd cache\audit\round4\tmp\lab; node ..\..\..\..\..\server.mjs --port 7799
node ..\fixtures.mjs rich        # 7 组夹具之一
node ..\probe6.mjs               # U3 键盘 + U5 XSS
node ..\probe4.mjs               # U1 跨季加番
node ..\probe10.mjs              # U7 待看布局 + 空态文案
```

截图索引与夹具说明见 `cache/audit/round4/panel.md §8`（31 张 PNG）。**注意**：`cache/` 在 `.gitignore` 里，这些证据不会进版本库——本文 §2/§3 的行号与结论是自包含的，重启机器后按本节命令可重建。

---

## 9. 一份清单：如果只修 5 个

1. **S1**（9 行 `if (!body) return;`）——一条改动消掉全部崩溃路径，成本最低、收益最大。
2. **S2**（restore 走 `writeLibrary`）——唯一会污染用户数据的路径。
3. **U1 + U5**（传 `q` / 补 `esc`）——各一行，一个防脏数据、一个防 XSS。
4. **T2**（`RunNode` 认 `runtime\node.exe` + 超时 Kill）——直接决定便携包在「没装 Node」的机器上能不能用。
5. **L1 + L2**（两个 bat）——用户第一次接触产品的两条路都是断的。

---

## 10. 修复状态（2026-11-09，v0.26.0）

本节是事后补的：审查交卷当天按 `PLAN-v0.26.md` 把四批一次性做完了。**行号会随修复漂移，本节的定位请以函数名 / 接口名为准**（§2、§3 里的行号是修复前的快照，保留原样以便对照）。

| 编号 | 结论 | 修法（现在在哪儿） | 怎么验的 |
| --- | --- | --- | --- |
| S1 | 已修 | 九处 `(await readJsonBody(...)) \|\| {}` → `const body = ...; if (!body) return;`；`json()` 在 `headersSent` 时早退 | `POST /api/settings` 发 `{oops` → 400 且进程仍在（`cache/audit/verify/probe.mjs`） |
| S2 | 已修 | `apiRestore` → `lib/library.mjs` 的 `restoreLibrary()`：白名单、校验、原子写、**不拍备份**、照压撤销栈 | 传 `../../package.json` / `nope.json` → 404 + 可用备份清单 |
| S3 | 已修 | `apiWatch` 加番时从季度表 / 星期表继承 `eps` 与 `track_from`；`apiProgress` 只在 `eps > 0` 时夹上限 | 加一部新番 → `{delta:1}` 回 `changed:true`（`test/server.test.mjs`） |
| S4 | 已修 | 删 `apiReload` 与它的路由 | `GET /api/reload` → JSON 404 |
| S5 | 已修 | 新增 `lib/time.mjs` 的 `parseClock()`：单条与批量同一口径，`25:30` 合法、`abc` 报错、上限 28:59 | `test/time.test.mjs` 5 条 + 探针实测两种接口 |
| S6 | 已修 | `apiState` 删掉无用的 `readJSON('data/talks.json')` | `talks.json` 改坏 → 首屏仍 200 |
| T1 | 已修 | `PostJson` 补 `ReadWriteTimeout = 3000`、`KeepAlive=false`；`BumpShow` / `UndoLast` 改后台线程 + Dispatcher 回调 | `PET_SELFTEST` + 手工 suspend 服务观察 3 秒内回「服务没响应」 |
| T2 | 已修 | `ResolveNode`（`runtime\node.exe` 优先）+ `RunNode`（异步收流、超时反射 `Kill(true)`），三个调用点合并 | 同一台机器改名 `runtime\node.exe` 仍能重建（日志 `node=` 行） |
| U1 | 已修 | `panel/app.js` 批量加番带 `q: SEASON_Q`；服务端查不到就 400 并回 `missing` | 切到 2025Q2 加一部 → 库里是中文名 + `air_weekday` |
| U2 | 已修 | 批量写时刻按 `{ok,count,changed,missing}` 判三种结果 | 勾未在追的行 → 「还没加进在追」；`25:30` → 「时刻要写成 23:00 这种」 |
| U3 | 已修 | `keydown` 排除 `button/a/[role=button]/summary`、弹窗短路、仅选中卡片时接管 Space/Enter | 焦点在主题按钮按 Enter → 只切主题，库不变 |
| U4 | 已修 | `json()/post()` 非 2xx 先置 `ok=false`；服务端 4xx/5xx 自动补 `ok:false` | `test/server.test.mjs` + 面板实测 |
| U5 | 已修 | `app.js` 本季表集数走 `esc()`；封面 `onerror` 改全局捕获，名字不再内联进 HTML | 把 `eps` 改成 `<img onerror=...>` → 表格是字面文本、`document.title` 不变 |
| U6 | 已修 | 本季工具条改 `.fbar season-bar`（流内、取主题变量） | 滚 600px 后 `elementFromPoint(700,20)` 是 header；亮色对比达标 |
| L1 | 已修 | `打开番组表.bat` 只认 `cache\panel_port.txt` + `/api/health` 探活 + 轮询等端口文件 | 用别的程序占住 7788 → bat 打开的是真实端口；连点 3 次只有 1 个服务 |
| L2 | 已修 | `启动TIARA.bat` 在重建后拉起 `server.mjs`（不带 `--port`，单实例探测自己找端口） | 双击启动 → 桌宠「打开网页番组表」不再落到 `file://` |

**P1 里顺手一起修掉的**：写锁内重建（十连点 4183ms → 939ms）、季度缓存裁剪基准、`isLocalOrigin` 恒真、ICS `DTSTAMP` 与折行、代理凭据解析、`getJson` 重试策略、`logLine` 时区、`/api/version` 泄露绝对路径、备份命名 UTC→CST、桌宠单实例 / 尺寸夹紧 / 占位符冻结 / 空闲档 / 双击去重 / alpha 遮罩 / 跨日重试、面板行内数字 / 断网保视图 / 主题跟随系统 / 焦点保留 / 触屏常显 / 弹窗布局。

**仍然没做的**（见 `PLAN-v0.26.md` 实施状态末尾）：`server.mjs` 按路由拆文件、托盘 `GetHicon` 未 `DestroyIcon`、`check_panel_ui` 的小数 `eps`、多显示器真机回归、`ghost/master/words.txt` 取消跟踪（要提交才能做）。
