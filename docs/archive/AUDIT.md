# 伪春菜 · 功能盘点与更新路线图

> **2026-11-04 03:55 复核**：`03:38–03:44` 期间 `Pet.cs`/`Pet.exe`/`server.mjs`/`panel/index.html`/`README.md`/`shell/tiara2` 有改动，本文件部分结论已过时。最新确认结果见 [AUDIT-RECHECK.md](AUDIT-RECHECK.md)（4 项已解决/降级，22 项确认仍存在）。

> 盘点时间：2026-11-04 03:30（CST）
> 盘点方式：读源码 + 跑实际进程（Pet.exe 正在运行，面板服务 127.0.0.1:7788 在线）+ 截图 + 逻辑探针。
> 结论先说：**「离线番组管家」的骨架已经完整可用**（数据 → 计算 → 桌宠/面板两条表现层 → SSP 文件兼容），
> 但目前是一个**只读、只在启动时算一次、不会提醒、不会记账**的管家。下一步的重点不是加新花样，
> 而是把「重读 / 跨日 / 到点 / +1」这四件让管家真正有用的事补上。

---

## 0. 一句话版本

| 维度 | 现状 |
| --- | --- |
| 能用的 | 离线报今日番组、追番进度差、待补完、周排片、摸头/戳脸/拖动、面板纸质 UI、6 套立绘一键切换、ComfyUI 出图管线、SSP 台词文件生成 |
| 半成品 | 桌宠的「重读数据」只重读快照不重算；台词有两套（C# 硬编码 / talks.json）；「落后」只在当天有番时才看得见 |
| 缺的 | 到点提醒（PLAN 的 P1）、本地 +1 记账、跨日刷新、窗口位置记忆、托盘/开机自启、SSP 可直接安装的包 |
| 隐藏坑 | 当前生效立绘只有 4 张 surface（sleepy/think 缺失）；面板服务是 1:10 启动的旧进程（server.mjs 1:15 又改过）；无 git、无测试 |

---

## 1. 系统全貌

```
data/library.json ─┬─ lib/today.mjs ─┬─ tools/build_today.mjs → ghost/master/today.txt  ─→ pet/Pet.exe（WPF 桌宠）
                   │                 │                        → data/today.json        ─→ 调试/未来面板
                   │                 └─ server.mjs /api/state ─→ panel/index.html       （浏览器面板，实时现算）
                   └─ data/talks.json ── tools/build_ghost.mjs → ghost/master/words.txt ─→ SSP（里々 + shell/master）
                                        └──────────────────────→ panel/index.html 的台词池
shell/<套名>/surface*.png ── tools/switch_shell.mjs ──→ shell/master/ （当前生效）
cache/（ComfyUI 原图、抠图中间件、网络素材）── tools/comfy_* + tools/ImageTool.exe ──→ shell/*
```

两条表现层共用一份 `library.json`，但**不是一个数据通道**：

- 面板：每次 `/api/state` 都用 `lib/today.mjs` 从 `library.json` 现算（`server.mjs:101-134`）。
- 桌宠：只读 `ghost/master/today.txt` 这份启动时生成的快照（`pet/Pet.cs:376-404`）。

所以「改了 library.json → 面板刷新就对，桌宠要重启/重算」——README §1 说「两者都只读同一份今日数据」并不准确，这是当前最容易让人困惑的地方。

### 规模

| 部分 | 文件 | 行数 |
| --- | --- | --- |
| 桌宠 | `pet/Pet.cs` | 812 |
| 面板 | `panel/index.html` | 564（单文件，无构建） |
| 面板服务 | `server.mjs` | 172 |
| 计算核心 | `lib/today.mjs` | 85 |
| 构建/素材工具 | `tools/*.mjs` 14 个 + `ImageTool.cs` 502 行 | — |
| 立绘组 | `shell/{master,tiara,chibi,cute,e1,codel,maid}` | 6 套可切换 + 当前 master |
| 缓存 | `cache/` | 238.5 MB |

---

## 2. 已实现功能清单（逐项实测）

### 2.1 数据与计算层

| 能力 | 落点 | 状态 |
| --- | --- | --- |
| 追番库单一真源（watching / weekday / trivia / user） | `data/library.json` | ✅ 可用（当前是「示例：」占位数据） |
| CST 固定 +8 时区换算，不受宿主机时区影响 | `lib/today.mjs:11-20` | ✅ 探针验证：`2026-11-04T20:00Z → 2026-11-05 周四 04:00` |
| 今日番组按时间排序 | `lib/today.mjs:33-48` | ✅ |
| 进度差 `behind = ep_expected - ep_status` | `lib/today.mjs:44,51` | ⚠️ 依赖手填的 `ep_expected`，忘了改就会报错数 |
| 待补完（完结未看完） | `lib/today.mjs:54-56` | ✅ |
| 已播/待播/下一部/最后一部 | `lib/today.mjs:62-75` | ✅ 但只算「今天这一天」 |
| 今日一句话（给台词用） | `lib/today.mjs:78-85` | ✅ |
| 生成 `ghost/master/today.txt`（31 个 key） | `tools/build_today.mjs` | ✅ 当前 `count=0 / weekday=3` |
| 生成 `data/today.json` | `tools/build_today.mjs:97-101` | ⚠️ 生成了但没有任何程序读它 |
| 生成 さくらスクリプト 台词 | `tools/build_ghost.mjs` | ✅ 6 段（OnFirstBoot/OnBoot/OnClose/OnMouseDoubleClick/ランダム/今日） |
| 缺表情自动退回 normal | `build_ghost.mjs:32-38` | ✅ 当前只有 0..3，`\s[4] \s[5]` 自动降级 |

### 2.2 桌宠（Pet.exe / WPF）

| 能力 | 落点 | 状态 |
| --- | --- | --- |
| 无边框 + 分层透明 + 置顶 + 不占任务栏 | `Pet.cs:103-115` | ✅ 实测 `cache/pet_render_text.png` 正常出图 |
| 说话时窗口向上长高、说完缩回，避免挡住别处 | `Pet.cs:593-600` | ✅ 窗口 572 ↔ 664 |
| 立绘 6 槽 + 缺图回退 surface0 | `Pet.cs:397-404,418-439` | ⚠️ 当前日志明确报 `missing surface4 / surface5` |
| 气泡打字机 28ms/字 + 6 秒自动隐藏 | `Pet.cs:549-590` | ✅ |
| 呼吸（sin 5.4s）+ 跳跃 | `Pet.cs:884-901` | ✅ 但 33ms 定时器常驻，实测**占满一个核的 ~20%**（5 秒 +1.00s CPU） |
| 拖动 / 单击 / 双击 / 摸头（y < 26%） | `Pet.cs:857-880` | ✅ 日志可见三类反应都触发过 |
| 右键菜单：番组表 / 说句话 / 重读数据 / 退出 | `Pet.cs:318-334` | ⚠️ 「重读数据」只重读 today.txt，不重算 |
| 番组表 Popup（今日列表 / 空则本周排片 / 待补 / 今日一句） | `Pet.cs:637-735` | ✅ 固定宽 306、无滚动条 |
| 随机说话 45–90 秒 | `Pet.cs:612-627` | ✅ |
| DPI 感知清单 + 落地后 Win32 实测兜底 | `pet/app.manifest`、`Pet.cs:209-244` | ✅ 日志 `dpiScale=1.25`、`snap rect` 生效 |
| 运行日志（每次启动重写） | `Pet.cs:88-94` | ✅ |
| 调试开关 `PET_DEBUG_BG` / `PET_SNAPSHOT` | `Pet.cs:107,144-156` | ✅ 效果可见 `cache/pet_render*.png` |

### 2.3 面板（server.mjs + panel/index.html）

| 能力 | 落点 | 状态 |
| --- | --- | --- |
| 零依赖静态服务 + `/api/state` 实时现算 | `server.mjs:101-158` | ✅ 实测返回 200 与完整 JSON |
| `/sprite/*.png` 立绘直出 | `server.mjs:142-145` | ✅ |
| 纸质番组表 UI（今日 / 本周 / 待补 / 今日一句 / 本地数据） | `index.html:466-515` | ✅ 截图 `cache/audit/panel.png` |
| 打字机气泡 + 红色光标 + 尾巴 | `index.html:330-386` | ✅ |
| 摸头（顶部 24% 居中）/ 双击 / 拖动 + 位置 localStorage | `index.html:517-559` | ✅ |
| 首次访问自动展开面板，之后记住选择 | `index.html:593-599` | ✅ |
| 会话内 42–88 秒随机说话 + 1–4 点深夜台词 | `index.html:422-439` | ✅ |
| 行点击吐槽（差几话 / 看齐了） | `index.html:504-514` | ✅ |
| `/api/health` | `server.mjs:140` | ✅ |
| 端口占用友好退出 | `server.mjs:159-166` | ⚠️ 直接 exit，导致改了 server.mjs 也永远跑旧进程 |

### 2.4 素材与 SSP

| 能力 | 落点 | 状态 |
| --- | --- | --- |
| 6 套立绘一键切换（tiara / chibi / cute / e1 / codel / maid） | `tools/switch_shell.mjs` | ✅ 当前 master = tiara（4 表情） |
| ComfyUI txt2img + LoRA + hires + 多预设 | `tools/comfy_basori.mjs` | ✅ 预设 base/A~K + sweep/portrait |
| img2img 表情差分 / 只改脸的局部重绘 | `comfy_faces.mjs`、`comfy_face_edit.mjs` | ✅ 脸框/眼带蒙版/羽化贴回 |
| 抠图 / 裁边 / 裁半身 / 贴回 / 条带蒙版 / 缩放 / 信息 | `tools/ImageTool.cs|exe` | ✅ 9 个子命令 |
| 网络 CC-BY 素材导入 + 署名文件 | `tools/import_shell.mjs` | ✅ `shell/codel`、`shell/maid` 带 CREDITS |
| csc 编译 Pet.exe（无 SDK） | `tools/build_pet.mjs` | ✅ 需 `/win32manifest` 与 WPF 子目录里的 WindowsBase |
| SSP 人格文件（descript + words.txt + shell） | `ghost/master/`、`shell/master/` | ⚠️ 结构对，但**缺 `shiori/` 与 `install.txt`，不能直接拖进 SSP** |
| 两个批处理入口 | `启动TIARA.bat` / `打开番组表.bat` | ✅ |

---

## 3. 实测记录（可复现）

```
Pet.exe  pid 35320  start 03:24:09   CPU 累计 14.6s（≈20% 单核，33ms 动画定时器常驻）
pet.log  today.txt vars=31  summary=周三没有要追的番。主人，要不要去补番？
pet.log  missing surface4 / surface5
pet.log  dpiScale=1.25  snap rect=2000,725,2538,1440 screen=2560x1440  d=0,-16
server   127.0.0.1:7788 监听中（pid 6648，启动于 01:10:02；server.mjs 修改于 01:15:01 → 跑的是旧代码）
/api/state  → date=2026-11-04 周三, today=[], behind=[], catchup=[], faces 4 张
node 探针   周四 count=1 / 周五 count=1 behind=药屋:1 / 周六 0 / 周日 1；timeline 22:00 与 23:30 都正确
```

![面板实测](cache/audit/panel.png)

![桌宠渲染（PET_SNAPSHOT）](cache/pet_render_text.png)

---

## 4. 发现的问题

### P0 · 现在就会让人怀疑「坏了」

| # | 问题 | 位置 | 说明 / 修法 |
| --- | --- | --- | --- |
| 1 | 面板服务跑的是旧进程 | `server.mjs:159-166` | 进程 01:10 起、代码 01:15 改。`EADDRINUSE` 直接 `exit(0)`，用户永远看到旧页面。加 `/api/version` 输出 mtime+hash，批处理比对不一致就 `taskkill` 重启 |
| 2 | 「重读数据」不重算 | `Pet.cs:330,376-404` | 只重读 `today.txt`。改了 `library.json` 后点它仍然说旧话。修法：菜单项先 `Process.Start(node tools/build_today.mjs)`（隐藏窗口）再 `LoadData()`；或让 Pet 直接读 `data/today.json`（需 `System.Web.Extensions.dll` 的 `JavaScriptSerializer`） |
| 3 | 跨日不刷新 | `Pet.cs` 无 00:00 定时器 | 桌面宠物常年不关，过了午夜还在报昨天的番。加 DailyTimer：下次 00:00:05 触发 `LoadData()` + 「新的一天」台词 |
| 4 | 当前立绘缺 sleepy / think | `shell/master/surfaces.json` 只有 4 槽 | 台词池里约 1/3 带 `face=4/5`，全部退化成 normal。补两张差分（`comfy_face_edit --face sleepy --denoise 0.62`）或把台词 face 重映射 |
| 5 | 长台词会被窗口切掉 | `Pet.cs:56-58,593-600` | 说话高度只有 664-560=104px，2 行以上气泡（如 talks 里带 `\n` 的句子）会顶出窗口。改 `SizeToContent`/`MaxHeight`+`ScrollViewer`，或气泡放窗口外层 Popup |
| 6 | 「落后」只在当天有番时才报 | `lib/today.mjs:51` | 周五才播的番，周三差 1 话却完全不提。应遍历 `watching`，用「最近一次放送日 + 周更」推算应看到第几话 |
| 7 | 数据重复维护 | `data/library.json` 的 `watching` 与 `weekday` | 同一个名字/时间写两遍；改 `watching.name_cn` 不会同步到排片行（面板显示 weekday 表里的名字）。`weekday` 只留 `{id,time_cst,ep_expected}`，名称从 watching join |

### P1 · 设计债（不影响跑，但会拖住后续）

| # | 问题 | 位置 | 说明 |
| --- | --- | --- | --- |
| 8 | 台词两套 | `Pet.cs:447-492` vs `data/talks.json` | 桌宠 30 条硬编码在 C#，改一个字要重编译；面板走 talks.json。建议 `build_ghost` 顺带输出 `ghost/master/pet_lines.txt`，Pet 读文件 |
| 9 | 桌宠没有时间概念 | `Pet.cs:447-492` | 凌晨 4 点也说白天的词；`lateNight` 只有面板在用 |
| 10 | 退出不说再见 | 无 `Closing/Closed` 处理 | `talks.close` 在面板和桌宠都从未触发过 |
| 11 | 面板不刷新 | `index.html:576-608` | 只在加载时取一次 `/api/state`；`clock`、`timeline.aired/upcoming`、`rate`、`comment`、`last_watched` 全部没被渲染 |
| 12 | 本周排片只在今天为空时出现 | `index.html:473-490`、`Pet.cs:683-698` | 想看整周必须先等到空番日 |
| 13 | 窗口位置不记忆 | `Pet.cs:121-123` | 每次启动回右下角；面板端用 localStorage 记了，桌宠没有 |
| 14 | 透明区域仍然吃点击 | `Pet.cs:290-302` | Image 是矩形命中，PNG 透明部分也挡住下层窗口。用 alpha 生成 `collision` 区域 / `WM_NCHITTEST` 返回 `HTTRANSPARENT` |
| 15 | 多屏只认主屏 | `Pet.cs:209-244` | `GetSystemMetrics(0/1)` 是主屏尺寸；副屏上会被拽回主屏。改 `MonitorFromWindow + GetMonitorInfo` |
| 16 | 立绘在 125% 下偏软 | 384×576 源 → 560 DIP → 700 物理像素 | 等效放大 1.22×。导 768×1152 版即可 |
| 17 | 后端字段大半闲置 | `server.mjs:111-133` | `watching`、`timeline.aired/upcoming`、`clock`、`faces` 之外的字段面板几乎没用 |
| 18 | `data/today.json` 无人消费 | `build_today.mjs:97` | 要么让 Pet 读它（见 #2），要么删掉 |
| 19 | 无 schema 校验 | 全流程 | `library.json` 里 `ep_expected`、`time_cst`、id 引用错了只会在界面上安静地错 |
| 20 | 无测试 | — | `lib/today.mjs` 是纯函数，最适合 `node --test` |

### P2 · 小问题 / 文案与实情不符

| # | 问题 | 位置 |
| --- | --- | --- |
| 21 | README §1「两者只读同一份今日数据」不准确 | `README.md:20` |
| 22 | README §5 说 tiara 有「6 表情差分」，实际 4 张 | `README.md:130,144` |
| 23 | `shell/tiara/CREDITS.txt` 写「网络公开素材」，与「用户提供、画师已授权」矛盾 | `shell/tiara/CREDITS.txt` |
| 24 | `shell/master/descript.txt` 缺 `surface.size` / `collision` | `shell/master/descript.txt` |
| 25 | `ghost/master/descript.txt` 定义了 `kero.name=阿番`，但没有 kero 立绘 | `ghost/master/descript.txt` |
| 26 | `safeJoin` 只用 `startsWith`，未加 `path.sep` 边界 | `server.mjs:67-73` |
| 27 | 全站 `Access-Control-Allow-Origin: *` | `server.mjs:79-84,91-99` |
| 28 | `cache/` 238MB，其中 `_cdp3..6` 是浏览器自动化残留 | `cache/` |
| 29 | 无 `.gitignore`、无版本控制 | 仓库根 |
| 30 | 双击会先触发一次单击台词，再说双击台词 | `Pet.cs:825-841` |

---

## 5. 更新路线图

### P0 · 修「说的和做的对不上」（约 3 小时）

1. 重启面板服务 + 加版本自检（#1）
2. 桌宠「重读数据」= 重算 + 重读（#2）
3. 跨日 00:00 自动重算（#3）
4. 补 surface4/5，或统一改台词 face（#4）
5. 气泡高度自适应（#5）

**验收**：改一条 `library.json` → 点「重读数据」/等到 0 点 → 桌宠立刻说新数据；放一句 3 行台词不被切。

### P1 · 把「管家」做实（2–4 天）

| 事项 | 做法 | 验收 |
| --- | --- | --- |
| **到点提醒**（PLAN 的 P1） | `DispatcherTimer` 30s 扫 `showN_time`；T-10min / 开播时刻各说一次，已提醒集合写 `data/state.json`。跨日：当天没番就看明天 00:30 那批 | 改 `show1_time` 到 2 分钟后，桌宠主动开口 |
| **本地 +1 记账** | 面板行内「+1」→ `POST /api/progress {id,delta}` → 服务端 **临时文件 + rename** 原子写 `library.json`，同步 `weekday[id].ep_expected`；`/api/state` 返回新值 | 点 +1 → 面板进度+1、`today.txt` 重算后桌宠也说新进度 |
| **全量落后检测** | `watching` 全表按 `air_weekday + start_date` 推算当前应看到第几话；补 `start_date` 字段，`ep_expected` 作覆盖值 | 非放送日也能说「药屋差 1 话」 |
| **状态持久化** | `data/state.json`：窗口位置、好感度、上次互动、已提醒集合、上次 boot 日期 | 重启桌宠位置不变 |
| **统一台词源** | `build_ghost` 额外输出 `ghost/master/pet_lines.txt`（`组名|face|文本`），Pet 启动读它、`重读数据` 时重载 | 改 talks.json → 重算 → 桌宠换词，不碰 C# |
| **时段台词** | 按小时把 `random` 分成 早/午/晚/深夜，Pet 取对应池 | 凌晨只说 lateNight 系 |
| **面板补信息** | 常显本周七日表；行内 `已播/待播`、`rate`、`last_watched`、进度条；30s 轮询或 SSE | 一眼看到「本周 + 每部进度 + 今天已播到哪」 |
| **托盘 + 自启** | `System.Windows.Forms.NotifyIcon`（csc 加 `/r:System.Windows.Forms.dll`）+ 启动文件夹快捷方式 | 关到托盘、开机自动出现 |

### P2 · 补齐「伺か」语义（1–2 周）

| 事项 | 说明 |
| --- | --- |
| **打成可安装的 `.nar`** | `ghost/master/{descript.txt,words.txt,today.txt}` + `ghost/master/shiori/`（里々或 YAYA）+ `install.txt`（`type,ghost` / `directoryname`），`tools/pack_ssp.mjs` 出 zip。现在这套装不进 SSP，只差这一步 |
| **YAYA 人格** | PLAN §9.2 的第 3 条：把 today.txt 的逻辑搬进 YAYA，`＊OnSecondChange` 做提醒、直接读文件，不再依赖外部重算 |
| **触摸语义** | `collision0/1.png` + `＊OnNadeNade`；现在摸头台词混在 `＊ランダム` 里，SSP 端摸头没有专属反应 |
| **待机小动作** | `animation.txt` + 眨眼两帧；现在只有呼吸位移 |
| **音效 / 语音** | 点击、提醒音；TTS 用系统 `System.Speech`（免装） |
| **点击穿透** | alpha 蒙版命中测试（#14），桌宠真正「不挡事」 |
| **多屏 + 高 DPI 立绘** | `MonitorFromWindow`；导 768×1152 立绘（#15、#16） |
| **统计页** | 累计看完集数、本季进度、最长断更天数——低成本高感知 |

### P3 · 工程与长期

| 事项 | 说明 |
| --- | --- |
| `git init` + `.gitignore` | 忽略 `cache/`、`*.exe`、`pet/pet.log`、`data/today.json`、`ghost/master/{today,words}.txt`（生成物） |
| `node --test` | 覆盖 `lib/today.mjs`：跨 UTC/CST 日界、`25:30`、空库、`ep_status` 缺失、`timeline` 边界（22:00/23:00/23:30） |
| `tools/validate_library.mjs` | id 唯一、`time_cst` 格式、`weekday.id` 必须存在于 watching、`ep_status ≤ eps`、`air_weekday ∈ 1..7` |
| 缓存治理 | `cache/_cdp*` 删掉；`gen/matted/variants*` 归档到 `cache/_archive/`；加 `tools/prune_cache.mjs` |
| 安全小修 | `safeJoin` 加 `path.sep`；CORS 收窄到 `http://127.0.0.1:7788`；只绑 127.0.0.1（已是） |
| 文档对齐 | README §1/§4/§5 按上面 #21–#23 修正；把「重读数据=重算」写清楚 |
| 联网（暂缓） | PLAN §2 的 Bangumi 通道等网络可通再上；保持 `library.json` 契约不变，只换生成者，符合 PLAN §9.5 的分层 |

### 不建议现在做

- **LLM 对话 / Live2D**：会把「零依赖、离线、可复现」三个优点一次性丢掉。真要做，也应作为可选插件，并保留台词池兜底。
- **联网 + OAuth + 写回 Bangumi**：网络当前不通（PLAN §3.1），先把本地闭环做扎实；`+1` 写本地 JSON 已经能满足 90% 需求。

---

## 6. 建议的下一步三件事（可以直接开工）

1. **修 P0-1/2/3**：重启面板服务、桌宠「重读=重算」、跨日自动刷新。—— 半天内让「数据一改就生效」。
2. **做到点提醒**：30 秒扫描 + `state.json` 去重 + 气泡/跳跃反馈。—— 这是番组管家唯一还缺的核心动作。
3. **补 +1 与全量落后**：面板/右键都能 +1，原子写回 `library.json`，并让「落后」不再只在放送日出现。—— 从「会报」变成「会记」。

做完这三件，桌宠与面板才真正共用同一条事实来源；之后再做 `.nar` 打包与 YAYA 人格，才算把「伪春菜」这层壳补齐。
