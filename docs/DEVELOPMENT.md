# TIARA 开发文档

从源码运行需要 Node.js 18 或更新版本。编译 Windows 桌宠需要 Windows 上的 .NET Framework 4.x。使用便携包的读者可以先看[用户指南](../README.md)。

## 本地开发

- 运行 `node tools/build_today.mjs` 生成今日快照，运行 `node server.mjs` 启动本地面板。终端会显示实际地址。
- 改动桌宠后运行 `node tools/build_pet.mjs`。运行 `node tools/ci.mjs` 检查脚本、测试和文档版本。
- 发布 Windows 便携包时，先运行 `node tools/fetch_runtime.mjs` 准备运行时，再运行 `npm run pack:portable`。打包脚本会生成一份空番库。

## 4. 目录结构

```
伪春菜/
├─ 启动TIARA.bat           # 启动桌宠，由桌宠在后台启动网页服务
├─ 打开番组表.bat         # 起服务（已在跑就复用）→ 开浏览器
├─ 停止TIARA.bat           # 关桌宠 + 关服务
├─ server.mjs             # 本地 HTTP 服务（零依赖）
├─ lib/
│  ├─ today.mjs           # 唯一的时间/排片计算逻辑（纯函数，可单独 import）
│  ├─ library.mjs         # 写库唯一入口：时间戳/备份/撤销栈/原子写
│  ├─ atomic.mjs          # 原子写盘（tmp + rename）
│  ├─ time.mjs            # 开播时刻的唯一一种写法（'25:30' 合法，'abc' 拒绝）
│  ├─ version.mjs         # 版本号真源（读 package.json）
│  ├─ season-cache.mjs    # 季度表缓存 + 只保留当前季/刚写的季度 ±3 季
│  ├─ ics.mjs             # 日历导出（DTSTAMP 用真 UTC，长行按字节折行）
│  └─ bgm.mjs             # Bangumi API 客户端 + 合并规则（纯函数，零依赖）
├─ data/
│  ├─ library.json        # ★ 你的番组库（手工维护 / 同步写入）
│  ├─ library.json.bak    # 上一次写入前的备份（面板「恢复上一版」用它）
│  ├─ backups/            # 滚动 5 份备份（每次写库留一份）
│  ├─ history.jsonl       # 进度流水（一话一行，面板显示累计）
│  ├─ talks.json          # 台词池（桌宠 / 面板 / SSP 共用）
│  ├─ today.json          # 生成的今日快照（给外部脚本吃）
│  ├─ bgm.json            # Bangumi 账号 / token / 代理（可选，含明文 token，别外传）
│  ├─ season/             # 本季放送表缓存（<季度>.json，12 小时后自动重拉）
│  ├─ settings.json       # 时间制式、桌宠尺寸等偏好
│  └─ state.json          # 桌宠位置、层级、上次启动日、已提醒记录
├─ test/
│  ├─ today.test.mjs      # 时间换算 / 落后判定 / 空 weekday
│  ├─ library.test.mjs    # 写库时间戳 / 备份滚动 / 撤销栈上限 / 恢复白名单
│  ├─ server.test.mjs     # 起真服务打接口：坏 JSON、404 契约、越权、单实例
│  ├─ atomic.test.mjs     # 原子写（并发、临时文件清理、坏文件报错）
│  ├─ time.test.mjs       # 时刻解析边界（25:30 / 28:59 / abc）
│  ├─ season-cache.test.mjs # 缓存清理只删「两个基准都够不到」的季度
│  ├─ bgm.test.mjs        # Bangumi 合并规则 / chunked 解析
│  ├─ season.test.mjs     # 本季表合并 / track_from / 星期补全 / 去重
│  └─ yaya.test.mjs       # 字典转义 / 静态检查 / allShows 合并
├─ pet/
│  ├─ Pet.cs              # 桌宠源码（WPF，单文件）
│  ├─ Pet.exe             # 编译产物（系统自带 csc 编的）
│  └─ pet.log             # 运行日志（出错先看这个）
├─ panel/
│  ├─ index.html          # 网页面板骨架（无构建、经典脚本）
│  ├─ style.css           # 样式（深/亮两套主题变量）
│  └─ app.js              # 全部前端逻辑（<script src> 引入，不用 module —— file:// 下 module 会被 CORS 拦死）
├─ docs/
│  ├─ AUDIT-round4.md     # 第四轮全项目审查（P0/P1/P2 + 复现命令）
│  ├─ PLAN-v0.26.md       # v0.26 的四个批次与验收门
│  ├─ CHANGELOG.md        # 完整变更记录（v0.1 起）
│  └─ archive/            # 历史 PLAN（v0.4–v0.9）与旧审查，只留档
├─ ghost/master/
│  ├─ descript.txt        # SSP 人格描述
│  ├─ words.txt           # 生成的台词事件（里々 兼容）
│  └─ today.txt           # 生成的今日数据（键=值）
├─ ghost-yaya/master/
│  ├─ yaya.txt            # YAYA 配置（dic / charset）
│  ├─ basis.dic           # 生成的台词事件（YAYA 写法，含 OnSecondChange 到点提醒）
│  └─ today.json          # 生成的整周排片表（含 all_shows）
├─ shell/
│  ├─ master/             # 当前生效的立绘（surface0-5.png + talk.png）
│  └─ tiara2/             # 备用立绘组（switch_shell 可切）
├─ tools/
│  ├─ build_today.mjs     # library.json → today.txt / today.json
│  ├─ build_ghost.mjs     # talks.json + today → ghost/master/words.txt
│  ├─ build_yaya.mjs      # talks.json + today → ghost-yaya/master/basis.dic
│  ├─ pack_ssp.mjs        # 打 SSP 包（--yaya 出 YAYA 版）
│  ├─ build_pet.mjs       # Pet.cs → Pet.exe（用系统自带 csc）
│  ├─ sync_bangumi.mjs    # Bangumi 放送表 / 收藏 → library.json
│  ├─ doctor.mjs          # 一键自检
│  ├─ ci.mjs              # 提交前总检：语法 + 单测 + 文档版本 + 面板拆分 + today 新鲜度
│  ├─ sync_docs.mjs       # 把 CHANGELOG 里的版本/日期写回 README（--check 供 CI）
│  ├─ check_panel_ui.mjs  # 面板无头冒烟（Edge/Chrome CDP）
│  ├─ test_drag.ps1       # 拖动回归脚本（模拟按下—移动—松开）
│  ├─ import_shell.mjs    # 外部立绘素材 → shell/<名字>/
│  ├─ switch_shell.mjs    # 在两套立绘之间切换
│  ├─ build_shell.mjs     # ComfyUI 原图 → 384x576 透明 PNG
│  ├─ comfy_gen.mjs       # 调本地 ComfyUI 生成底图
│  ├─ comfy_basori.mjs    # 带 LoRA 的角色生成（预设风格组）
│  ├─ comfy_faces.mjs     # img2img 做表情差分
│  ├─ comfy_face_edit.mjs # 只改脸（裁脸 → img2img → 贴回）
│  ├─ ImageTool.cs/.exe   # 图像工具（去底、缩放、贴回）
│  ├─ probe_bangumi.mjs   # Bangumi API 探针（一次性，可选）
│  └─ bgm-proxy-worker.js # Cloudflare Worker 代理（可选，给探针用）
├─ cache/                 # 生成中间产物（可以整个删掉）；panel_port.txt 记实际端口
└─ .gitignore             # 忽略 cache/、pet/bin|obj、*.log、state.json、today.txt 等
```

## 5. 番组库：`data/library.json`

### 5.1 最小可用示例

> 下面是字段示例。源码和便携版附空番库，可以从网页手动添加，也可以同步 Bangumi。

```json
{
  "version": 1,
  "user": { "name": "yourname", "nickname_for_pet": "会長" },
  "watching": [
    {
      "id": 400602,
      "name_cn": "药屋少女的呢喃 第二季",
      "name": "藥屋少女的呢喃 第二季",
      "eps": 24,
      "ep_status": 18,
      "air_weekday": 5,
      "air_time_cst": "23:00",
      "priority": "必追",
      "rate": 8,
      "last_watched": "2026-11-04",
      "comment": "看到第 18 话"
    }
  ],
  "weekday": {
    "5": [{ "id": 400602, "name_cn": "药屋少女的呢喃 第二季", "time_cst": "23:00", "ep_expected": 19 }]
  },
  "trivia": { "quote_of_today": "追番不是任务，是给明天留个期待。" }
}
```

### 5.2 字段表（`watching[]`）

> `user.nickname_for_pet` 就是「她怎么叫你」：台词里写 `{nickname}`，渲染时替换成这个值，默认 `会長`。面板底栏「账号」里能直接改（最多 12 字、不能带花括号、会自动压平换行与多余空格）；生气时那句「不届き者」是固定说法，不跟着改。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | number | ✅ | 唯一 ID（Bangumi 的话就是 subject id） |
| `name_cn` | string | 建议 | 显示名；缺了退回 `name`，再缺退回 `id` |
| `name` | string | – | 原名 / 日文名 |
| `eps` | number | ✅ | **总集数**（不是已看集数） |
| `ep_status` | number | ✅ | **已看到第几话** |
| `air_weekday` | 1–7 | – | 1=周一 … 7=周日；`null` 表示不定期 / 已完结 |
| `air_time_cst` | `"HH:MM"` | – | **北京时间**。支持 `"25:30"` 这种跨日写法（落在次日） |
| `priority` | string | – | 「必追」「在追」「补完」之类，纯展示 |
| `rate` | number | – | 你的评分，纯展示 |
| `start_date` | `"YYYY-MM-DD"` | – | 首播日；没写 `ep_expected` 时用它 + 周更推算期望集数 |
| `last_watched` | `"YYYY-MM-DD"` | – | 面板点 `+` 会自动更新 |
| `comment` | string | – | 自由备注 |

### 5.3 字段表（`weekday."1"` … `weekday."7"`）

| 字段 | 说明 |
| --- | --- |
| `id` | 和 `watching[].id` 对应（用来算落后、找已看集数） |
| `name_cn` | **要和 watching 里的一致**，否则同一部番会被显示成两个名字 |
| `time_cst` | 北京时间 `"HH:MM"` |
| `ep_expected` | 这一天应该播到第几话（手工维护，最可靠） |
| `next_day_note` | 注释字段，比如「JST 深夜档，CST 已跨日」，不参与计算 |

`ep_expected` 是「截至这一周应该看到的集数」。如果本周的播出日**还没到**（比如今天周三、番在周五），系统会自动减一话再比，所以不会因为你「提前欠一话」被冤枉；播出日一过，差一话就立刻出现在「落后」里。

### 5.4 三个容易踩的坑

1. **`eps` 是总集数，不是已看集数**。写反了落后计算会全乱。
2. `air_weekday` 用**数字 1–7**，不是 `"周一"`。
3. 深夜档（日本 25:30）换算成北京时间是**次日凌晨**：要么在**前一天**写 `"25:30"`，要么在**后一天**写 `"01:30"`——两种都支持，别同一部番两头都写。

### 5.5 从 Bangumi 同步（可选，不联网也能用）

家里那台机器上 `bgm.tv` 是通的，就让它自己查放送表，别手抄了。

```bash
# 拉一次：放送日历 + 你的「在看」收藏，合并进 data/library.json
node tools/sync_bangumi.mjs --user 你的bgm用户名

# 走代理（本机 7890 之类的 HTTP 代理，SOCKS5 也认）
node tools/sync_bangumi.mjs --proxy http://127.0.0.1:7890

# 只看会改什么，不落盘
node tools/sync_bangumi.mjs --dry-run

# 连不上网时用自带样本验证逻辑（不碰真实数据也能跑）
node tools/sync_bangumi.mjs --fixture tools/fixtures --dry-run

# 把整季放送表都写进星期表（默认只补「自己在追」的那几部）
node tools/sync_bangumi.mjs --weekday-all
```

合并规则（`lib/bgm.mjs` 的 `mergeLibrary`，纯函数、有单测）：

- **本地字段永远是老大**：`ep_status`、`priority`、`comment`、`rate`、`nickname_for_pet` 都不会被线上覆盖；只有加 `--take-progress` 才跟着 Bangumi 的看到第几话走。
- 线上的新番会自动进 `watching`（默认 `ep_status: 0`），只出现在放送表里的条目会把 `air_weekday`/`air_time_cst` 补上。
- **星期表会自动补全**：`--weekday watching`（默认）把「在追 + 收藏」的番按星期写进 `weekday`，`--weekday all` 把 Bangumi 当季放送表整季写进去（已存在的不重复插）。这样「今天有什么」不再依赖手抄。
- 写盘前留一份 `data/library.json.bak`，写完全自动 `build_today.mjs` + `build_ghost.mjs`。

先在底栏打开「Bangumi 账号」，填写 Access Token 和可选的 HTTP 代理，点「测试连接」。用户名可留空，由令牌识别。页面分别报告公开日历和收藏的连接状态。令牌和代理凭据存放在本机配置中，设置页面只显示脱敏状态。

在网页顶栏或桌宠右键打开同步预览，可选只同步公开日历、同步在看收藏并保留本地进度，或同时导入线上进度。确认会写入预览中的同一批改动。期间若番库或账号发生变化，需要重新预览。

本机实测（2026-11-04，开了本地代理）：`fetchCalendar` 经 `http://127.0.0.1:7890` 约 0.5 秒拿回 7 天 / 114 部；`--dry-run` 不落盘；`--weekday-all` 把 119 条写进星期表。收藏列表需要 token（`data/bgm.json`），没有就只同步放送表。

网页和桌宠的「我的排片」都按北京时间显示原播周档，本季表和番剧详情也会标注。已有原播时刻的在追番剧会自动出现在周表里。桌宠提醒按实际排期触发，可在详情里采纳原播时刻或自订。 [bangumi-data 排期说明](https://github.com/bangumi-data/bangumi-data/blob/master/CONTRIBUTING.md#关于broadcast字段)

**今日清单只放自己在追的**：`weekday` 里那些「本季放送表」条目不会挤进今日清单，而是收在面板「本季同档 N 部」的折叠区里（`lib/today.mjs` 把这两拨分成 `today` 与 `side`）。想把谁追起来，把它加进 `watching` 就行。


### 5.6 时间显示制式：30 小时制 / 24 小时制

深夜档有两种写法，两种都有人用，所以做成可切换的：

| 制式 | 01:00 的档显示成 | 适用 |
| --- | --- | --- |
| **30 小时制（默认）** | 前一天 **25:00** | 跟日本番组表、大多数番剧站的写法一致，凌晨的档不会跟当天夜里混在一起 |
| 24 小时制 | **01:00** | 看着更直白，适合只想知道「几点」的时候 |

- 面板顶栏的 `30h / 24h` 控制原播周档和提醒的时间显示。偏好存进 `data/settings.json`，面板、桌宠和 `today.txt` 共用此设置。也可通过 `POST /api/settings {"clock":"24h"}` 切换。
- 换算规则在 `lib/today.mjs` 的 `displayClock()`：**05:00 之前**算前一天深夜，时间 +24、星期回退一天（周一凌晨 → 周日 25:00）。星期一减一天会绕回周日，这处单独处理过。
- 桌宠弹窗打开时读取原播周档，保持打开时每分钟刷新。30 小时制只改变时刻和星期的显示，提醒仍按实际时间触发。
- 生数据不动：`library.json` 和 `*_time` 永远是北京时间 24 小时制原样，只有 `*_time_disp` / `*_wd_disp` 是换算后的显示值，所以切回 24 小时制不会有信息损失。

## 6. 数据契约：`ghost/master/today.txt`

这是给桌宠和 SSP 人格吃的「今日快照」，由 `tools/build_today.mjs` 生成，**不要手改**（每次重算都会覆盖）。

```
generated_at=2026-11-03T20:00:29.573Z   # 生成时间（UTC）
date=2026-11-04                          # 数据日期（北京时间）
weekday=3                                # 1-7
weekday_cn=周三
now_hhmm=04:00
time_of_day=lateNight                    # morning/noon/afternoon/evening/lateNight…
user=yourname
nickname=主人
count=0                                  # 今天有几部
has_today=0
clock=30h                                # 时间显示制式，24h / 30h
behind_count=0                           # 有几部落后
catchup_count=0                          # 有几部待补
summary=周三没有要追的番。主人，要不要去补番？
quote=追番不是任务，是给明天留个期待。
next_name= / next_time=                  # 下一部（还没播的），next_time 已经是制式换算后的写法
last_name= / last_time=                  # 最近一部（已经播的）
remind_count=0
w1_count=1 / w1_1_name=… / w1_1_time=… / w1_1_time_disp=… / w1_1_wd_disp=…   # 每周排片，w1…w7
show1_id= / show1_name= / show1_time= / show1_time_disp= / show1_unix= / show1_aired= / show1_eps= / show1_behind= / show1_priority=
```

- `show{n}_unix`：这一部的开播 unix 时间戳，桌宠的到点提醒就靠它。
- `show{n}_aired`：0/1，是否已经过了播出时间。
- `*_time` 永远是北京时间原样；`*_time_disp` 是按当前制式换算后的显示值（30 小时制下 01:00 → `25:00`，`*_wd_disp` 跟着回退一天）。界面优先用 `_disp`。
- 同时会写一份 `data/today.json`（同样的内容，JSON 形态），方便写别的脚本时直接 `JSON.parse`。

## 7. 桌面版：`pet/Pet.exe`

### 7.1 长得什么样、怎么摸

| 你的动作 | 她的反应 |
| --- | --- |
| 拖动 | 跟着走，松手记位置（`data/state.json`） |
| **点头顶** | 摸头台词（`nade` 池，按今天第几次递进；`faces.json` 里配了 `head` 区域就按区域判，没配退回「上部 26% 算头」） |
| **点脸** | `poke` 台词（`face` 区域） |
| 点身体其他地方 | `click` 台词 |
| 双击 | `doubleclick` 台词（抱一下，顺带弹「再抱一下 / 够了」） |
| 右键 | 查看排片、打开网页、记一话和撤销放在第一层。互动、设置和排错各有自己的子菜单。 |
| 在立绘上滚滚轮 | 立绘缩放 ±5%（跟菜单「尺寸」同一条路径，写回 `settings.json`） |
| 不管她 | 安静 90 秒以上自己说一句 `random`；5 分钟没人碰会说一句 `idleLong`（同一句至少隔 15 分钟）；23 点后换成 `goodnight`，一天一次 |
| 开播那一刻 | 「XX 开播了」，跳一下（`remind`） |
| 跨过零点 | 自己重算今日数据（`midnight`） |
| 右键 → 桌宠设置 → 桌宠尺寸 | 70% / 85% / 100% / 125% / 150%，立绘和窗口一起缩放，位置以窗口底部中点为准，记进 `data/settings.json` 的 `pet_scale`（和面板底栏「尺寸」共用） |

气泡：**点正文可跳过打字动画**。台词显示完整后停留 6–20 秒，带选择按钮的对话停留 25 秒。鼠标悬停或键盘焦点在气泡里时暂停自动收起，可用 × 或 Esc 关闭。长台词可滚动，系统关闭界面动画时直接显示整句。

气泡采用暖白纸面和浅阴影。正文与选择按钮各占一行，窄尺寸时按钮可换行。气泡宽度最多为窗口的 86% 且不超过 410 DIP，字号随桌宠尺寸在限定范围内变化。

气泡以窗口宽度 56% 为锚点。整句先参与布局，打字时宽度和高度保持稳定。

**位置**按屏幕剩余空间选择。

1. 放得下 → 窗口**向上长**，立绘屏幕位置不动（`Top = bottom - Height`）；
2. 上方不够、下方够 → 气泡翻到下方（尾巴自动翻到上边指着她），窗口顶边不动，立绘照样不动；
3. 上下都不够（例如 200% 尺寸下立绘已占掉大半屏）→ **叠在立绘上方**：窗口不再长高，气泡压在头发上方那一点空间里。

三级降级都不会让立绘位移，也不会让气泡跑出屏幕。日志里对应 `bubble below (roomAbove=… band=…)` 与 `bubble overlay band=…`。

说话时按正文和按钮的实际高度调整窗口。气泡在上时保持立绘下沿位置，在下时保持立绘上沿位置。气泡外的透明区域仍可点击穿透。

**选择肢是圆角小胶囊**（`同步吧` / `等会儿`），悬停会变成暖色。以前它们是 WPF 默认按钮，按钮挂上去之后窗口没重新量高度，最后一行会落在窗口外——点了没反应，看起来就是「卡住」；现在挂完按钮会再 `Measure` 一次并把停留时间延长到 20 秒。

桌宠里的「番组表」也是表格，不是一段话：`今天 N 部` → 一部一行；今天没番就直接进「接下来」三天——每天一条天头（`明天 / 周五 …`，右边是这个数字），下面一部一行，超过 5 部折叠成「还有 N 部，在网页面板里看全表」；最后是 `待补完` 和 `今日一句`。没写开播时刻的番时间列显示 `—`，不摆一排 `--:--`。

**每一行都能点**：鼠标移上去整行变暖色、行尾 `＋` 变红，点一下就给那部记一话（走本地面板服务写库，写完自己刷新）。托盘菜单里也有「记一话」，今天有番时列前 8 部——这样不用开浏览器也能记账。服务没起时她会直说「网页服务没开，我改不了库」，不会假装记上了。

**这里只列你自己在追的番**：放送表里那些「还没加的」不会跑进桌宠——想看全季就去面板的「本周 / 本季」页。

### 7.2 那些看不见的机制

- **窗口**：无边框、透明、置顶、不进任务栏；立绘默认 560px 高，按 DPI 缩放，可右键或面板底栏改 70%–200%（`data/settings.json` 的 `pet_scale` 是唯一入口，`state.json` 只兜底；脚本里用环境变量 `PET_SCALE=1.25` 可临时预览，不写回文件）。
- **窗口层级三档**：右键 → 桌宠设置 → 窗口层级 → 置顶 / 普通 / 沉底（`SetWindowPos` 改 `HWND_TOPMOST` 或 `HWND_BOTTOM`），选择记进 `state.json`。
- **拖动为什么不卡**：用 `GetCursorPos` 的屏幕坐标算位移，不再读「正在移动的窗口」的坐标系（那会把位移自己抵消掉，表现为拖两下才动一下）。
- **点击穿透**：用立绘的 alpha 通道生成命中测试，透明区域不吃鼠标（点空处能点到底下的窗口）。
- **到点提醒**：20 秒扫一次 `today.txt` 的 `show{n}_unix`，平时只在 `[开播, 开播+90s]` 内说一次；**刚启动的头两分钟**窗口放宽到 6 小时，把关机期间错过的补上。已提醒的键写进 `state.json` 的 `reminded` 数组，重启不重复。
- **跨日重算**：每分钟比对 `date` 和系统日期，不一致就调 `node tools/build_today.mjs`，再重新加载。
- **自动同步**：启动时起一个后台线程，`cache/bgm/calendar.json` 超过 12 小时才跑 `tools/sync_bangumi.mjs`；失败只写日志，不打扰你。
- **托盘**：`NotifyIcon` 常驻右下角，图标取 `surface0.png` 缩成 32px；隐藏后能从托盘叫回来，退出走托盘菜单。
- **开机自启**：`HKCU\Software\Microsoft\Windows\CurrentVersion\Run\TiaraPet`，写的是当前 exe 的绝对路径，取消勾选就删值。
- **重算失败会说话**：「重算失败了，看 pet.log。」——不静默失败。
- **立绘缓存**：每个表情只解码一次，换表情不再读盘。
- **分层立绘 + 分区命中**：`shell/master/faces.json` 声明画布、区域（`head` / `face` / `body`）和每个表情的图层（`base` + `overlay[]` + 会动的 `talk.png` 嘴），桌宠按 `Grid` 叠起来画。点哪儿由 `RegionAt()` 换算到画布坐标后判区域，所以「点头顶 = 摸头」「点脸 = 搭话」是几何判定，不是猜高度。
- **事件总线**：窗口里发生的每件事（每秒 / 跨分 / 跨刻 / 到点 / 点区域 / 托盘操作 / 回到前台）都 `Post()` 进队列，由 `Dispatch()` 分派给业务方法——与传统伪春菜的 `OnSecondChange` / `OnMouseClick*` 是同一套写法。三个定时器分工：50 ms 只管画面呼吸，1 s 派发秒/分/刻，60 s 轮到点提醒与跨日。
- **用户态变量**：好感、今天摸了几次、点脸次数写在 `state.json` 的 `vars` 里，跨日自动清零（`affinity` 不清）；台词里写 `{nade_today}` / `{affinity}` 会替换成实际值。
- **规则优先于随机**：`data/talks.json` 的 `rules[]` 里每条有 `when`（`hour_min` / `hour_max` / `weekday[]` / `behind_min` / `count_min` / `nade_min` / `affinity_min` / `mood`）和 `text` / `face`，命中就优先说，同一条 15 分钟内不重复。
- **整点与生日**：跨整点说一句 `hourly`（凌晨 1–7 点静音）；`data/settings.json` 写 `"birthday": "11-05"` 那天会先说一句 `birthday`。
- **选择肢**：`SayWithChoices()` 会在气泡下面列出按钮，点了执行对应动作再收起——提醒到开播时就是「记一话 / 在看」两个按钮。
- **右键菜单**在打开时重建。「记一话」直接读在追列表，把今日提醒对应的番剧放在前面，每行显示当前进度，写入仍走 `/api/progress`。桌宠菜单用 WPF 控件模板，高对比度模式使用 Windows 默认样式。托盘菜单打开时也会刷新进度。
- **菜单文案也是数据**：所有标题取自 `data/talks.json` 的 `menu` 对象（`header` / `header_count` / `cases` / `biz` / `advanced` …），改台词不用动 C#；缺键时用代码里的中文兜底。
- **三条人设变量线**：`imagination`（妄想）、`fluster`（慌张）、`nosebleed_total`（鼻血次数）跟 `affinity` 一起存在 `state.json` 的 `vars` 里。摸头/点脸会同时抬两条线（点脸抬得更快，22 点–3 点还额外加成），每分钟衰减一次（`imagination -1`、`fluster -4`，不低于 0）。
- **派生心情 `mood`**：`fluster ≥ 40` → `flustered`，`imagination ≥ 60` → `dreamy`，否则 `calm`。它**不落盘**，每次现算——所以规则里的 `"mood": "flustered"` 永远和当前状态一致（早先那版读 `vars.mood` 这个永远空着的键，是个不会命中的坑，已改）。
- **鼻血是阈值事件不是因为某一次点击**：`imagination ≥ 60 且 fluster ≥ 40`，且距上次 ≥ 10 分钟，就各扣 30、`nosebleed_total + 1`，说一句 `nosebleed` 池的话（表情 `surprise`）。所以连着摸十几下会「积攒」到某个点才发作，不是每下都喷。
- **记一话的三档反馈**：`bump`（普通记一话）→ `bumpRapid`（60 秒内连记 ≥3 次，语气变成「手速倒是很快」）→ `catchupFull`（记到 `已看 = 总话数`，改成「全部处理完毕」）。走 `AfterBump()`，面板和桌宠同一个后端写入口。
- **静置 20 分钟会说一句**（`idleLong`），打开菜单/番组表也有各自的话（`menuOpen` / `openPanel`，都带节流，不会每次点都念）。
- **双击是「抱一下」不是「点两下烦人」**：走 `HugSay()`——好感 +3（摸头只 +1）、妄想 +3 / 慌张 +2，然后弹两个选择肢「再抱一下 / 够了」。每抱到第 3 次会来一次**早とちり**：先说一句想歪的话（`misreadGuess`），2.2 秒后自己纠正（`misreadFix`）。
- **「被夸 / 被看着」也有软回应**：`praise` / `soft` / `worry` / `goodnight` 四个池，配合 `hug_total` / `affinity` 占位符；`MisreadHint()` 给「不是那样 / ……算是吧」两个选项，选后者会小声承认并涨一点慌张——是「误会」不是「拒绝」。
- **有副作用的动作先问再做**：右键「同步 Bangumi」会先弹 `[同步吧] [等会儿]`（`askSync` 池），「撤销上一次记账」走 `/api/undo`，和面板共用一个撤销栈（最多 10 步）。
- **整点问候按时段分**：6–9 点 `morning`、12–14 点 `noon`、17–19 点 `evening`、22–3 点 `night`，各有专属语气；其它整点走 `hourly`，凌晨 1–7 点免打扰（生日例外）。
- **事件总线已扩到这个粒度**：`OnMenuOpen` / `OnOpenPanel` / `OnBumpRapid` / `OnCatchupFull` / `OnIdleLong` / `OnSyncDone` / `OnSyncFail`，都从 `Dispatch()` 分派——加新行为时不用再往 `OnSecondChange` 里堆 `if`。

### 7.3 日志

`pet/pet.log`，UTF-8，一行一件事。常见行：

```
today.txt vars=36 summary=周三没有要追的番。…     # 数据读到了
missing surface4 at …\surface4.png                # 这套立绘没有这个表情（会自动回退）
talks.json pools=16                               # 台词池加载成功
say face=4 ……主人，你昨晚又熬夜了吧。              # 说话（face 是请求的表情号）
SayBoot ok bubble=… win=…                         # 开屏说话完成
new day detected, rebuilding                      # 跨日自动重算
```

看不出来问题时先跑 `node tools/doctor.mjs`。

## 8. 网页面板：`panel/`

### 8.1 启动

```bat
打开番组表.bat
:: 或者
node server.mjs
node server.mjs --port 7790        :: 指定端口（同时允许多开）
node server.mjs --root D:\tiara-data   :: 数据目录换个地方（单测就是这么挂 fixture 的）
node server.mjs --port 7860 --no-portfile  :: 临时实例：只服务，不改写 cache/panel_port.txt
```

服务只监听 `127.0.0.1`，不联网。

**同一份数据只跑一个服务**：不带 `--port` 启动时，先探 `cache/panel_port.txt` 和 `7788–7799` 上有没有活着的 TIARA（`/api/health` 里带 `app: "tiara"`），有就直接打印地址退出，不会再多起一个。要刻意起第二份（换端口看不同的库）就加 `--port`。

**端口回退**：`--port` 给的那个端口被别的程序占了，会从它往后试最多 12 个，把真正在听的端口写进 `cache/panel_port.txt`。桌宠右键「打开网页面板」和 `打开番组表.bat` 都只认这个文件，所以 7788 被别人占着也不会打开错的页面。

服务端日志在 `cache/server.log`（每行都带 `2026-11-09 02:30:00+08:00` 这种 CST 时间戳，和面板显示对得上）。写库、重建、崩溃都会落在那里，面板「诊断」里能直接看到。

### 8.2 界面分区

整页是**深色 + 封面驱动**的宽布局（最大 1600px 居中，窄屏自动横向滚动 / 单列），有**本周 / 今天 / 本季 / 番库**四个页签。默认打开「本周」，选择记在浏览器里，也可用 `?tab=week` 直达。封面来自本季缓存 `data/season/<季度>.json` 的 `image` 字段，缺图时显示首字方块。

| 分区 | 内容 |
| --- | --- |
| 顶栏 | 标题、日期、`待看 N`（有落后才出现）、搜索框、`30h / 24h` 制式切换、`同步` |
| 页签栏 | 本周 / 今天 / 本季 / 番库（键盘 `1` `2` `3` `4`） |
| **本周** 页 | 七列周历板，一天一列：天头 `周X · 今天 · N 部`；一部一张卡（封面 + 时刻 + 名字 + 进度条 + 悬停出的 `−` `+` `×`）。今天那列带红色描边，**当前时间已过**的时刻标红 |
| **今天** 页 | 左：`今天放送` 宽行表（封面 / 时刻 / 番名 / 进度 / 操作）+ `接下来` 三天卡片；右：`在追 N`、`待补完`、`这周`（本周 / 累计 / 连续天 + 近 14 天柱图）、`TIARA说`、`今日一句` |
| **本季** 页 | 六列真表格 `勾选 / 封面 / 番名(+首播日·标签) / 话数 / 评分 / 状态·时刻`，按放送日分组；详见 8.3 |
| **番库** 页 | 查看暂停中和已归档的番剧，按番名搜索，打开详情或恢复到在追 |
| 底栏 | `备份与恢复`、`导出日历`、`导出周表`、`Bangumi 账号`、`桌宠称呼`、`提醒设置`、`诊断`、`桌宠尺寸`、`封面`和`主题` |

- `+` / `−` / `×` 直接改 `library.json` 并重算 `today.txt`，桌宠下一轮刷新就同步；每次改动都留 `data/library.json.bak`、`data/backups/`（滚动 5 份）和 `data/history.jsonl` 一条记录。
- **记一话是「先动手再汇报」**：点下去立刻改数字与进度条（只重画那一行，不整页重绘），260ms 内的连点合并成一次写；失败才 `refresh()` 回到服务端的真值。提示条上带「撤销」，走服务端 `data/undo`（最近 10 版）。
- 卡片上的进度分两种说法：**剩 N 话**是「总话数还有几话没看」，**落后 N 话**是「比按开播日算的进度少看了几话」——两个数不一样，别当成一个。
- 连点 `+` 不会丢：所有写库接口排同一个队列（`withWriteLock`），并发请求逐个落盘，不会出现「点五下只加一」。
- 键盘：**j/k**（或 ↓/↑）选番、**空格 / Enter** 记一话、**x** 移出在追、**u** 撤销、**1 / 2 / 3 / 4** 切页签、**/** 跳搜索框、**Esc** 关弹层。输入框里打字不会误触。
- 面板每 60 秒轮询一次 `/api/state`；服务断了保持旧画面而不是清空。
- 换制式 / 同步之后页面**就地重画**（不再卡在「正在读缓存」）：`/api/state` 每次都会带上 `images` 与最新周历，`/api/season` 会带 `source: net | cache`。
- 开播前 60 分钟内，面板不再弹气泡（避免和桌宠重复），改由桌宠说话 + 系统通知。

点击在追的番名打开详情，选择「暂停追番」可退出排片、待看和开播提醒。打开「番库 → 暂停中」继续追番，原进度和排期会恢复。总集数已知且全部看完后，详情里会出现「归档已看完」。在「番库 → 已归档」可以查看原来的详情，也可以恢复到在追。

加入番库时可以从头补、填写已看到第几话，或从最新一话开始。跳过的集数不会算进观看统计。撤销记账会同步冲销这笔统计。「备份与恢复」可以预览进度、状态和排期的变化，再选整库或单番恢复。

详情中的「调档与提醒」可以跳过下一档、设置一次新的开播时刻、停止排片或静音此番。停止排片的番剧还能记进度和补完。Windows 桌宠支持跨午夜的免打扰时段和「15 分钟后提醒」。

### 8.3 本季番剧表（选番入口）

「本季」页签是**首次入库**的地方：一次拉回当季全部新番，勾选后写进 `watching[]`。

| 控件 | 作用 |
| --- | --- |
| 季度下拉 | 2026Q4 / 2026Q3 …（默认当前季度；过去几季也能拉，用来补旧番） |
| `刷新` | 强制走网络；平时先用 `data/season/<季度>.json`（12 小时内算新鲜） |
| `只看 TV` | 默认开；关掉会连 OVA / 剧场版 / 网络动画一起列 |
| `隐藏已在追` | 默认关；勾上后已在 `watching[]` 里的不再出现 |
| 排序 | 按放送日 / 按评分 / 按名字 |
| 行内搜索 | 顶栏搜索框同一套（中文名、原名、优先级、标签都能搜） |
| `全选` / `清空` | 只作用于**当前筛选结果**，不是整季 167 部 |
| `加入在追` | 把勾选的写进库，带 `track_from`（只影响「第几话该到了」） |

- 每行显示：封面、中文名、`首播日 · 年份月份 · 标签 · 平台`、话数、Bangumi 评分；放送星期来自条目 infobox（按 `放送日` 排序时用分组行标出）。
- 在追条目有星期时可行内改时刻。星期未知时先打开详情补齐，批量调整会跳过暂停、归档及缺少星期的条目。
- 加进来的番如果拿不到时刻，不会被算成「今天要播」，只会进「本季同档」——这是刻意的，宁可少提醒，不要半夜乱叫。
- 缓存文件 `data/season/<季度>.json` 可以直接删，删了下次自动重拉。

### 8.4 HTTP API

所有接口都返回 JSON。**成功**是 `{"ok":true, ...}`；**失败**是 4xx/5xx + `{"ok":false, "error":"给人看的一句话"}`——前端只认 `ok` 与 `error` 两个字段，不看 HTTP 状态码猜。写接口另外校验 `Origin`：非本机的跨站请求一律 403。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 番库、提醒与面板状态。`weekly` 是固定周表，`week` 包含临时调档，`server` 带版本和进程信息。 |
| GET | `/api/schedule/original` | 按条目 ID 返回北京时间的原播星期和时刻。传 `?q=2026Q4` 时读取指定季度。 |
| GET | `/api/schedule/desktop` | 桌宠在追周表，包含当前时制、已换算的星期和时刻、排期来源与观看进度。 |
| POST | `/api/watch/lifecycle` | `{id,action,expected_revision?}`，操作为 `pause`、`resume` 或 `archive` |
| GET | `/api/health` | `{ok, app:"tiara", version, pid, port}`，给启动脚本、桌宠、单实例检查探活 |
| GET | `/api/version` | `{ok, app, version, pid, started, port, today_txt, files}`：版本 + 关键文件 mtime（判断有没有重启到新代码）。**不回绝对路径** |
| GET | `/api/settings` | `{ok, clock, pet_scale}`：时间制式与桌宠大小 |
| GET | `/api/history` | `{ok, total, gained, recent[], byShow[]}`，来自 `data/history.jsonl` |
| GET | `/api/backups` | `{ok, backups:[{name,size,mtime,fixed}]}`：`library.json.bak` + `data/backups/*`（滚动 5 份，文件名是 CST） |
| GET | `/api/season` | 本季番剧表：`?q=2026Q4&net=1`（`net=1` 强制走网络），返回 `{ok,q,total,items[],source,cache_at}` |
| GET | `/api/token` | 读 `data/bgm.json`（token 打码后返回） |
| GET | `/api/export` | `?fmt=ics` 导出日历、`?fmt=md` 导出周表 Markdown |
| GET | `/api/stats` | 追番统计：`{ok, streak, week, total, days, finished, byDay[], byShow[]}` |
| GET | `/api/logs` | 最近若干行服务日志（面板「诊断」用） |
| POST | `/api/token/test` | 验证公开日历、账号身份和收藏访问，返回各来源状态 |
| POST | `/api/sync` | 用 `{dry_run:true,mode}` 预览，用 `{preview_id}` 确认同一批变更 |
| GET | `/api/season/airing?q=2026Q4` | 该季分钟级预计时刻和来源 |
| POST | `/api/watch/schedule` | 跳过、改期、停止或恢复排片、单番静音 |
| POST | `/api/progress` | `{"id":400602,"delta":1}` 或 `{"id":400602,"set":18}` → 写库并重算。`delta`/`set` 不是数字就 400；结果夹在 `0…eps`；返回 `{ok,id,prev,ep_status,eps,changed,rebuilt}` |
| POST | `/api/watch` | `{"id":975,"action":"add"}` / `{"id":975,"action":"remove"}`：名字/星期/话数从星期表或本季缓存继承（`eps` 不再写 null） |
| POST | `/api/undo` | 退一步（`data/undo/` 最近 10 版）；没有快照时 409 |
| POST | `/api/restore` | `{"name":"library.json.bak"}` → 校验后换回备份并重算；文件名走白名单（`../` 之类一律 404，并把可用备份列在 `backups` 里） |
| POST | `/api/settings` | `{"clock":"24h"}` / `{"pet_scale":1.25}` → 存进 `data/settings.json` 并重算 |
| POST | `/api/nickname` | `{"nickname":"YG"}` → 她怎么叫你（写进 `library.json` 的 `user`，桌宠/SSP 同步生效） |
| GET | `/api/say` | `?pool=bump` 取一句台词（调试用：不启动桌宠也能看台词池现在说什么） |
| POST | `/api/token` | `{"user":"…","token":"…","proxy":"http://127.0.0.1:7890"}` → 写 `data/bgm.json`（代理支持 `http://user:pass@host:port`） |
| POST | `/api/season/apply` | `{"q":"2026Q4","add":["622288"]}` → 加进 `watching[]`，带 `track_from`。**`q` 必填**：没有它就只能拿「当前季」猜名字，猜错会写进一条三页都看不见的脏条目。返回 `{ok,q,added,changes,detail,missing}` |
| POST | `/api/season/subject` | `{"id":622288}` → 拉单部详情补放送星期（写回缓存） |
| POST | `/api/season/time` | `{"id":622288,"time":"23:30"}` → 补时刻（只改你自己的库）；`""` 表示清空 |
| POST | `/api/season/time-batch` | `{"ids":["622288"],"time":"23:30"}` → 批量补时刻；返回 `{ok,count,changed:[],missing:[],time_cst}` |
| GET | `/sprite/<file>.png` | 立绘（限定在 `shell/master/` 内，挡目录穿越） |
| GET | `/cover/<id>.jpg` | 封面缓存（`data/covers/`，限定 1–10 位数字 id） |

时刻只认一种写法：`23:30`、`9:05`（会规范成 `09:05`）、`25:30`（30 小时制，次日 01:30 算），上限 `28:59`；`abc`、`24:60`、`29:00` 一律 400。这条规则在 `lib/time.mjs` 里，单条与批量接口共用同一个函数。

> 已删掉的接口：`GET /api/reload`。它以前不看方法也不看来源，任意一个 `<img src>` 就能让服务端连起三个 node 进程；重算现在由写接口自己触发（连点会合并成一轮，见 §8.2）。

```bash
curl http://127.0.0.1:7788/api/health
curl -X POST http://127.0.0.1:7788/api/progress -H "Content-Type: application/json" -d "{\"id\":400602,\"delta\":1}"
curl "http://127.0.0.1:7788/api/season?q=2026Q4&net=1"
curl -o week.ics "http://127.0.0.1:7788/api/export?fmt=ics"
```

## 9. 立绘与表情

### 9.1 规格

- 目录：`shell/master/`
- 尺寸：**384 × 576** PNG（带 alpha），当前按 560px 高显示
- 文件：`surface0.png` … `surface5.png`，外加可选的 `talk.png`（打字口型帧）

| 表情名 | 文件 | 含义 |
| --- | --- | --- |
| `normal` | surface0 | 平静（默认） |
| `happy` | surface1 | 高兴 |
| `sad` | surface2 | 不高兴 / 低落 |
| `surprise` | surface3 | 惊讶 |
| `sleepy` | surface4 | 困 |
| `think` | surface5 | 思考 |

### 9.2 缺图怎么办（重要）

当前这套立绘只有 **4 张**（normal / happy / sad / surprise）。缺的会就近回退，而不是一律退成 `normal`：

- `sleepy` → `sad`
- `think` → `normal`

回退规则在 `pet/Pet.cs` 的 `FallbackFace()` 和面板的 `FACE_ALIAS` 里。要补真差分见下面的流程。

### 9.3 用 ComfyUI 补差分

```bash
# 1) 生成底图（需要本地 ComfyUI，默认 127.0.0.1:8188）
node tools/comfy_gen.mjs --name normal --prompt "1girl, ..." --seed 12345

# 2) 只改脸：裁出脸部 → img2img → 贴回原图（衣服/线条不动）——补差分优先用这个
node tools/comfy_face_edit.mjs --src cache/src/normal.png --box 240,300,480,400 --face sleepy --denoise 0.6

# 3) 整张 img2img（会动到衣服；denoise 0.4 也会换衣服，实测过，慎用）
node tools/comfy_faces.mjs --base shell/master/surface0.png --only sleepy --denoise 0.42

# 4) 变成 SSP 能用的 384x576 透明 PNG
node tools/build_shell.mjs --only sleepy

# 5) 也可以直接导入网上素材（带 --credit 会写 CREDITS.txt）
node tools/import_shell.mjs --from cache/net/xxx --to shell/xxx --map "normal=xxx1,happy=xxx10" --credit "…"

# 6) 多套立绘之间切换
node tools/switch_shell.mjs
```

> 换完立绘要**重启桌宠**（启动时只读一次图）；面板刷新一下就行。

## 10. SSP 伪春菜人格

`ghost/` + `shell/master/` 就是一份标准的 SSP 人格目录：

```
ghost/master/descript.txt   # 名字等
ghost/master/words.txt      # 事件 + 台词（里々 写法）
ghost/master/today.txt      # 数据快照
shell/master/               # 立绘
```

安装：把 `ghost/`、`shell/` 两个目录拷进 SSP 的对应位置（或解压打好的包），在 SSP 里选「TIARA」。

```bash
node tools/pack_ssp.mjs                # → dist/TIARA-ssp.zip（里々 版）
node tools/pack_ssp.mjs --yaya         # → dist/TIARA-yaya.zip（YAYA 版，能到点提醒）
node tools/pack_ssp.mjs --list         # 只看会打进去哪些文件
```

- 是 **zip** 不是 `.nar`：`.nar` 得装 NSIS + narc 才能做；SSP 同样认「zip 里带 `ghost/` 和 `shell/`」，解压到 SSP 根目录即可。
- **必须先有 SHIORI**：SSP 本体不带 SHIORI。里々 版把里々放进 `ghost/master/shiori/`（`shiori.dll` + `辞書.txt`）；YAYA 版放 `yaya.dll`。
- `today.txt` / `today.json` 是快照，改完番组库记得 `build_today` + `build_ghost`（+ `build_yaya`）再重开 SSP。

### 10.1 两个版本的区别

| | 里々 版 | YAYA 版 |
| --- | --- | --- |
| 脚本 | `ghost/master/words.txt` | `ghost-yaya/master/basis.dic` |
| 生成器 | `tools/build_ghost.mjs` | `tools/build_yaya.mjs` |
| 读文件 | 不能 | 能（`FREADJSON`） |
| 到点提醒 | 做不到，只能启动时念一次 | ✅ `OnSecondChange` 每 30 秒比对 |
| 台词来源 | `data/talks.json` | 同一份 `data/talks.json` |

`words.txt` / `basis.dic` 里现在有这些段：

| 事件 | 内容 |
| --- | --- |
| `＊OnFirstBoot` / `OnFirstBoot` | 初次启动 |
| `＊OnBoot` / `OnBoot` | 每次启动（随机一条问候 + 今日播报，几条轮换） |
| `＊自己紹介` / `自己紹介` | 自我介绍 |
| `＊OnNadeNade` / `OnNadeNade` | 摸头 |
| `＊OnMouseWheel` / `OnMouseWheel` | 滚轮 |
| `＊朝` / `＊昼` / `＊夜` | 时段问候（里々 里手动点也能测） |
| `＊OnClose` / `OnClose` | 关闭 |
| `＊OnMouseDoubleClick` / `OnMouseDoubleClick` | 双击 |
| `＊ランダム` | 日常随机（里々 会随机挑一句） |
| `＊積み` | 积压提醒，一部一条（名字和话数都写死，不依赖脚本） |
| `＊今日` / `＊つづき` | 今日播报 / 下一部（方便手动测） |
| `OnSecondChange` | 仅 YAYA 版：到点提醒 |

### 10.2 YAYA 版怎么做到点提醒

```
ghost-yaya/master/yaya.txt     # dic, basis.dic / charset, UTF-8
ghost-yaya/master/basis.dic    # 事件脚本（生成物，别手改）
ghost-yaya/master/today.json   # 整周排片表快照（data/today.json 的副本）
```

`OnSecondChange` 每 30 秒跑一次：读 `today.json` 里的 `all_shows`，挑出「今天、这个周几、时间刚过去 0–4 分钟」且没提醒过的番，念一句「XX 开播了。别装没看见。」然后把这个 key 记进 `yayaDone`，同一话不会念第二遍。

- `all_shows` 由 `lib/today.mjs` 的 `allShows()` 合并「在追列表」与「手写整周排片表」，按周几 + 时间排序、自动去重。
- `FREADJSON` 的路径相对 `yaya.dll`，所以包里的 `today.json` 必须和 `yaya.txt` 同目录（`ghost/master/`）。
- 缓存 10 分钟（`yayaAge > 600` 才重读），SSP 挂后台也不会一直读盘。

**限制**：`today.txt` / `today.json` 都是**生成那一刻**的快照。改了番组库要重跑生成脚本并让 SSP 重新加载人格（见第 11 节）。

### 10.3 和 SSP 共存（不是二选一）

桌宠和 SSP **可以同时开**，两边读的是同一份数据，互不写对方：

| | 桌宠 `pet/Pet.exe` | SSP 里的 TIARA |
| --- | --- | --- |
| 立绘 | `shell/master/` 的 6 个表情 + 分层叠加（`faces.json`） | 同一套 `surface0-5.png` |
| 数据 | 实时读 `today.txt`，`data/library.json` 一改就重算 | 读打包进去的 `today.txt` 快照，要重新生成 |
| 记账 | 能（点行 / 托盘「记一话」→ 本地面板服务） | 不能（SSP 侧只读） |
| 到点提醒 | ✅ 60 秒轮询 | 只有 YAYA 版有（`OnSecondChange`） |
| 启动 | 开机自启可勾 | 手动开 SSP |
| 主题外观 | 一个窗口，随 `faces.json` | SSP 的 balloon / shell 由 SSP 决定 |

共存时要注意三件小事：

1. **别让两边同时改数据**。改库统一在面板或托盘做，SSP 侧只念不写，就不会打架。
2. **重新生成再拾取**。改了番组库后跑 `node tools/build_today.mjs && node tools/build_ghost.mjs && node tools/build_yaya.mjs`，然后在 SSP 里「重新载入人格」；桌宠不用重启，它 4 秒轮询 `today.txt` 的 mtime。
3. **端口**。桌宠找面板服务时会从 `7788` 往上探到 `7799`，并读 `cache/panel_port.txt`；SSP 不碰端口，两边不会抢。

桌面版补不了的「传统味」——分层立绘、事件总线、分区判定、变量与规则——已经按传统伪春菜的写法补进桌宠了（见 §7.2）；**SSP 侧保留「能塞进里々/YAYA 的最小集」**，不做重型移植，这样两套壳都能用同一份人格数据。

## 11. 命令行手册

所有脚本零依赖，`node tools/<名字>.mjs` 直接跑。

| 命令 | 作用 | 常用参数 |
| --- | --- | --- |
| `node server.mjs` | 起面板服务（同一份数据只跑一个；已在跑就打印地址退出） | `--port 9000` 指定端口并允许多开、`--root D:\data` 换数据目录、`--no-portfile` 不改写端口指针文件 |
| `node tools/build_today.mjs` | 重算 `today.txt` / `today.json` | `--date 2026-11-06`（模拟某天）`--root`（算别的目录） |
| `node tools/build_ghost.mjs` | 重算 `words.txt`（里々 版） | `--date …` |
| `node tools/build_yaya.mjs` | 重算 `basis.dic` + `today.json`（YAYA 版） | `--check` 只做静态检查 |
| `node tools/pack_ssp.mjs` | 打 SSP 包 | `--yaya`（YAYA 版）`--out` `--list` |
| `node tools/build_pet.mjs` | 编译 `Pet.cs → Pet.exe` | – |
| `node tools/sync_bangumi.mjs` | 从 Bangumi 拉放送表 + 收藏 | `--user`（中途也认库里的 user.bgm_user）`--proxy http://127.0.0.1:7890` `--take-progress` `--dry-run` `--fixture tools/fixtures` `--weekday-all` |
| `node tools/season.mjs` | 命令行版本季表：列 / 勾 / 加入在追 | `--q 2026Q4` `--list` `--add 622288,665390` `--net` |
| `node tools/doctor.mjs` | 一键自检 | `-v` 显示全部通过项、`--json` |
| `node tools/ci.mjs` | 提交前总检：53 个 .mjs 语法 + 全部单测 + 文档版本 + 面板拆分完整性 + `today.txt` 新鲜度 | `--fast` 跳过单测 |
| `node tools/metrics.mjs` | 规模体检：在追 / 待看 / 缓存 / 备份 / 历史 / 代码行数 / 体积 | `--json` |
| `node tools/snapshot_daily.mjs` | 按日快照整份数据到 `data/backups/YYYY-MM-DD/`（面板启动时自动跑一次） | `--force` `--keep 14` `--dry-run` `--json` |
| `node tools/manifest.mjs` | 给 `dist/` 产物生成 / 校验 `manifest.json`（path / size / sha256） | `--check` `--dir` `--out` |
| `node tools/check_faces.mjs` | 校验 `shell/master/faces.json`（图层、尺寸、区域越界、别名） | `--json` |
| `node tools/clean_cache.mjs` | 清 `cache/`（浏览器临时 profile、旧截图） | `--dry-run` `--all` `--keep-audit-days 7` |
| `node tools/restore_library.mjs` | 从备份恢复番组库 | `--list` `--latest` `--name library-….json` `--check-only` |
| `node tools/pack_portable.mjs` | 打便携包 `dist/TIARA-portable-<版本>.zip` | `--no-pet`（不带桌宠）`--out` |
| `node tools/sync_docs.mjs` | 把 `package.json` 的版本号与 `docs/CHANGELOG.md` 里那一条的日期写进 README | `--check`（不一致就退出码 1） |
| `node tools/check_panel_ui.mjs` | 真浏览器点一遍面板（换制式 / 切页签 / 改尺寸 / 记一话 / 行内追番 / 提示条 / 键盘 / 主题 / 待看） | 需要 Edge |
| `node tools/fetch_runtime.mjs` | 把本机 `node.exe` 复制进 `runtime/`，让用户不必装 Node | `--from "C:\Program Files\nodejs\node.exe"` |
| `node tools/rename.mjs` | 全项目改名（默认 dry-run） | `--to TIARA` `--apply` |
| `node tools/switch_shell.mjs` | 列 / 切立绘组 | `node tools/switch_shell.mjs tiara2` |
| `node tools/import_shell.mjs` | 导入外部立绘 | `--from` `--to` `--map` `--crop` `--credit` |
| `node tools/build_shell.mjs` | ComfyUI 原图 → shell PNG | `--only happy` |
| `node tools/comfy_gen.mjs` | 本地 ComfyUI 生成 | `--name` `--prompt` `--seed` `--batch` |
| `node tools/comfy_basori.mjs` | 带 LoRA 的角色生成 | `--n` `--preset` `--faces` |
| `node tools/comfy_faces.mjs` | 整张 img2img 差分 | `--base` `--only` `--denoise` |
| `node tools/comfy_face_edit.mjs` | 只改脸 | `--src` `--box` `--face` `--denoise` |
| `node tools/probe_bangumi.mjs` | Bangumi API 探针（一次性） | `--user` `--subject` |

典型流：

```bash
# 改了 library.json 之后
node tools/build_today.mjs && node tools/build_ghost.mjs
# 改了 Pet.cs 之后
node tools/build_pet.mjs          # 提示「无法写入输出文件」= 先关掉桌宠
# 全部体检
node tools/doctor.mjs
# 提交前总检（语法 + 单测 + 文档版本 + 面板拆分）
node tools/ci.mjs
```

## 12. 自检与排错

### 12.1 两条命令

```bash
node tools/ci.mjs        # 提交前总检：语法 + 单测 + 文档版本 + 面板拆分 + today.txt 新鲜度
node tools/doctor.mjs    # 运行时体检：数据、立绘、端口、日志、缓存、SSP 产物
```

`ci.mjs` 是**代码层面**的门：全仓 `.mjs` 过一遍 `node --check`、`node --test` 全绿、`sync_docs --check` 一致、`panel/index.html` 引用的 `app.js`/`style.css` 都在且没有误用 `type="module"`、`today.txt` 不是隔夜的。`--fast` 跳过单测。

`doctor.mjs` 是**数据与运行环境**的门：Node 版本、关键文件、`library.json` 字段合法性与名字一致性、台词池、立绘张数与尺寸、`today.txt` 是不是今天、面板端口（含 7788–7799 实际端口）、桌宠最近有没有写日志、`data/state.json`（层级 / 提醒记录）、备份与历史、`data/bgm.json`（账号 / token / 代理）、`data/season/`（缓存份数与新鲜度）、YAYA 版人格（`basis.dic` 是否有 `OnSecondChange`、`all_shows` 条数）、单测文件、发布包是否过期。退出码 0 = 没有 error；加 `-v` 连 ok 项一起列。

面板的交互回归（换制式 / 切页签 / 改尺寸之后本季表会不会被打回骨架屏）用真浏览器跑：

```bash
node tools/check_panel_ui.mjs   # 需要 Edge，会自己起一个无头实例点几下
```

输出 `PASS` 才算过，过程图留在 `cache/audit/cdp_*.png`。

### 12.2 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 面板打开是 `404 panel` | 旧服务在跑（路由没更新）。`停止TIARA.bat` 后重开 |
| 端口 7788 被占 | 会从 7788 往后试最多 12 个，真正端口写在 `cache/panel_port.txt`；桌宠和 `打开番组表.bat` 都只认这个文件 |
| 任务管理器里有好几个 node | v0.26 起同一份数据只跑一个服务：不带 `--port` 启动会先探活，已在跑就打印地址退出。要刻意多开才加 `--port` |
| 桌宠白屏 / 只有气泡没图 | `shell/master/surface0.png` 缺失或尺寸不对，跑 `doctor` |
| 编译报 `CS0016 无法写入输出文件` | `Pet.exe` 正在运行，先退出桌宠再编译 |
| 面板点 `+` 没反应 | 服务没起（页面上会写「连不上本地服务」），或 `id` 不在 `watching` 里 |
| 桌宠不说话 | 看 `pet/pet.log`：`today.txt` 没生成 / `talks.json` 语法错 |
| 桌宠不见了 | 可能被「隐藏到托盘」了，点右下角托盘图标；托盘菜单里也有「显示 / 隐藏」 |
| 桌宠盖住别的窗口 | 右键 → 桌宠设置 → 窗口层级 → 普通 / 沉底 |
| 中文显示成乱码（命令行输出） | 是 PowerShell 控制台编码问题，文件本身是 UTF-8，不影响运行 |
| 提醒不响 | 平时只在「开播后 90 秒」内提醒；关机期间错过的会在**下次启动的两分钟内**补一次，补过就记进 `state.json` |
| 想撤回一次误点 | 提示条上的「撤销」（服务端留最近 10 版，`data/undo/`），或键盘 `u`；再不行用面板底部「恢复上一版」 |
| 记一话之后数字又弹回去 | 说明写库失败（看 `cache/server.log` 的 `[rebuild]`/写库行），面板会提示失败原因；成功时是「先改界面再写盘」，不会回跳 |
| 提示条一行只显示两个字 | 老版本 `.toast` 的状态类撞上了卡片的 `.show`；v0.15 起已改名 `is-up`，`check_panel_ui` 会量行数 |
| 本季表一直转圈 | 面板要先能上网（或配了代理）。`data/season/` 里已经有缓存时会先用缓存，`刷新` 才强制走网络 |
| 勾了「加入在追」但今天没出现 | 同步来的番通常没有时刻（「时刻未定」），只会进「本季同档」。在列表里点时刻那一格补上 `HH:MM` 就会进排片 |
| 想让某部番暂时退出提醒 | 从番剧详情暂停，或者用「调档与提醒」单番静音。暂停后可在番库继续追番 |

## 13. 已知限制与路线图

追番详情、暂停与归档、统计撤销、备份选择等工作见 [功能待办](BACKLOG.md)。

**现在的边界**

- 纯本地 + 按需联网：**不会**后台轮询 Bangumi；启动时若缓存超过 12 小时才自动同步一次，平时靠手点（命令行 / 面板 / 桌宠右键），且那台机器得能连上 `bgm.tv`。
- 提醒是「桌宠说一句 + 托盘气泡通知」，不响声音；程序完全没开时什么都不会发生（下次启动补提醒）。
- Bangumi 日历提供放送星期和首播日。分钟级时刻来自手填或独立排期源，地区平台可能晚于原播。例行排期可写成 `23:30` 或次日的 `25:30`（上限 28:59）。
- 面板要用 `http://127.0.0.1:<port>/` 打开。没有服务时桌宠会提示、面板会显示「读不到本地服务」加重试条——`file://` 下浏览器的同源策略挡掉 `fetch`，这是浏览器的规矩，不是 bug。
- 服务端是**单实例**的：不显式 `--port` 启动时，发现已经有一只在跑就直接打印地址退出。想并存两只，加 `--force-new`（端口自己顺延，`cache/panel_port.txt` 跟着最后一只走）。
- SSP 里：里々 版只能念生成时的快照；YAYA 版（§10.2）能到点提醒，但同样读的是快照，改了库要重新生成并重载人格。
- 立绘只有 4 个表情；`sleepy` / `think` 是回退的（`sleepy→sad`、`think→normal`）。
- 自动化测试覆盖写库、日程计算、发行包、撤销统计和 HTTP 接口。服务端测试使用临时库，部分用例运行真实的日程和人格生成脚本。

**接下来值得做的**（按性价比排序）

1. 扩充地区平台的实际更新时刻与停播公告覆盖率。
2. 真正的 `sleepy` / `think` 差分（用 `comfy_face_edit` 只改脸，别用整张 img2img）。
3. 本季表加上「按 Bangumi 标签 / 评分阈值」批量筛（现在只能搜索 + 排序）。
4. 气泡里的番名可点：点一下跳 Bangumi 条目页。
5. 把「待看队列」做成独立视图（现在只有落后话数与托盘里的「记一话」）。
6. YAYA 版再加「完结 / 新番开播」事件与 `OnChoiceSelect` 菜单。
7. `server.mjs` 按路由拆文件（现在 `lib/` 只抽出了写库、时刻、原子写、版本四项，路由仍在一个文件里）。
