# 方案：伪春菜化的下一步（v0.18）

> 三件事：① 封面为什么经常加载不出来（已修）；② 传统伪春菜「独特」的到底是什么，我们缺哪几块；③ C# 重做值不值。
> 参考对象：`D:\BaiduNetdiskDownload\伪春菜\伪春菜_橘花2修改增强版`（SSP + 橘花2增强版人格包）。数字都是本机实测。

## 完成情况（v0.18.0 已全部落地）

| 项 | 状态 | 落点 |
| --- | --- | --- |
| 封面服务端落盘 | ✅ | `lib/cover.mjs`、`GET /cover/<id>.jpg`、`data/covers/`（166 张 0.76 MB） |
| P0-1 事件总线 | ✅ | `pet/Pet.cs` 的 `Evt` / `Post()` / `PumpEvents()` / `Dispatch()`；50 ms 画面 / 1 s 秒分刻 / 60 s 提醒三分 |
| P0-2 立绘组件化 | ✅ | `shell/master/faces.json`（canvas + faces.base/overlay + mouth）+ `Grid` 叠层 + `tools/check_faces.mjs` |
| P0-3 分区+冷却+递进 | ✅ | `RegionAt()`、`NadeSay()` 800 ms 冷却 + `nade` 递进 + `affinity` 写 `state.json` 的 `vars` |
| P1-1 变量表与按日快照 | ✅ | `vars` 持久化 + `tools/snapshot_daily.mjs`（`data/backups/YYYY-MM-DD/`，留 14 天） |
| P1-2 选择肢 | ✅ | `SayWithChoices()` / `Choice`；到点提醒给「记一话 / 在看」 |
| P1-3 规则引擎 | ✅ | `data/talks.json` 的 `rules[]` + `TryPickRule()` / `WhenMatches()`（15 分钟去重） |
| P2-1 整点 / 生日 | ✅ | `HourlySay()`（1–7 点静音）、`IsBirthdayToday()`（`settings.json` 的 `birthday`） |
| P2-2 manifest | ✅ | `tools/manifest.mjs` → `dist/manifest.json`（path/size/sha256，`--check` 校验） |
| P2-3 与 SSP 共存 | ✅ | README §10.3 |
| C# 重写 | ⛔ 不做 | 结论不变：只补结构，不整体重写（理由见 §5） |

---

## 0. 一句话结论

- **封面**：不是「图挂了」，是**面板让浏览器自己去拿 `lain.bgm.tv`**。本机直连 24 张 0 成功；走代理 166/166 成功但平均 1.3 秒/张，一屏 100+ 张必然大面积空白。→ 已改成**服务端取一次落盘**（`data/covers/`，实测第二次 3 ms）。
- **伪春菜之所以是伪春菜**：不是画得多，而是**事件驱动的脚本人格 + 图层合成的立绘 + 持久变量表**。我们缺的是这三样「结构」，不是功能数量。
- **C# 重做**：**不建议整体重写**。真正该在 C# 里做的是「事件总线 + 图层合成 + 交互判定」，而这些是**加**，不是「重写」。

---

## 1. 封面问题：根因、实测、修法

### 1.1 根因

面板的封面以前是这么来的：`/api/state` 把远端 URL 塞进 `images`，HTML 里直接 `<img src="https://lain.bgm.tv/...">`。
于是三件事同时发生：

| 问题 | 实测 | 后果 |
| --- | --- | --- |
| 浏览器没走代理 | 直连 24 张 **0/24** 成功（`ERR fetch failed`） | 全白 |
| 单张慢 | 走代理 166/166 成功，**1.3 s/张**；并发 4 → 49 s，并发 8 → 27 s | 边滚边白 |
| 单域名连接数 | 浏览器对同一 host 只开 6 条连接 | 一屏 100+ 张排队，越滚越慢 |
| 数据面太窄 | `images` 只装「今天/本周/在追」**十几条**，本季表 167 条根本没有地址 | 本季表全是首字方块 |

第四点是隐藏最深的一条：本季表的封面**从来没走过 `images`**，它是靠 `data/season/<q>.json` 自己的 `image` 字段——所以「有时有、有时没有」，取决于你看的是哪个页签。

### 1.2 修法（已落盘）

```
浏览器 ──> GET /cover/617452.jpg ──> 有缓存直接发（Cache-Control: 30 天）
                                 └─> 没有就经代理取一次 → 写 data/covers/617452.jpg → 发
```

- **新增 `lib/cover.mjs`**（纯函数，可单测）：`coverIdOf`（只认 1–10 位数字）、`coverCachePath`、`isAllowedCoverUrl`（只放 `*.bgm.tv` 的 https 图片路径，避免这个路由变成任意 URL 代理）、`pickCoverUrl`。
- **`server.mjs` 新增 `GET /cover/<id>.jpg`**：命中磁盘 3 ms 返回；未命中经 `httpGet`（走 `data/bgm.json` 的 proxy）取，**同一张图并发只取一次**（inflight 去重）；取不到回 404，面板退化成首字方块，不裂图。
- **后台预取**：`/api/season` 回包时把这一季的 id 排进队列（并发 4、上限 240），`/api/state` 同样处理今天/本周的 id。用户滚到那儿时图已经在盘上了。
- **面板 `cover()`**：只认 id，一律请求 `/cover/<id>.jpg`；`onerror` 退回首字方块。
- **`doctor` 新增「封面缓存」**：`✅ 封面缓存：166 张 / 0.76 MB`。
- **新增 `test/cover.test.mjs`（5 例）**：id 校验、路径拼接、URL 白名单（`http://` / 外域 / `file://` / 非图片路径全部拒绝）、按 id 取图、缓存头常量。

### 1.3 验收

| 项 | 结果 |
| --- | --- |
| 首次请求 | `200 / 5009 B / 1.35 s`（经代理现取） |
| 第二次请求 | `200 / 5009 B / **0.003 s**`（走磁盘） |
| 非法 id | `400 bad id`；不在缓存季里的 id → `404`（面板退方块） |
| 预热 | 触发 `/api/season?q=2026Q4` 后 25 秒内落盘 **118 → 166 张** |
| 一张周历板截图 | 封面全部本地加载（仅 4 部「不在本季缓存里的番」仍是首字方块：柯南这种长档、以及库里的示例条目） |

> 剩下的方块不是 bug：`111111 / 200002 / 300003` 是演示条目，Bangumi 没有这个 id；`名侦探柯南` 不在 2026Q4 的季度表里。

---

## 2. 传统伪春菜的「独特」到底在哪（带参考项目数字）

它有 303 MB、53 套 shell、63 个 dic、976 个事件名——但**真正让它像个「人」的是下面 7 条机制**，跟体量无关：

### 2.1 事件驱动的脚本人格（SHIORI）

`ssp.exe`（1.0 MB，x86）+ `yaya.dll`（339 KB，x86）构成宿主与脚本引擎。人格只需要实现一堆**事件函数**：

```
OnBoot / OnClose / OnFirstBoot          启动、关闭、第一次启动
OnSecondChange / OnMinuteChange / OnHourChange   每分每秒、整点
OnMouseMove / OnMouseClick / OnDoubleClick / OnMouseWheel   鼠标
OnChoiceSelect / OnChoiceTimeout        选择肢（这就是「对话」的载体）
OnCommunicate / OnOtherGhostTalk        别的 ghost 说话时
OnBoot → 报时 → 闲聊 → 提醒，全是「事件进来，函数出去」
```

`mydic/*.dic` 里出现的 **976 个唯一 `On*` 名字**，就是这个生态系统真实的「API 面」。

### 2.2 人格是数据包，加载表就是架构图

`yaya.txt` 58 行，一行一个模块，注释就是功能清单：

```
dic, mydic\clock.dic      // 时间，整点报时
dic, mydic\rpg.dic        // 养成系统
dic, mydic\OnCalendar.dic // 日历
```

**加载顺序 = 优先级**，一个功能一个文件，坏一个不至于全崩；「有哪些功能」看这张表就够了，不用读代码。

### 2.3 立绘是「图层合成」，不是整张图

`shell/master/surfaces.txt`（1 231 行）每个 surface 长这样：

```
0pattern0,1001,5,overlay,110,50     ← 零件图叠在底图上 (x,y)
1interval,talk,4                    ← 只有说话时才切
collision0,94,4,197,46,Head         ← 碰撞区自带名字
```

统计：38 个 surface 块、**312 个 overlay**、52 个随机变体、118 个碰撞矩形。
一张底图 + 眼睛/嘴/腮红几张零件 = 38 种状态；`interval,talk` 让口型只在说话时出现；`collision` 带名字，脚本里直接拿到 `Head/Face/Hand`。

### 2.4 状态是「变量表 + 日期快照」

`yaya_variable.cfg` 252 个变量（好感 253、心情 105、币 5200…），`bakeup/2026-3-28/` 是**整套人格目录的按日快照**——坏了就整个覆盖回去。

### 2.5 交互是「分区 + 冷却 + 递进」

```aya
if reference4 == "Head"
{
    _talk = "TalkSakuraHeadPat.%(GetPhase).%(headpatcount)"   // 第几次摸头 → 不同台词
    if ISFUNC(_talk) == 1 { EVAL(_talk)  headpatcount++ }
    else { EVAL("TalkSakuraHeadPat.%(GetPhase)") }            // 没有第 N 句就回退
}
```

摸头后 30 tick 内不再触发，并累计「今天被摸了几次」——**同一个动作，第 1 次和第 5 次反应不同**，这就是「人格感」的来源。

### 2.6 用户可扩展：SAORI 插件 + 菜单 + 快捷键

29 个 SAORI DLL（截图、TTS、SQLite、音频、CPU 信息…），加上 `menu.dic` 118 KB 的菜单树——功能是「挂上去」的，不是写死在宿主里。

### 2.7 增量更新 + 多 ghost 共存

`updates.txt` 1 381 行 `<路径>,<md5>,size=…`，只下变化的文件；`ghost/` 下可以并存多个人格，互相通过 `OnCommunicate` 说话。

---

## 3. 我们 vs 传统实现（对照表）

| 维度 | 传统（SSP + YAYA） | 我们（TIARA） | 差距性质 |
| --- | --- | --- | --- |
| 宿主 | `ssp.exe`（C++，x86，1 MB） | `Pet.exe`（C#/WPF，x64，59 KB） | 我们更小，但没有脚本层 |
| 脚本 | YAYA 脚本（`.dic`，63 文件 / 2.4 MB） | `talks.json`（28 个池，纯文本） | **差一个「能跑逻辑」的层** |
| 事件 | 976 个 `On*`，宿主主动派发 | 1 个 33 ms 定时器 + 4 个鼠标事件 | **差一个事件总线** |
| 立绘 | 底图 + overlay 图层（312 个） | 4 张整图 + 1 张口型 | **差图层合成** |
| 交互判定 | 118 个命名碰撞矩形 | 1 个「上部 24% = 头」的矩形 | 差分区 + 冷却 + 递进 |
| 状态 | 252 个变量 + 按日快照 | `state.json` 少量字段 + 库文件滚动备份 | 差变量表 + 整目录快照 |
| 扩展 | SAORI DLL / 菜单树 / 快捷键 | 无（每加功能改 `Pet.cs`） | 差扩展点 |
| 数据/网络 | 基本没有（靠插件） | Node 侧车（Bangumi/季节表/ics/统计） | **我们更强** |
| 分发 | `.nar` 包 + 手动覆盖 | `dist/*.zip` + 便携包 + git | 我们更强 |

**结论：我们强在「数据与工程」，弱在「脚本与呈现」。** 传统强项全是结构化，不是内容量。

---

## 4. 能直接拿参考项目做什么（三档，按风险从低到高）

| 档 | 做法 | 能拿到什么 | 成本 | 风险 |
| --- | --- | --- | --- | --- |
| **A. 零改造复用** | 便携包里附「完整体验包」说明：用户自己去下那份 SSP 包，双击 `ssp.exe` 就能跑橘花2 | 立刻拥有 976 事件 / 53 套服装 / 63 模块的全部能力 | 0（只写文档链接，不内置 300 MB） | 与我们数据不通，是「另一个产品」 |
| **B. 借格式** | ① `surfaces.txt` 的 `overlay / interval,talk / collision,名` 语义搬进 `shell/faces.json`；② `updates.txt` 的 `path,md5,size` 清单搬进 `dist/manifest.json`；③ `bakeup/` 的按日快照搬进 `data/backups/YYYY-MM-DD/` | 立绘组件化、增量更新、可回滚备份 | 2–3 天 | 无（格式是我们自己的） |
| **C. 借语料** | 从 63 个 dic 里抽台词。**实测**：原始引号字符串 15 675 条，去掉 `\s[13]`/`\w9`/`\e` 等标记后，中文候选 **2 843 条** | 一批现成的中文句子 | 抽 + 分类 ~1 天 | 抽样看：约 1/4 是真台词（「今天也要好好加油呢。」），其余是 UI 提示（「请输入报菜名…」）；**而且都是「橘花」的口吻**，直接搬会串味 |

> 我的建议：**做 B，做 C 的一小部分（通用问候/心情/天气，人工筛 100–200 条），A 只写文档不内置。**

---

## 5. C# 重做有没有必要

把现在的实现按「重写收益」分三类：

### 5.1 不必重写（保持 Node）

| 模块 | 现状 | 重写成 C# 的代价 |
| --- | --- | --- |
| `server.mjs` 1 383 行（19 条路由 + 写锁 + 撤销栈 + 日志） | 74 例单测全过，改一行见效 | ~1 500 行 + HttpListener + 重写全部测试，**收益只有「少一个 94 MB 的 node.exe」** |
| `lib/bgm.mjs` 556 行（Bangumi 拉取、合并、代理隧道） | 覆盖真实接口、代理、并发池 | CONNECT 隧道、分页、合并策略都要重做 |
| `lib/today.mjs` 353 行（30 小时制、落后判定、提醒窗口） | 有跨日/跨年测试 | 时区与边界条件是坑，重写等于重踩一遍 |

**替代方案（更便宜）**：便携包已经带 `runtime/node.exe`（94 MB，自包含）。若真嫌大，还有两条更小的路——
① 只把「重算 today.txt」这一步用 C# 写掉（~200 行），面板服务仍用 Node；
② 保留 Node，但提供「无 Node 降级模式」：没有 runtime 时桌宠只读旧 `today.txt`（**这已经实现了**）。

### 5.2 该在 C# 里做（但是「加」，不是「重写」）

| 事项 | 为什么必须 C# | 工作量 |
| --- | --- | --- |
| 事件总线（tick / second / minute / hour / 输入事件） | 现在是一个 33 ms 定时器管所有事，加功能就得往里塞 if | 0.5 天 |
| 图层合成（底图 + 眼 + 嘴 + 腮红） | WPF 现成的 `Canvas + Image`，做起来比 Node 舒服 | 1 天 |
| 分区命中 + 冷却 + 递进台词 | 需要高频鼠标事件与本地状态 | 0.5 天 |
| 全局热键 / 托盘快速记账 | 已在做（托盘菜单） | 已完成 |

### 5.3 结论

> **不整体重写。** 把 C# 侧当「宿主（shell）」，Node 侧当「数据与网络」——这正是传统伪春菜的架构（宿主 + SHIORI 脚本 + SAORI 插件），只是我们的「脚本」换成了 JSON + JS。
> 如果要更进一步，**真正值得做的是给 `talks.json` 加一层「条件 → 台词」的规则引擎**（等价于 YAYA 的 `if/else`），而不是换语言。

---

## 6. 路线图

| 优先级 | 事项 | 具体做法 | 借什么 | 验收 | 工时 |
| --- | --- | --- | --- | --- | --- |
| **P0-1** | 桌面事件总线 | `Pet.cs` 拆 `TickTimer(33ms 仅渲染)` / `LogicTimer(1s)` / `ReminderTimer(60s)`；鼠标/托盘/HTTP 事件进同一队列，按 `On*` 命名派发 | SHIORI 的 `OnSecondChange/OnMinuteChange` 分层 | 静置 CPU ≤1%，加功能不再改定时器 | 0.5 天 |
| **P0-2** | 立绘组件化 | `shell/master/` 拆 `base.png + eyes_{open,half,closed}.png + mouth_{0,1}.png + blush.png`；新增 `shell/faces.json` 描述组合与碰撞矩形；`FaceImage` 改成拼层 | `surfaces.txt` 的 `overlay / interval,talk / collision,名` | 6 表情 → 20+ 组合；缺零件自动降级不空图 | 1 天 |
| **P0-3** | 分区交互 + 冷却 + 递进 | 命中 Head/Face/Hand；停留 300 ms 触发；摸头 800 ms 冷却；`talks.nade.head[]` 第 1–3 次各一句，之后随机；次数写 `state.json` | `TalkSakuraHeadPat.%(phase).%(count)` 的递进 + 回退 | 连摸三下，三句不同；第 4 下开始随机 | 0.5 天 |
| **P1-1** | 变量表 + 按日快照 | `data/state.json` 增 `vars`（好感/心情/今日互动次数）；备份改 `data/backups/YYYY-MM-DD/`（library+settings+state+history） | `yaya_variable.cfg` + `bakeup/` | 面板「恢复上一版」按日期列 | 0.5 天 |
| **P1-2** | 选择肢（这是「对话」） | 气泡下方 2–4 个按钮（`OnChoiceSelect` 的等价物），点完写变量并接下一句；先做「今天看哪部」「要不要补一话」两个场景 | SSP 的选择肢 + 超时回退 | 点「记一话」后追问「还要记下一话吗」 | 1 天 |
| **P1-3** | 规则引擎（轻量） | `talks.json` 每条允许 `when: {hour>=23, weekday:5, behind>0, nade_count>3}`，命中优先于随机池 | YAYA 的 `if` + `GetPhase` | 「周五 23 点且落后」必说提醒句 | 1 天 |
| **P2-1** | 整点报时 / 生日 / 纪念日 | 逻辑定时器 + `vars.birthday`；台词池 `hourly/anniversary` | `clock.dic` 的 `OnHourChange` | 整点说一句，生日当天说特殊句 | 0.5 天 |
| **P2-2** | 增量更新清单 | `tools/manifest.mjs` 生成 `dist/manifest.json`（path/sha256/size），doctor 校验产物 | `updates.txt` | 产物与源不一致时 doctor 报错 | 0.5 天 |
| **P2-3** | 与 SSP 共存（可选） | 便携包附「完整体验包」说明 + 我们自己的 `.nar`（已有 `pack_ssp`） | 参考项目本身就是个 nar 包 | 用户能选「TIARA 或 橘花2」 | 0.5 天 |

**建议先做 P0-1 / P0-2 / P0-3**：三天内能把「像个普通桌宠」变成「有反应的角色」，且不碰数据层、不增加分发体积。

---

## 7. 明确不做

- ❌ 把 53 套服装 / 300 MB 立绘搬进来——画风不一致，`REFERENCE-taromati2.md` 里已经验证过 ComfyUI 补差分走不通。
- ❌ 用 C# 重写 server / 同步 / 时间计算——收益只有省 94 MB 运行时，代价是全套测试重来。
- ❌ 直接搬 2 843 条橘花台词——口吻不是 TIARA 的，串味比没有更糟；只人工挑通用句。
- ❌ 复刻 976 个事件名——它们是那套生态的历史沉积，不是清单；我们按需加。

---

*本文所有数字均为 2026-11-05 本机实测。封面修复已落盘并提交；P0 起为待批准项。*
