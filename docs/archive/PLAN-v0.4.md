# TIARA v0.4 修改计划

> 依据：2026-11-04 的反馈（立绘冻结 / 拖动卡顿 / 置顶不可调 / 番剧数据没打通 / ghost 内容太薄）
> 结论先说：**P0 = 拖动 + 置顶 + 番剧数据打通**，P1 = ghost 扩充，P2 = 我加的问题清单。

---

## 0.5 完成情况（2026-11-04 收尾，v0.5）

| 编号 | 事项 | 状态 | 落地位置 |
| --- | --- | --- | --- |
| A | 立绘冻结 + 就近回退 + doctor 校验 | ✅ | `shell/master/`（4 表情 + talk）、`tools/doctor.mjs` |
| B | 拖动卡顿 | ✅ 屏幕坐标 + 拖动时暂停呼吸；`tools/test_drag.ps1` 可复测（maxErr=0） | `pet/Pet.cs` `OnSpriteMove`/`CursorDip` |
| C | 置顶可调 | ✅ 三档：顶层 / 普通 / 沉底，随 state 持久化 | `pet/Pet.cs` `ApplyLayer`/`AddLayerItem` |
| D | 番剧数据打通 | ✅ `lib/bgm.mjs` + `tools/sync_bangumi.mjs` + 面板「同步 Bangumi」+ 桌宠菜单；外网不通时给明确失败文案 | `lib/bgm.mjs`、`server.mjs` `/api/sync` |
| E | ghost 人格扩充 | ✅ 6 段 → 15 段（含 OnNadeNade / OnMouseWheel / 时段问候 / 积压提醒），并出 `dist/TIARA-ssp.zip` | `data/talks.json` → `tools/build_ghost.mjs` → `tools/pack_ssp.mjs` |
| F | 12 个问题清单 | ✅ 除 F4（已是 DPI 正确的蒙版，误报）外全处理：隐藏降频、提醒去重、编辑库重算、端口探测、托盘、自启、自动同步、搜索、备份恢复、历史 | 见各提交 |

**仍未做（写清楚不装死）**：

1. **表情差分**：`sleepy` / `think` 两张真差分——按你的意思立绘冻结，只保留「就近回退」（`sleepy→sad`、`think→normal`）。要补真图，跑 `comfy_faces.mjs` + `import_shell.mjs`，流程在 README §9。
2. ~~**SSP 的到点提醒**~~ → **v0.6 已做**：`ghost-yaya/master/` 用 YAYA 的 `OnSecondChange`，每 30 秒读 `today.json` 的 `all_shows` 比对时间；`node tools/build_yaya.mjs` 生成，`node tools/pack_ssp.mjs --yaya` 打包。见 README §10.2。
3. **真接口验证**：本机 bgm.tv 不可达（代理 127.0.0.1:7890 未启用），同步链路全部用 fixture 验证；网络通了直接点面板「同步」即可，不需要改代码。

---

## 0. 优先级总览

| 编号 | 事项 | 优先级 | 估计 | 风险 |
| --- | --- | --- | --- | --- |
| A | 立绘冻结（只保留校验与回退） | P3（决策） | 0 | 无 |
| B | 拖动卡顿 | **P0** | 0.5 天 | 低 |
| C | 置顶可调 / 层级可选 | **P0** | 0.5 天 | 低 |
| D | 番剧列表与播出表（接 Bangumi） | **P0** | 2–3 天 | 中（依赖外网 + token） |
| E | ghost 人格扩充 | P1 | 2 天 | 低 |
| F | 我加的 12 个问题 | P1/P2 | 2 天 | 低 |

迭代划分：**迭代 1 = B + C + A**（一天内可验收）→ **迭代 2 = D**（数据打通）→ **迭代 3 = E + F**。

---

## A. 立绘：冻结

**决定**：不再新增 / 修改表达式差分，`shell/master/` 保持现状（surface0–3 + talk.png）。

**保留的工作**（只在测试里出现，不占排期）：

- 缺表情的「就近回退」继续有效（`sleepy→sad`、`think→normal`）。
- `doctor.mjs` 继续校验尺寸 384×576 与文件完整性——将来换立绘时能立刻发现规格不对。
- 台词里尽量少用 `sleepy` / `think` 之外的缺位表情，避免「表情没变」的观感。

---

## B. 拖动卡顿（P0）

### 诊断（已定位到代码）

`pet/Pet.cs:1091` `OnSpriteMove()`：

```csharp
Point p = e.GetPosition(this);          // ← 相对「正在移动的窗口」取坐标
double dx = p.X - _dragStart.X;
Left = _winStart.X + dx;                // ← 窗口一动，p 立刻变小，dx 被抵消
```

这是典型的**坐标系反馈**：窗口跟着鼠标右移 10px，鼠标相对窗口就只剩 0px，下一帧 `dx` 归零 → 窗口停住 → 再被推一下。表现出来就是「拖一下、卡一下、被甩在后面」，鼠标越快越明显。

次要原因：

1. 每个 `MouseMove` 都改 `Left/Top`，而这是**带 `AllowsTransparency=true` 的分层窗口**（`pet/Pet.cs:124`），每次移动要重做整窗 alpha 合成，走软件路径；窗口 430×664，代价不小。
2. 拖拽期间呼吸动画（`StartTick`，40ms 一次改 `TranslateTransform`，`pet/Pet.cs:1137`）仍在跑，和位移抢同一帧。
3. `MouseMove` 事件频率跟随鼠标回报率（125–1000Hz），WPF 侧不一定能全吃下，容易堆积。

### 方案

1. **改用屏幕坐标**：`MouseDown` 时用 `GetCursorPos`（user32）记录屏幕点 + 窗口左上角；`MouseMove` 时再取屏幕点，`Left/Top = 起点 + (当前 - 按下)`。屏幕坐标不随窗口移动，反馈环消失。
2. **拖动期间暂停呼吸 ticker**（`_dragging` 时 `_ticker.Stop()`，松手恢复），并把位移合并到 `CompositionTarget.Rendering` 里每帧最多写一次（天然对齐刷新率，多余事件丢弃）。
3. **不加 `Effect`**：确认 `_sprite` / `Border` 上没有 `DropShadowEffect`（分层窗口 + 阴影 = 每帧重算模糊）。
4. 可选：`DragMove()` 兜底方案（交给系统拖拽循环），若 1–3 仍不理想则切换到它。

### 验收

- 以 800px/s 速度左右拖 3 秒，窗口与光标位移误差 < 2px，无「被甩在后面」。
- 拖拽期间 CPU 不超过空闲时的 2 倍（当前空闲约 4–8% 单核）。
- 松手位置准确落进 `data/state.json`，重启回原位。

---

## C. 置顶与层级（P0）

现状 `pet/Pet.cs:130` 写死 `Topmost = true`，用户无法让出层级。

### 方案

- 右键菜单加 **「窗口层级」** 子菜单，三档：
  - **置顶**（默认，现在的行为）
  - **普通**（和别的窗口一样，会被覆盖）
  - **沉底 / 桌面层**（`HWND_BOTTOM`，只在没有窗口时可见，适合当壁纸角色）
- 用 `SetWindowPos` 实现（`HWND_TOPMOST` / `HWND_NOTOPMOST` / `HWND_BOTTOM`），避免反复改 `Topmost` 属性引起的重排。
- 记忆到 `data/state.json` 的 `layer` 字段（`top` / `normal` / `bottom`），下次启动沿用。
- 面板不需要改（它是浏览器窗口）。

### 验收

- 切到「普通」后，点开浏览器能盖住TIARA；切回「置顶」立刻回到最上层。
- 三档切换后重启保持。
- 沉底档下不抢焦点、不挡桌面图标点击（需要配合 `WS_EX_NOACTIVATE` 验证）。

---

## D. 番剧列表与播出表（P0，最大一块）

### 现状

- `data/library.json` 全靠手写：`watching[]` + 手工 `weekday{}.ep_expected`。
- `tools/probe_bangumi.mjs` 只是「探针」，能验证接口通不通，但**不落库**、不进流程。
- 所以现在的「番剧列表」「播出表」本质是**静态样本**——这就是你感觉「没实现」的原因，判断没错。

### 目标

1. 「在看」列表可**一键从 Bangumi 拉取**并合并进 `library.json`。
2. 每周放送表可**自动生成/校正**，不再手工填 `ep_expected`。
3. 断网、无 token 时**退回手工模式**，功能不崩。

### 分三步（可独立验收）

**D1 · 只读日历（不需要账号，1 天）**

`tools/sync_calendar.mjs`：

- `GET https://api.bgm.tv/calendar` → 本周每天的放送列表（subject id / 名字 / 放送星期），缓存到 `cache/bgm/calendar.json`（TTL 1 天）。
- 作用：给 `weekday` 补名字与「这部番周几播」；不碰个人进度。
- 验收：`node tools/sync_calendar.mjs --dry-run` 打印「会新增 3 条 / 会改名 2 条」，不写盘；不带 `--dry-run` 才落库，并先备份 `library.json.bak`。

**D2 · 带 token 同步「在看」与集数（1–2 天）**

`tools/sync_bangumi.mjs`（或把 D1 并进来，用一个 `--calendar / --collection` 开关）：

- `GET /v0/users/{user}/collections?subject_type=2&type=3`（在看）→ 拿 `subject_id / name / eps / ep_status / air_weekday`。
- `GET /v0/subjects/{id}` 或 `/episodes` → 拿首播日、每集 `airdate`，用来**精确推算** `ep_expected`（不再靠手工）。
- 合并策略（关键，避免覆盖你的手工数据）：
  - **网络权威**：`eps`、`air_weekday`、`air_time_cst`（从 calendar 拿不到时间就保留旧值）、`start_date`。
  - **本地权威**：`priority`、`rate`、`comment`、`last_watched`、`ep_status`（除非你显式 `--take-progress`）。
  - 新增的番默认 `ep_status = 0`，并在 diff 里单独列出，让你确认。
- 鉴权：`data/bgm.json`（`{ "user": "...", "token": "..." }`，加进 `.gitignore` 的同类保护）+ 环境变量 `BGM_TOKEN` 优先。
- User-Agent 必须形如 `tiara/0.4 (https://github.com/you/tiara)`，否则 bgm 直接 403（`probe_bangumi.mjs` 里已经踩过这个坑）。
- 备用通道：`tools/bgm-proxy-worker.js`（Cloudflare Worker）套一层，遇到被墙/403 时 `BGM_BASE` 指过去。

**D3 · 接进产品（0.5 天）**

- 面板顶部加「同步番组」按钮 + 「上次同步：xx 分钟前」；失败时 toast 显示原因，不清空旧数据。
- 桌宠右键菜单加「同步番组」，成功后说一句（复用 `remind`/`boot` 池的写法）。
- 启动策略：`启动TIARA.bat` 里若 `cache/bgm/*.json` 超过 12 小时且配了 token，则后台静默同步一次（失败不影响启动）。
- 服务端加 `POST /api/sync`（仅本机 Origin），面板按钮调它。

### 验收

- 新加一部番：在 Bangumi 收藏里点「在看」，跑一次同步，桌宠当天就播报，不用手改 JSON。
- 拔网线：同步失败，界面照常，旧数据可用。
- `--dry-run` 能看清「会改哪些字段」，且**永远不会**动 `priority/rate/comment`。

### 风险与对策

| 风险 | 对策 |
| --- | --- |
| bgm 403（UA/频率） | 固定 UA、请求间隔 ≥1s、失败重试 2 次、缓存兜底 |
| 覆盖手写数据 | 字段级白名单 + `--dry-run` + 每次写前 `.bak` |
| token 泄漏 | 只读 token、`data/bgm.json` 不进任何分享包、README 明确写 |
| 接口变更 | 所有响应先落 `cache/bgm/raw/*.json`，解析失败时能离线复盘 |

---

## E. ghost 人格扩充（P1）

现状：`ghost/master/words.txt` 只有 **6 段**，`today.txt` 是快照；`＊OnSecondChange`、摸头、时段问候都没有，所以 SSP 里「像个客服」。

### 方案

**E1 事件表补齐（0.5 天）**

| 事件 | 现在 | 计划 |
| --- | --- | --- |
| `＊OnBoot` / `＊OnFirstBoot` | ✅ | 分「初次 / 隔了 N 天回来」两种 |
| `＊OnClose` | ✅ | 加「关掉就别再熬夜」变体 |
| `＊OnMouseDoubleClick` | ✅ | 保留 |
| `＊OnNadeNade`（摸头） | ❌ | 新增，接 `headpat` 池 |
| `＊OnSecondChange` | ❌ | 新增：每 60 秒比对 `today.txt` 的 `now_hhmm`，到点播报（这才是 SSP 里的「到点提醒」） |
| 时段问候 | ❌ | 早/午/晚/深夜四套，接 `time_of_day` |
| `＊OnMouseWheel` / `＊OnMinimize` | ❌ | 台词点缀 |

**E2 台词量与质量（1 天）**

- `data/talks.json` 从 **16 池 / 约 45 句** 扩到 **≥ 300 句**，按池分：问候、催更、吐槽、天气、番组知识、深夜、节日。
- 加变量替换：`{nickname}` `{quote}` `{behind_list}` `{count}` `{weekday}`（面板与桌宠已经有 `fill()`，SSP 侧靠生成时替换）。
- 去重：同一句 10 分钟内不重复（Panel/Pet 已有随机，SSP 侧用「上次说过的记在 `today.txt`」实现不了，退而求其次——每池 ≥8 句）。

**E3 双人（1 天，可选）**

- 加「かero（管家鸦）」做吐槽位，`＊OnBoot` 时两人对话两轮；`descript.txt` 配 `sakura.name` / `kero.name`。
- 桌面版不改（单角色），避免两套渲染。

**E4 打包（0.5 天）**

- `tools/pack_ghost.mjs`：把 `ghost/` + `shell/master/` 打成 `TIARA.nar`（含 `install.txt`），双击就能装进 SSP，免去手动拷目录。

### 验收

- SSP 里：启动有播报、摸头有反应、每小时有 `OnSecondChange` 问候、关掉有告别。
- `words.txt` 段数 ≥ 12，台词 ≥ 300 句，`node tools/doctor.mjs` 对 ghost 目录也校验。

---

## F. 我建议一并修的 12 个问题

| # | 问题 | 证据 / 位置 | 优先级 | 修法 |
| --- | --- | --- | --- | --- |
| F1 | 拖动坐标系反馈 | `pet/Pet.cs:1091` | P0 | 见 §B |
| F2 | 置顶写死 | `pet/Pet.cs:130` | P0 | 见 §C |
| F3 | 空闲 CPU 偏高（呼吸 40ms + 分层窗口） | `pet/Pet.cs:1137`，实测约 20% 单核 | P1 | 空闲降到 10Hz + 只在可见时跑；或改 `CompositionTarget.Rendering` |
| F4 | 高 DPI 下命中测试用固定 384×576 蒙版 | 日志 `hit test installed mask=384x576` | P1 | 用 `ActualWidth/Height` 生成蒙版，DPI 变化时重建 |
| F5 | `/api/progress` 没有写保护（任意网页可 POST） | `server.mjs:209` | P1 | 写接口校验 `Origin` 必须是本机；否则 403（只读接口保持宽松） |
| F6 | 端口写死 7788，被占只能报错 | `server.mjs:29`、`打开番组表.bat` | P2 | 被占自动 +1 试到 7799，并把实际端口写 `cache/panel_port.txt`（文件已存在，改成真源头） |
| F7 | 错过提醒不补 | `CheckReminders` 只在 `[开播, +90s]` | P2 | 启动时若发现有「2 小时内已开播但没提醒过」的，补一次「刚刚播了」 |
| F8 | `data/library.json` 只有一个副本 | – | P1 | 每次写库前写 `library.json.bak`（保留最近 5 份），面板加「恢复上一版」 |
| F9 | 无单元测试 | `lib/today.mjs` 238 行纯函数 | P1 | `node:test`：跨日、25:30、空 weekday、`ep_expected` 缺省、落后不误判（这次手验的 5 个用例直接固化） |
| F10 | 面板没有搜索/筛选，番多了难找 | `panel/index.html` | P2 | 顶部加过滤框，按名字/优先级筛 |
| F11 | `today.txt` 里的 `remind_count` 从来没被填 | `tools/build_today.mjs` | P2 | 要么填真值，要么删掉这个键（现在是个谎） |
| F12 | `apiVersion` 的 `files` 里 `goods.txt` 恒为 0（文件不存在） | `server.mjs:249` | P2 | 从列表里去掉 |

---

## 排期

| 迭代 | 内容 | 产出 | 验收方式 |
| --- | --- | --- | --- |
| **1（0.5–1 天）** | B 拖动 + C 置顶 + F1/F2 | 新的 `Pet.exe` | 手拖 3 秒无滞后；三档层级可切并持久 |
| **2（2–3 天）** | D1 → D2 → D3 | `tools/sync_*.mjs` + 面板/桌宠同步入口 | 「在看」里加一部，同步后当天播报 |
| **3（2 天）** | E1–E4 + F3/F4/F8/F9 | 新 `words.txt` + `TIARA.nar` + 单测 | SSP 里摸头/整点/告别都有反应；`node --test` 全绿 |

每一项做完都跑：`node tools/doctor.mjs` + `node tools/build_today.mjs` + 面板截图，保持「改一处、验一处」。
