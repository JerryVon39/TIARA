# 变更记录

版本号以 `package.json` 为准；每条的日期是**真实发版那天**（`tools/sync_docs.mjs` 会把它写回 README 顶部那条横幅）。
README 是面向普通用户的上手指南，完整历史在这里。

## [0.27.7] — 2026-11-10

- 重做桌宠排片弹窗，新增星期筛选和独立的「提醒与待补」页签。
- 番剧行显示原播时刻、来源和进度，使用独立的减一话、加一话按钮，保存后就地显示新进度。

## [0.27.6] — 2026-11-10

- 网页面板换成粉蓝配色，压缩「我的排片」标题区，浅色作为默认主题。
- 桌宠右键菜单把查看排片、打开网页、记一话和撤销放在第一层。
- README 改为上手指南，源码构建和数据契约迁到开发文档。

## [0.27.5] — 2026-11-10

- 桌宠弹窗新增在追原播周档，按与网页相同的时制和星期分组。提醒单独显示并按实际排期触发。

## [0.27.4] — 2026-11-10

- 原播周档跟随面板的 30 小时制切换。凌晨 05:00 前的番剧在 30 小时制下归入前一天。

## [0.27.3] — 2026-11-10

- 网页排期区分读取中、暂时读取失败和没有原播周档。后台服务版本较旧时提示退出后重新打开 TIARA。

## [0.27.2] — 2026-11-10

- 网页面板改为放送簿布局，重排导航、星期索引、排片卡片和手机端版式。
- 我的排片、本季和详情统一展示北京时间原播周档。在追番剧查到原播时刻后会直接显示在网页排片，自订提醒仍可在详情中设置。

## [0.27.1] — 2026-11-10

- 排期数据下载启用 gzip，冷缓存遇到暂时失败时会尝试备用入口。已有缓存可继续显示。
- 分钟级时刻显示平台适用地区，采纳后保留地区标识。查询结果明确提示中国大陆时刻缺失。

## [0.27.0] — 2026-11-10

- Bangumi 支持测试连接、脱敏代理、分来源报告和按同一份预览确认写入。同步可选保留本地进度或导入线上进度。
- 本季和番剧详情区分首播日期与下一次预计更新时间，展示分钟、北京时间和排期来源。单部、批量和详情共用排期规则。
- 加入番库可选从头补、填写已看集数或从最新一话开始。撤销进度会冲销对应统计。
- 恢复前可选择备份并预览，支持恢复整库或单部番剧。
- 新增跳过一档、临时改期、停止排片、单番静音、跨午夜免打扰和桌宠稍后提醒。

## [0.26.0] — 2026-11-09

第四轮全项目审查（[`AUDIT-round4.md`](AUDIT-round4.md)，16 条 P0 / 36 条 P1）之后的一次「止血 + 结构」版本：先让它在真实使用中不再崩、不再静默失败、不再卡死，再把三个巨型文件和一个只会越写越歪的写库函数拆开。实施顺序见 [`PLAN-v0.26.md`](PLAN-v0.26.md)。

**后端：一个坏请求不再能杀掉服务**

- **修 P0**：坏 JSON / 超长 body 的 `POST` 曾经能让**整个服务进程 exit 1**。`readJsonBody()` 已经回过 400 并 `return null`，但九处调用都写成 `(await readJsonBody(req, res)) || {}`，于是继续往下走到二次 `json()`，抛 `ERR_HTTP_HEADERS_SENT` 从 async 回调里逃逸。现在九处统一改成 `if (!body) return`（范式与 `apiProgress` 一致），`json()` 自己也会在 `headersSent` 时静默返回。
- **修 P0**：`/api/restore` 在坏请求下会**按默认备份名静默回滚**，而且先备份、再直写 `data/library.json`——把用户要逃离的坏库写进 `.bak`，好的退路反而被挤掉。现在恢复走 `restoreLibrary()`（白名单 + 校验 + 原子写 + 不拍备份 + 照压撤销栈），没有这份备份回 404 并列出可用清单。
- **修 P0**：`/api/watch` 新增条目写死 `eps: null`，而 `apiProgress` 用 `Math.min(eps, …)` 夹上限 → **从面板加进来的番永远记不动话数**（返回 `changed:false`，面板还把乐观 +1 校正回 0）。现在加番会继承本季表的集数、`track_from`，`already` 时回 `changed:false` 而不是假装成功。
- **修 P0**：删掉 `/api/reload`——它没有方法校验也没有写来源校验，任意 `GET`（包括跨站的一张 `<img>`）都能拉起三个 node 子进程；面板里也没有任何地方用它。
- **修 P0**：时刻只认**一种**写法。以前单条接口拒 `25:00` 却收 `abc`（`toMin` 把非法串折成 1441），批量接口的上限又是 28:59，与单条相反。新的 `lib/time.mjs` 把「什么算时刻」收紧成 `parseClock()`：`25:30` 合法（次日 01:30）、`abc` 报错并说明格式。
- **修 P0**：`apiState` 里那句没用上的 `readJSON('data/talks.json')` 删掉——`talks.json` 缺失时它会让首屏 500，还把绝对路径回给浏览器。
- **修 P0**：`writeLibrary()` 先序列化、后改 `updated`，写进文件的 `updated` 永远是**上一次**的值；顺手把它拆成 `lib/library.mjs`：时间戳先定、U+FFFD 与 JSON 可解析双护栏、写前压撤销栈 + 拍备份、原子写、日志带内容指纹。备份文件名也从 UTC 改成 CST，同秒重名自动加序号。
- 写库改成 `writeFileAtomic()`（同目录 tmp + rename，遇到 Windows 的 `EPERM/EBUSY` 退避重试六次），`build_today` / `build_ghost` / `settings` / `bgm` 配置 / 面板端口文件一律走它——桌宠每 4 秒轮询 `today.txt` 时不会再读到半截文件。
- **重建挪出写锁**：以前「记一话」在锁内串行跑 `build_today → build_ghost → build_yaya` 三个进程（单次 ~450ms，十连点 4.2 秒）。现在写库在锁内、重建在锁外，并且带单飞拖尾（连点只多跑一轮）。实测十并发 +1 从 **4183ms 降到 939ms**，`ep_status` 一条不丢。
- `/api/health` 回 `{ok, app, version, pid, port}`；`/api/version` 不再泄露绝对路径；所有 4xx/5xx 统一带 `ok:false`；未知 `/api/*` 回 JSON 而不是纯文本 404。
- **单实例**：不是显式 `--port` 启动时，先探一遍已在运行的 TIARA（`cache/panel_port.txt` + 7788..7799），命中就打印 URL 直接退出，不再「静默 +1 端口、覆盖端口文件、任务管理器里堆一串 node」。
- `lib/http-util.mjs` 的 `isLocalOrigin()` 删掉恒真的 `|| true` 尾巴（写来源校验从此真的在挡）；`lib/season-cache.mjs` 的裁剪改成「刚写入季度 + 当前季」双基准（以前写 2018Q1 会把 2026Q3/Q4 一起删）；`lib/ics.mjs` 的 `DTSTAMP` 从「早八小时的假 UTC」改成真实瞬时，并按 75 字节折行（Outlook 不会再截断长标题）；`lib/bgm.mjs` 只在网络层错误重试（403/404 立即放弃，省 3.6 秒），代理串支持 `user:pass@host:port`。
- 服务端加 `unhandledRejection` / `uncaughtException` / `SIGINT` 兜底日志，`logLine` 的时间戳改成 CST（以前是 `toISOString()`，和面板差八小时）。

**工具链与启动器**

- `tools/ci.mjs`（新）：语法检查全仓 `.mjs` → 跑单测 → `sync_docs --check` → 面板拆分完整性（引用文件存在、禁用 `type="module"`）→ `today.txt` 新鲜度。一条命令代替「到处点」。`node tools/doctor.mjs` 也新增面板拆分、版本真源、发布包过期三项。
- `tools/check_panel_ui.mjs` 自己起服务了：以前写死 `http://127.0.0.1:7788/`，没人跑 7788 时报的是「Cannot read properties of null (reading 'innerText')」，看着像面板 bug。现在挑空闲端口起一个临时实例（`--port` + `--no-portfile`，不改写 `cache/panel_port.txt`），跑完关掉；顺带在还原 `library.json` 之后重算三份产物，不留下「跟库对不上」的 `today.txt`/`words.txt`。
- `server.mjs` 新增 `--no-portfile`：临时实例（体检、演示、第二份副本）不再覆盖「用户那只服务在哪个端口」的唯一指针，否则桌宠右键会去找一个已经关掉的端口。
- `tools/build_today.mjs` / `build_ghost.mjs` 支持 `--root DIR`（单测与沙箱可以挂临时库，不碰真实 `data/`），`--date` 的输出可复现；`build_ghost` 的 `{hour}` 改按 CST 取（以前跟系统时区，跨时区会算错），占位符里的反斜杠不再吞标签。
- `tools/sync_docs.mjs` 重写：版本取 `package.json`、**发版日期取 CHANGELOG 里那条**，查不到就沿用旧日期并 warn——不再把「今天」冒充发版日。
- `打开番组表.bat` 不再硬编码 7788：只认 `cache\panel_port.txt`，探 `/api/health`，没起就起一个（不带 `--port`），轮询等端口文件，起来才开浏览器。`启动TIARA.bat` 现在会把面板服务一起拉起来——以前双击启动后点桌宠的「打开网页番组表」会落到 `file://` 的报错页。

**面板（`panel/` 拆成三件）**

- `index.html` 从 1650 行拆成 `index.html`（71 行骨架）+ `style.css`（450 行）+ `app.js`（1387 行）。**必须是经典脚本** `<script src="./app.js">`：桌宠在没有服务时用 `file://` 打开面板，`type="module"` 会被 CORS 拦成白屏。
- **修 P0（存储型 XSS）**：本季表的集数那一列没转义就拼进 `innerHTML`，污染一份 `data/season/*.json` 就能在本机源上执行脚本。现在走 `esc()`，封面 `onerror` 也从内联改成全局捕获（顺带修掉「名字以 `'` 开头时整块脚本语法错」）。
- **修 P0（翻旧季加番写出脏条目）**：批量加番只传 `add` 不传 `q`，服务端只能拿「当前季」匹配，于是写进一条 `name_cn` 是数字 id、没有放送日的条目，三个页面都看不见。现在带 `q`，服务端查不到就 400 并列出 `missing`，不写脏数据。
- **修 P0（批量写时刻恒失效）**：面板只让勾「还没在追」的行，服务端只改「在追」的条目，于是永远 `changed: []`，提示还显示「已给  部」。现在提示分三种：写了 N 部 / 这些番还没加进在追 / 格式不对。
- **修 P0（键盘误写库）**：全局 `keydown` 只排除了输入框，没排除按钮——焦点在按钮上按空格会**静默给某部番 +1 话**。现在排除 `button / a / [role=button] / summary`、弹窗打开时短路、只有选中卡片时才接管 Space/Enter。
- **修 P0（假成功）**：服务端 4xx 只回 `{error}`，前端却只看 `j.ok === false`，于是 `25:30` 被拒还提示「时刻已写入」。现在 `json()` 对非 2xx 先置 `ok=false`，所有写路径再判 `j.ok === false || j.error` 双保险。
- **修 P0（本季工具条盖住顶栏）**：`.bar` 是给顶栏用的 `position:sticky` + 硬编码深色，本季工具条复用它，滚动后压住 header、亮色主题下对比度只有 1.30:1。改成流内 `.fbar`。
- P1/P2 一并做掉：本季行内 −/+ 后数字会动；断网时保留原视图 + 顶部重试条（不再整页换成错误面板）；`auto` 主题真的跟随系统；刷新后保留筛选与焦点；`.ops` 在触屏上常显；待看弹窗的 grid 布局；`role=status` / `role=dialog` / `:focus-visible`；`doSync` 失败会复位忙碌态；统计缺数据不再显示 0。

**桌宠（`pet/Pet.cs`）**

- **修 P0**：HTTP 只有 `Timeout`、没有 `ReadWriteTimeout`（.NET 默认 300 秒）——面板卡住时桌宠会冻结最长五分钟，托盘菜单一起没反应。请求全部缩短到 2.5 秒并补上读写超时。
- **修 P0**：`SyncBangumi` 先 `ReadToEnd` 再 `WaitForExit(25000)`，超时还不 `Kill`——子进程不退出、管道写满就死锁，留下孤儿 node。改成异步收流 + 到点 `Kill`。所有「找 node」的地方统一走随包的 `runtime\node.exe`，没有再退 PATH——没有装 Node 的机器上「重算今日数据 / 同步 Bangumi」以前一定失败。
- 加单实例互斥（重复双击不会出现两只桌宠）；菜单里的「尺寸」不再被 `settings.json` 每分钟掰回去；台词里的「第 N 次」不再冻结在启动时的值；空转动画不再 20fps 常驻（省电档真的会进）；`CheckNewDay` 失败当天会重试；双击不再同时触发「摸头 + 抱」；透明区域的命中遮罩会跟着当前表情走；`PET_SELFTEST` 不再真的写库/同步。
- 200% 缩放 + 1080p@125% 下立绘跑到屏幕外的算式收进一处并加上限；多显示器按所在屏的工作区算，不再物理像素与 DIP 混用。
- 十四个 `PET_*` 调试开关收敛成 `PET_DEBUG=1`（子开关仍可用，但不再各写一份读环境变量的代码）。

**台词与内容**

- **九个「写好了却永不播放」的池接上了线**（`praise` / `worry` / `goodnight` / `selfIntro` / `wheel` / `catchup` / `imaginationHigh` / `flusterHigh` / `pending`，约 20 句）。每个池配一个真实时机：摸头整十次、快速连记到第 3 话、23 点后收尾、首次运行自介、滚轮缩放、开机且落后 ≥2 部、慌张/妄想过高、开菜单且有积压。冷却写进 `state.json` 的 `say_*` 键，日志统一打 `say pool=<名>`，池里没句子就记 `MISSING` 并退回兜底句——不再静默。
- 立绘上**滚轮缩放**（±5%，走菜单「尺寸」同一条 `ApplyScale`，会写回 `settings.json`）；连滚十几格也只说一句（10 分钟冷却）。
- 七个只有一句的池补到 2–3 句（`todayHas` / `birthday` / `askSync` / `undoWait` / `undoFail` / `noServer` / `pending`），听久了不再循环同一句。
- `idleLong` 第二句「二十分钟没动静」跟新的空闲阈值（5 分钟 / 15 分钟两档）不符，改成「有一阵子没动静了」。

**文档与仓库**

- 新增 [`AUDIT-round4.md`](AUDIT-round4.md)（本轮审查全文）、[`PLAN-v0.26.md`](PLAN-v0.26.md)（实施顺序与验收门）。
- 十份旧文档（`PLAN.md`、`PLAN-v0.4` … `PLAN-v0.9-menu-ghost`、`AUDIT.md`、`AUDIT-round2/3`、`AUDIT-RECHECK`）归档到 `docs/archive/`；README §14 的 446 行变更记录搬进本文件，README 只留最近两条。
- README 的 API 表、启动说明、命令表、故障排查按新契约重写；§13 的「单测只盖纯函数」改成现状（lib + 服务端 + 打包工具），并修掉两条重复编号。
- 单测从 90 条涨到 **124 条**，新增 `time` / `library` / `atomic` / `season-cache` / `server` 五组；`node tools/ci.mjs` 一条命令跑完语法 + 单测 + 文档一致性 + 面板完整性。

## [0.25.0] — 2026-11-05

- **气泡重做：一体轮廓。** 放弃「Border + 独立三角形」的两件套，改成 `CombinedGeometry(Union)`：圆角矩形与两段二次贝塞尔收成的圆头尾巴合成一条轮廓，一次填充 + 一次描边，描边连续、没有接缝，也就彻底没有「箭头和气泡分家」的问题。尾巴从硬三角改成圆头，跟 18px 圆角是同一套语言。
- **气泡与立绘拉开距离**：宿主上下留白 8–12px，尾巴不再压进头发。
- **修复：气泡会把立绘顶走。** 立绘钉在窗口底边/顶边，`ApplyHeight()` 只让气泡那一侧伸长；放不下时依次降级为「翻到下方」→「叠在立绘上方」（overlay），三级都不移动立绘。实测短句 / 长句两种情况下立绘屏幕顶边完全一致。
- **修复：气泡轮廓自激膨胀**（曾涨到 4791px 高）。`Path` 的几何原本按父容器 `ActualHeight` 计算，几何又反过来影响父容器高度 → 死循环。改成用 `Canvas` 承载轮廓（不参与度量）+ 显式 `Width/Height` + `Stretch.Fill`。
- **全项目审查**：见 [`archive/AUDIT-round3.md`](archive/AUDIT-round3.md)——体积、行数、23 条路由、11 个调试开关、安全项、三个巨型文件的拆分建议都写在里面。

## [0.24.3] — 2026-11-05

- 锚点从 44%（偏左）挪到 **56%（偏右）**——偏左看着别扭。
- **气泡宽度在说话开始时按整句钉住**（_bubble.MinWidth），打字过程中不再一边长一边挪；收起或下一句开始前松掉，短句不会被上一句的宽度撑成长条。
- 宽度改用 ActualWidth（已排布宽度），不再用 Border.DesiredSize——后者会把内层 TextBlock 的 MaxWidth 带进来，导致气泡整体左移。
- 新增 BubbleMaxW 统一「最宽 72%」的口径，BuildUi 与 ApplyScale 两处不再各写一份。
- 验证：短句／长句两张对比图（cache/audit/t_short.png、	_long.png），箭头都钉在 x=228、气泡分别 90px 与 300px 宽且都以 241 为中心；单测 90 过。

## [0.24.2] — 2026-11-05

- **尖角改成固定锚点**：以前尖角跟着气泡宽度漂，句子长短一变它就挪位置，看着不协调。现在锚点固定在窗口宽度的 56%（头顶偏右一点），气泡以锚点为中心向两边展开并夹在窗口内，箭头一动不动——PositionBubble() 统一算气泡与尖角的位置。
- 气泡最宽 72% 窗口、右边不再贴死边缘；贴顶仍是「整窗下移（`bubble shifted down N`）」，只有窗口比屏幕高才翻到下方。
- 验证：`PET_SCALE=0.7/1/2` 三档（`cache/audit/anc_0.7.png`、`anc_1.png`、`anc_2.png`），单测 90 过。
- 新增调试开关 `PET_SAY="随便一句话"`：启动后直接念这句，用来量短句／长句下气泡与尖角的位置——`cache/audit/say_short.png` 与 `say_long.png` 两图里箭头都钉在同一个 x 上。

## [0.24.1] — 2026-11-05

这一版把气泡的**尖角与本体重新绑成一个整体**，并调顺了位置。

- **尖角飞到气泡外面的真因**：尖角的水平位置是按**窗口宽度**算的（`ScaledW * 0.5 - 30`），而气泡宽度由文字长度决定——句子一短气泡变窄，尖角还留在原来的横坐标上，于是和气泡本体完全分开。现在气泡与尖角装进同一个「宽度等于气泡宽度」的盒子（`_bubbleBox`），尖角位置改按气泡自身宽度算（靠左 1/3），并且**填充层比描边多往上探 8px** 压进气泡底边，所以接缝处既没有横线也没有重影（阴影从 `Border` 挪到盒子上，配合 `Panel.ZIndex` 解决遮挡顺序）。
- **位置**：右边距 14px、气泡最宽 72% 窗口（原来 80%，看着像横幅）、尖角尖端压进立绘上沿 6px，读起来是从她脑袋上说出来的。
- 贴顶时仍然是「整窗下移」而不是翻到脚下；只有窗口比屏幕还高才翻（尖角旋转 180°）。
- 验证：`PET_SCALE=0.7/1/2` 三档截图（`cache/audit/fin2_07.png`、`fin2_1.png`、`fin2_2.png`）、单测 90 过、`doctor` ✅。

## [0.24.0] — 2026-11-05

这一版修「气泡里的按钮点不动」，并把气泡从「正上方居中」改成漫画式的右上对白框。

- **「再抱一下」卡住的真因**：选择肢是按钮挂上去之后才有的，而窗口高度只在 `Say()` 里算过一次——多出来的一行按钮落在窗口外面，点它当然没反应。现在 `SayWithChoices()` 在挂完按钮后重新 `Measure` 一次再定高（`choices: N 个选项 h=103` 写进日志），并把停留时间从 6 秒延到 20 秒。实测点「记一话」→ `CHOICE FIRED bump`。
- **点气泡的边界改成真实矩形**：`WM_NCHITTEST` 里原来写死「窗口顶部一条带」，翻到下方或气泡变窄就判错。现在用 `PointToScreen`/`TranslatePoint` 算气泡在窗口里的实际矩形。
- **气泡位置**：靠右挂、尖角偏右指头；最宽 80% 窗口。屏幕上方放不下时改为整窗下移（`bubble shifted down N`），不再翻到脚下——尖角指腿太怪。
- **样式**：圆角 18–20、暖灰细边、`#FFFEFB→#F8F0E2` 渐变、22px 柔和阴影、胶囊形选择肢（悬停变暖色）。
- **顺手修的**：`SnapIntoWorkArea()` 之前混用 `GetWindowRect` 与 `GetSystemMetrics`，在 125% 缩放的机器上算出一块 2560 宽的假屏幕，窗口可能停在屏幕外、整只宠物点不到；改为「物理矩形 + 实测缩放比」换算。
- 验证：单测 90 过、`doctor` ✅、`check_panel_ui` 11 项 PASS；`PET_SCALE=0.5/1/1.5/2` 四档截图在 `cache/audit/v2*`。

## [0.23.1] — 2026-11-05

- **贴顶时气泡翻到立绘下面**：她本来就停在屏幕上沿时，气泡往上长会被顶出屏幕（实测窗口 `Top` 变成负数，整块看不见）。新增 `LayoutBubble(below)`：靠顶边时把根 Grid 的两行对调、窗口往下长、尖角旋转 180° 指回她；拖到别处自动翻回去（`pet/pet.log` 里的 `bubble below=True/False`）。
- **点气泡终于有反应**：`_bubbleHost` 的 `Background` 原来是 `null`，WPF 里 null 背景的 Panel 不参与命中测试，`MouseLeftButtonUp` 永远收不到——补 `Brushes.Transparent` 后点气泡能立刻显示整句。

## [0.23.0] — 2026-11-05

这一版修「非默认尺寸下交互失准」，并把气泡从一块方纸片换成会呼吸的对话泡。

- **立绘尺寸的根因**：`_sprite` 只在 `ApplyScale()` 里设高度，启动时没尺寸——所以上次缩到 85% 再打开，窗口是 366×488，立绘却还是原始 384×576，点击坐标按错的框算，摸头就落到了身体上。现在 `BuildUi()` 里直接给 `Height = ScaledH`，`_art` 同时给宽高，`ApplyScale()` 再兜一次。
- **点击越界不再算「身体」**：`RegionAt()` 遇到点在立绘之外（缩放后窗口比立绘宽的左右边角）返回 `none`，`OnSpriteUp()` 直接忽略——以前这些点会被当成「点身体」，说一句莫名其妙的话。
- **窗口高度的算法换掉**：旧版说话时fixed 高度「立绘高 + 104×倍率」，50% 时只有 52px，两行字必被切；现在用 `FormattedText` 按实际折行高度算（文字高 + padding 25 + 描边 3 + 尖角 13×倍率 + 留白 14），并用固定行高把立绘钉在底部，气泡往上长的时候立绘不动。
- **气泡重做**：圆角 16、暖灰细边、半透明暖白底、向下尖角、16px 柔和阴影；出现时 150ms 淡入 + 8px 上浮。字号跟着尺寸在 0.9–1.6 倍间取值，圆角与尖角同步缩放。
- **点气泡跳过打字机**：气泡区域在 `WM_NCHITTEST` 里单独判成可点（否则立绘 alpha=0 会把它打成透明穿到桌面），点一下直接显示整句。
- 文档：§7.1 重写气泡段落（样式参数 + 尺寸行为 + 点一下显示完），`package.json` 0.23.0。

## [0.22.0] — 2026-11-05

这一版把「欠着的番」搬进桌宠气泡，并让早とちり与纪念日真正连起来。

- **气泡里的「欠着的 N 部」**：位置在「今天」和「接下来三天」之间——那才是每天真要处理的东西。每行 `欠 1 番名 0/1 ＋`，整行可点，点了就是 +1 话（走 `/api/progress`，和面板同一个入口）。数据直接读 `today.txt` 已有的 `behind{n}_id/_name/_eps/_watched/_expected`，没有新增快照字段。
- **同步失败也会早とちり**：失败后先想歪一句「……是不是你那个 token 又删了。」，再给 `[再试一次] [算了]` 两个选择肢；选「算了」她说「……那就不勉强。」
- **记满一部之后偶尔也想歪**：`catchupFull` 说完有 50% 概率 2.4 秒后接 `MisreadHint()`——「你该不会是要走了吧」这种。
- **纪念日系统**：`state.json` 的 `vars.first_seen` 记第一次见面；跨日时检查 7 / 30 / 100 / 200 / 365 天，命中说 `anniversary`（带 `{days}`）。**跳着来只报最大的那个**（隔了 100 天才开一次就报 100，并把 7/30 一起标成已过），不会补报一串。
- 新池：`anniversary`(3) / `pending`(1)；`menu` 加 `panel_pending` / `choice_retry` / `choice_later`。总计 **54 池 / 136 行**。
- 自检扩到 16 步：把 `first_seen` 改成 99 天前再 `CheckMilestone()`，日志 `say face=1 第 100 天了。……我记着呢。` / `milestone 100 days=100`。
- **修掉一个自己踩的坑**：milestone 循环原来从最小的 mark 往上找，导致 days=100 时报的是「7 天」；改成「收集所有已达且未报的，取最大的，其余一并标记」。

## [0.21.0] — 2026-11-05

这一版把「有副作用的动作」收进气泡，再让问候按时段换语气。

- **同步前先问一句**：右键「同步 Bangumi」不再直接动库，先弹 [同步吧] [等会儿]；选「等会儿」她说「……嗯。我记着。」不催。
- **撤销进菜单**：右键 → 业务 → 「撤销上一次记账」，走 `POST /api/undo`（和面板同一个撤销栈，最多 10 步）。实测 `undo ok depth=8`。
- **分时段问候**：整点问候不再只有一套 `hourly`——6–9 点 `morning`、12–14 点 `noon`、17–19 点 `evening`、22–3 点 `night`，各有专属语气；其余整点仍走 `hourly`，凌晨 1–7 点照旧免打扰（生日例外）。
- **新池**：`noon`(2) / `night`(2) / `askSync` / `undoWait` / `undoOk`(2) / `undoFail` / `noServer`；`menu` 加 `undo` / `choice_yes` / `choice_no`。总计 **52 池 / 132 行**。
- **踩过的坑**：`FindPanelPort()` 返回 `string` 不是 `int`（写成 `int port = FindPanelPort()` 报 CS0029），`PickFrom()` 返回 `Line` 不是 `string`（写成 `new Line(PickFrom(...), true)` 报 CS1503）——两处都改对才编过。
- 自检扩到 15 步：撤销一次、同步前先问（验选择肢），日志 `undo ok depth=8`、`say face=0 要现在去 Bangumi 拿最新资料吗？`。

## [0.20.0] — 2026-11-05

这一版两件事：**台词整体调暖**，以及把「抱一下」和「早とちり（误会后自己纠正）」做成机制。

- **台词调暖**（`data/talks.json` v4，46 池 / 124 行）：删掉「手，请拿开」「请不要妨碍办公」这类把人推开的句子，换成「……唔。手，别停。」「……太近了。……但是，也没让你走。」「……咳。没什么。只是觉得，这样也不错。」。冷的只保留在**该冷的地方**（学生会章程、连续摸头的 `nade_min:10` 规则）。
- **双击＝抱一下** `HugSay()`：好感 +3（摸头 +1）、妄想 +3 / 慌张 +2；说完弹选择肢「再抱一下 / 够了」，选前者递归一次（不刷变量上限，`affinity` 封顶 100）。
- **早とちり**：每抱到第 3 次，先想歪一句（`misreadGuess`），2.2 秒后自己纠正（`misreadFix`）；另有 `MisreadHint()` 给「不是那样 / ……算是吧」两个选项，选后者会承认并涨慌张——这是「误会」不是「拒绝」。
- **新池**：`hug`(3) / `soft`(3) / `praise`(2) / `worry`(2) / `goodnight`(2) / `misreadGuess`(2) / `misreadFix`(3)；`{hug_total}` 加入占位符表。
- **菜单与气泡也调暖**：`header_empty` 改「今日清闲 · 陪你坐会儿」、`case_none` 改「今天没有案件 · 那就聊聊天」、`panel_empty` 改「……正好，歇一会儿吧。」。
- 自检扩到 13 步：抱一下（验选择肢）、早とちり（验「先歪→纠正」两段式），日志里能看到 `hug total=2 affinity=39` 与 `say face=2 ……你该不会，是嫌我记错了。`。

## [0.19.1] — 2026-11-05

上一版把菜单和称呼做完了，这一版补的是**她会因为你怎么用她而变**——三条变量线 + 事件粒度细化。

- **三条人设变量**：`imagination`（妄想）/ `fluster`（慌张）/ `nosebleed_total`，和 `affinity` 一起存 `state.json` 的 `vars`。摸头各 +2/+1，点脸各 +2/+3，22 点–3 点额外 +1；每分钟衰减 `-1` / `-4`（不低于 0）。
- **鼻血是阈值事件**：`imagination ≥ 60 且 fluster ≥ 40`、距上次 ≥ 10 分钟才发作，各扣 30 并 `nosebleed_total + 1`，说 `nosebleed` 池（3 句）——所以是「积攒到某个点」而不是每摸一下就喷。
- **派生心情 `mood`**：`fluster ≥ 40` → `flustered`，`imagination ≥ 60` → `dreamy`，否则 `calm`；不落盘、每次现算。顺手修掉一个静默 bug：规则里的 `mood` 原本读 `vars.mood`（永远空），现在比 `Mood()`。
- **规则引擎扩条件**：新增 `imagination_min` / `fluster_min`，`rules` 从 6 条加到 10 条（含 `mood: dreamy` / `mood: flustered` 两条）。
- **记一话三档反馈**：`bump` → `bumpRapid`（60 秒内 ≥3 次）→ `catchupFull`（记满），走 `AfterBump()`。
- **新事件**：`OnMenuOpen` / `OnOpenPanel` / `OnBumpRapid` / `OnCatchupFull` / `OnIdleLong` / `OnSyncDone` / `OnSyncFail`，全部由 `Dispatch()` 分派；`OnSecondChange` 不再被塞新业务。
- **静置 20 分钟会说一句**（`idleLong`）；打开菜单、打开番组表也有各自台词（各带 20 s / 90 s 节流）。
- `data/talks.json` 扩到 **39 池 / 107 行**（新增 `menuOpen` `bump` `bumpRapid` `catchupFull` `idleLong` `openPanel` `nosebleed` `flusterHigh` `imaginationHigh`）。
- 自检也扩了：`PET_SELFTEST=1` 现在会把变量顶到临界点、点一下验鼻血、连记三笔验 `bumpRapid`，日志里能看到 `persona poke imagination=61 fluster=42 mood=flustered` → `nosebleed #1` → `imagination=31 fluster=12`。

## [0.19.0] — 2026-11-05

这一版做两件事：把右键菜单改成「能干活的东西」，以及让**她怎么叫我**变成可改的设置。

- **右键菜单重做**：状态头（`{nickname} · 副会长室` + `今日 N 件 · 未处理 M 件`）→ **案件**（今天每部一行，点了直接 +1 话，走 `/api/progress`）→ 番组表（气泡 / 网页 / 重算）→ 说句话 / 摸摸头 → 业务（同步；高级：重算、打开数据文件夹、看服务日志）→ 显示（层级 / 尺寸）→ 托盘 / 退出。排障项不再和常用项并排，每次打开都重建菜单，记完一话立刻反映在状态行。
- **称呼可自定义**：新增 `lib/persona.mjs`（`DEFAULT_NICKNAME='会長'`、`normalizeNickname()`、`addressOf()`、`personaInfo()`），`POST /api/nickname` 写 `data/library.json` 的 `user.nickname_for_pet` 并重算快照；面板底栏「账号与称呼」弹窗可直接改（最多 12 字、禁花括号、自动压平换行与多余空格）。默认值从「主人」改成「会長」——她是副会长，你是她管着的会长，这个错位本身就是设定。
- **固定说法不走称呼**：生气时的「不届き者」、自称「副会長」、社团「生徒会」写在台词里，不跟 `{nickname}` 走（`RESERVED_TERMS`）。
- **台词池全面改成副会长的中文口吻**（`data/talks.json` v3，33 个池 + `menu` 对象 32 键）：在追的番叫「案件」、记一话叫「处理一件」、落后叫「未处理 N 件」；去掉整句日文，只保留「案件 / 未処理 / 副会長 / 不届き者 / 着任」这类词做味道。
- **SSP 词典也会替换称呼**：`tools/build_ghost.mjs` 新增 `SUBST`，把 `{nickname}` / `{count}` / `{behind_count}` 之类在生成时就填掉（里々 没有变量系统，否则会把花括号原样念出来）；播报行同时改成中文。
- **桌宠气泡标题跟着角色走**：`今日番组 → 今日案件`，空态与分区标题也走 `menu` 池（`panel_title` / `panel_empty` / `panel_next` / `panel_quote`）。
- 新增 `test/persona.test.mjs`（8 例：默认值、规整空白、空/超长/花括号拒绝、`addressOf` 回落、`personaInfo` 字段），单测 82 → 90；`doctor` 增「称呼」检查（库里写了非法值会 warn 并说明实际会用默认值）。

## [0.18.0] — 2026-11-05

这一版回答「她凭什么叫伪春菜，不只是个桌宠」：把传统伪春菜（橘花2 / SSP 那一套）真正撑起「人格感」的机制补进来，而不是继续加面板按钮。

**P0 骨骼：事件总线 / 分层立绘 / 分区交互**

- **事件总线**：窗口里发生的每件事（每秒、跨分、跨刻、到点、点区域、托盘操作、回到前台）都 `Post()` 进队列，`Dispatch()` 分派给业务方法——与传统伪春菜的 `OnSecondChange` / `OnMouseClick*` 同一套写法（`pet/Pet.cs` 的 `Evt` / `_evtq` / `Dispatch`）。三个定时器分工：50 ms 只管画面呼吸，1 s 派发秒/分/刻，60 s 轮到点提醒与跨日。
- **分层立绘**：新增 `shell/master/faces.json`（画布 `384x576`、每表情 `base` + `overlay[]` + `talk.png` 嘴），桌宠改成 `Grid` 叠层渲染，气泡说话时嘴会动。缺 `faces.json` 时自动退回「一张整图」的老模式。
- **分区交互**：`regions` 声明 `head` / `face` / `body` 的矩形，`RegionAt()` 把鼠标点换算到画布坐标判区域——点头顶摸头、点脸搭话、点身体普通对话；没配 `regions` 退回「上部 26% 算头」。
- **摸头递进 + 好感**：800 ms 冷却，按「今天第几次」依次念 `nade` 池，念完随机；`nade_today` / `nade_total` / `affinity` 写进 `state.json` 的 `vars`，跨日自动清零（好感不清），台词里 `{nade_today}` / `{affinity}` 会替换成真值。

**P1 人格：规则、选择肢、快照**

- **轻量规则引擎**：`data/talks.json` 新增 `rules[]`，每条 `when`（`hour_min` / `hour_max` / `weekday[]` / `behind_min` / `count_min` / `nade_min` / `affinity_min` / `mood`）+ `text` / `face`；命中优先于随机池，同一条 15 分钟内不重复。默认给了 6 条（深夜、十一点、早上、周一、积压、摸头超量）。
- **选择肢**：`SayWithChoices()` 在气泡下面弹按钮；到点提醒改成「记一话 / 在看」两个选项，点「记一话」直接给那部 +1 话。
- **整点与生日**：跨整点说 `hourly`（1–7 点静音）；`data/settings.json` 写 `"birthday": "11-05"` 那天先说 `birthday`。
- **按日快照**：`tools/snapshot_daily.mjs` 把 library/settings/state/bgm/history（尾 800 行）存进 `data/backups/YYYY-MM-DD/`，默认留 14 天；**面板启动时自动跑一次**，`doctor` 会报「共 N 天，最新哪天」。

**P2 工程**

- `tools/manifest.mjs`：`dist/manifest.json` 记 path / size / sha256，`--check` 校验产物有没有被动过（实测改一个字节就报「变了」）。
- `tools/check_faces.mjs`：校验 `faces.json` 的图层、尺寸、区域越界、别名悬空（`doctor` 里也接了一条）。
- `doctor` 新增两处：`faces.json` 校验、按日快照状态。
- 单测 74 → **82**：`test/faces.test.mjs` 8 例（正常包 / 缺图 / 尺寸不符 / 区域越界 / 别名悬空 / 无 regions 只 warn / 真仓库通过）。
- 文档：§3 补 9 行新能力、§7.2 补 6 条机制、新增 §10.3「和 SSP 共存」、§11 工具表补三个脚本。

## [0.17.1] — 2026-11-05

修一个一直被当成「图挂了」的问题：**封面经常加载不出来**。

- 以前面板让浏览器自己去 `lain.bgm.tv` 取图。实测本机直连 24 张 **0 张成功**；走代理 166 张全成功但平均 1.3 秒一张，一屏 100+ 张必然大面积空白（同一域名浏览器只开 6 条连接）。
- 改成 **服务端取一次就落盘**：新增 `lib/cover.mjs` + `GET /cover/<id>.jpg`，命中磁盘 3 ms 返回，未命中经 `data/bgm.json` 里的代理取一次再缓存（`Cache-Control` 30 天），同一张图并发只取一次。本季表打开时后台按并发 4 预热。
- 面板 `cover()` 只认 id，一律请求本地路径；取不到退回首字方块，不裂图。
- 顺手修：`/api/state` 的 `images` 太窄（只装今天/本周那十几条），本季表 167 条根本没地址——现在本季表用自己的季度缓存 + 本地缓存图。
- `doctor` 加「封面缓存」检查，新增 `test/cover.test.mjs`（5 例，含 URL 白名单：`http://`、外域、`file://` 全部拒绝，避免这个路由变成任意 URL 代理）；单测 69 → 74。
- 方案文档：[archive/PLAN-v0.8-ghostify.md](archive/PLAN-v0.8-ghostify.md)（封面根因、传统伪春菜的 7 个机制、我们 vs 传统的对照、C# 重做该不该做、P0–P2 路线图）。
- 历史文档统一收进 [docs/](docs/)：`PLAN.md`（初版总纲）、`PLAN-v0.4.md`、`PLAN-v0.6-tiara.md`、`PLAN-v0.7-next.md`、`PLAN-v0.8-ghostify.md`、三份 `AUDIT*.md`、`REFERENCE-taromati2.md`（橘花2 参考研究）。根目录只留 `README.md` 与当前方案。

## [0.17.0] — 2026-11-05

这一版只修一件事：**「记一话」要好按**。以前记录一话要「找到那部番 → 对准 `+` → 点 → 等整页重绘」，桌宠那边根本没法记。

**记一话的速度**

- **乐观更新**：点下去立刻改数字和进度条，只重画那**一行**（不再 `innerHTML` 整页重绘），请求在后台发；失败才回滚。260 ms 内的连点合并成一次写，不会出现「点五下只加一」。
- **一键撤销**：提示条上直接给「撤销」（以前只能整库「恢复上一版」）。服务端 `data/undo/` 留最近 10 版，键盘 `u` 也行。
- **桌宠也能记**：弹窗里每行整行可点（悬停变暖色，尾部 `＋` 变红），点一下就给那部 +1 话，说完就刷新；托盘菜单也加了「记一话」子菜单（今天有番时列前 8 部）。桌宠是通过本地面板服务写库的，服务没起会直说「网页服务没开，我改不了库」。
- **不再弹 `confirm()`**：移出在追改成「先做，再给撤销」——误点了有退路，不用先确认一次。

**看得见的状态**

- **待看 N**：顶栏多一个按钮，显示「比播出进度落后的番有几部」，点开列出来，行内 `+1`。
- **新集标记**：同步时发现某部总话数变多，就在卡片上打一个 `新`（看 `eps_updated_at`，三天内有效）。
- **键盘**：`j/k` 选番、`空格` 记一话、`x` 移出、`u` 撤销、`1/2/3` 切页、`/` 搜索。选中行左边有竖线，光标在哪一眼能看出来。
- **主题**：底栏「暗色 / 亮色 / 自动」，亮色是同一套布局换调色板。

**批量与导出**

- 本季表加「只看没追的」和「批量时刻」：勾几部 → 填一次 `25:30` → 一次写进 `library.json`（时刻上限放到 28:59，因为 30 小时制要能填 25:30）。
- 导出的 `.ics` 现在每个事件都带 `VALARM`（提前 10 分钟），丢进日历 app 会真的响。

**工程**

- 新增 `lib/ics.mjs`（可单测的 ics 生成）、`tools/metrics.mjs`（规模体检）。
- `doctor` 分出 `info` 级别（只提示不拦开工），时刻缺失从 `warn` 降级为 `info`；新增「放送日一致性」与「待看队列」两项检查。
- 单测 **43 → 69 例**（新增 ics 7 例 + http-util 6 例 + season-cache 8 例 + zip 5 例）；`check_panel_ui` 加断言：提示条带撤销、键盘记一话、主题序列、待看弹窗。
- 修 `check_panel_ui` 三个真问题：提示条量错了节点（`Range.setEnd` 越界）、点之前没先读旧值（把点完的数值当基准）、页面未 reload 导致读到上一次的库。

## [0.16.0] — 2026-11-05

这一版没有新功能，全在「跑久了会不会烂、出事了怎么救、别人怎么装」上。

**修 / 加**

- **并发点按钮不再丢**（A1）：`data/library.json` 的写操作以前是「读 → 改 → 写」，两个请求撞在一起就会丢一次（实测 10 次并发只落 1 次）。现在服务端有一把全局写锁，同一时刻只有一个写事务在跑——同样 10 次并发实测 10 次全落。
- **缓存自己清**（A2）：`cache/` 曾经涨到 **498.9 MB / 8629 个文件**，主要是 UI 自检留下的浏览器 profile。新增 `tools/clean_cache.mjs`，自检脚本跑完自动删自己的 profile，`doctor` 超过 200 MB 会提醒。
- **服务端日志 + 诊断**（A3）：日志落到 `cache/server.log`（1 MB 轮转 `.1/.2/.3`），面板底栏「诊断」按钮直接看尾巴；重算失败会把原因带进提示条，不再只是「改了库但不生效」。
- **版本单一来源**（A4）：新增 `package.json`（`0.16.0`），`npm run docs` 把版本写进本文件，`--check` 不一致就报错。
- **从备份恢复**（A5）：`node tools/restore_library.mjs --list` 列出所有备份（含健康度），`--latest` 一键回滚；恢复前先把现状存成 `…-prerestore.json`。服务端写库后会记一行 `写库：watching=N bytes=N sha1=…`，出问题能对上号。
- **桌宠省电**（B1）：原来 60 fps 定时器常驻（静置约 7.8% 单核）。改成三档：刚交互 20 fps → 静 60 秒后 2 fps → 静 5 分钟或勾「省电模式」直接 0 fps。实测静置 **≈1.0% 单核**；托盘菜单可勾「省电模式（不呼吸）」。
- **面板首屏瘦身**（B2）：`/api/state` 只带「今天 / 本周 / 在追」用得到的封面，`week` 只留 6 个必要字段，台词改由 `/api/say` 现取——响应从 22.2 KB 降到 **12.6 KB**；搜索框加了 120 ms 防抖。
- **历史轮转**（C3）：`data/history.jsonl` 超过 5000 行时按年份归档到 `data/history-<年>.jsonl`，主文件只留当年。
- **新手引导**（C1）：库是空的时候（或 `?welcome=1`）「今天」页顶部给三步引导：去「本季」挑番 → 补开播时刻 →（可选）同步 Bangumi，按钮直接把人带过去。
- **便携包**（C2）：`npm run pack:portable` 产出 `dist/TIARA-portable-0.16.0.zip`（89 个文件 / 97 MB，含 `runtime/node.exe` 与 `pet/Pet.exe`），解压双击 `启动TIARA.bat` 就能用，不需要装 Node。

**工程**

- 单测 43 → **62** 例：新增 `test/http-util.test.mjs`（跨站写拦截 / 请求体上限 / 坏 JSON）、`test/season-cache.test.mjs`（TTL、保留窗口、坏缓存）、`test/zip.test.mjs`（CRC32 已知值、往返、中文名）。
- 抽出 `lib/http-util.mjs`（`isLocalOrigin` / `checkWriteOrigin` / `checkBodySize` / `parseJsonBody`）与 `lib/zip.mjs`（store-only zip 写入 / 读取），`server.mjs` 与两个打包脚本都改成 import。
- 修 `lib/season-cache.mjs` 两个真 bug：内存缓存 key 少了 root（两个数据目录会串味）；季度缓存保留窗口 `KEEP_SPAN=3` 现在会真的删掉窗口外的文件。
- 修 `lib/zip.mjs` 的 `dosTime`：1980 年之前的日期以前会绕成 2098 年。

## [0.15] — 2026-11-05

**修**（底部提示条一行只显示两个字）

- 根因是**类名撞车**：提示条显示时加的是 `class="show"`，而 `panel/index.html` 里 `.show` 同时是周历板卡片的样式（`display: grid; grid-template-columns: var(--cv-w) 1fr`）。于是提示条被当成卡片，缩成 36px 一列，中文两字就折行——实测宽 78px、7 行。
- 改法：提示条的状态类换成 `.toast.is-up`（并给 `.toast` 加 `max-width: min(560px, calc(100vw - 48px))`，长句子在窄屏才折行）。实测恢复成 197px / 1 行。
- 顺带把 `.bar` 的同类问题也钉住（见 v0.14 的 `.fbar`）：现在 `tools/check_panel_ui.mjs` 会**实测提示条的行数与宽度**（`toast=true(1 行/197px)`），再撞一次就直接 FAIL。

**工程**

- `tools/check_panel_ui.mjs`：新增提示条断言；把「系统代理挂了导致的 `ERR_PROXY_CONNECTION_FAILED`」从页面报错里过滤掉（那是环境噪声，不是面板问题），并且只在真正连本地 7788 失败时才计一条。
- 自检脚本跑完会自动还原 `data/library.json`（上一版会真的把测试条目留在库里）。

## [0.14] — 2026-11-05

**改**（改名 TIARA + 不再要求用户装 Node + 切季提速 + 行内追番）

- **改名**：`小春 → TIARA`（`Xiaochun → Tiara`、`koharu → tiara`）。整项目 26 个文件、120 处，含顶栏标题、桌宠开屏与通知前缀、窗口标题、SSP `sakura.name`、两个 bat 的文件名。`tools/rename.mjs` 可重跑（默认 dry-run，`--apply` 才落盘），会跳过 `cache/.git/runtime/dist` 与日志。
  > 数据契约不动：`data/*.json` 的键名、`data/settings.json` / `state.json`、`ghost/master/` 目录名、`today.txt` 变量名全部保持原样——改的只是显示名。
- **随包 Node 运行时**：新增 `runtime/node.exe`（94 MB，自包含）+ `tools/fetch_runtime.mjs`。三个 bat 优先用它，其次系统 PATH 上的 `node`，两者都没有就跳过重算、直接用手上那份 `today.txt`（桌宠照常能跑）。`runtime/*.exe` 在 `.gitignore` 里，不进仓库。
- **切季提速**：`fetchSeason()` 原来按 20 条/页串行抓 12 页，一季 16–21 秒；改成「第 1 页算总数 → 其余页并发抓（默认 4 路，上限 6）」，单页失败不影响整季。实测 `2025Q3 3.9s / 240 部`、`2026Q1 3.0s / 234 部`。
- **二级缓存 + 预热**：`lib/season-cache.mjs` 加进程内 10 分钟内存缓存（命中 5–70 ms）；`server.mjs` 启动后串行预热「当前季 + 前后各一季」，没缓存才去拉，日志 `预热 2026Q4：167 部 / 6.2s`。
- **本季表行内追番**：不用再勾选 + 顶部按钮两步。未追的行直接一个 `+ 追` 按钮（`POST /api/season/apply`，会记下 `track_from`）；在追的行就地显示 `已看 X/Y` + `−` `+` `×` + 时刻输入框。操作列从 168px 收到 132px。
- **表头吸顶**：本季表 `th { position: sticky; top: 0 }`，往下滚一屏还能看见列名。

**工程**
- `tools/check_panel_ui.mjs` 增加「行内追番」断言（点 `+ 追` → 等 3 秒 → 该行变成进度控件 → 点 `×` 收回），输出 `PASS … / 记一话 / 行内追番 都正常`。
- `停止TIARA.bat` 改成读 `cache/panel_port.txt` 拿真实端口（7788 被占时会回退到 7789），不再硬编码。
- 单测 43 例、`doctor` 全绿；`data/library.json` 在 UI 自检里被加过条目，已回滚到 HEAD。

## [0.13] — 2026-11-04

**修**（一轮全项目体检找出来的坑）

- **并发写库会丢数据**（最严重）：`/api/progress` 等接口是「读 `library.json` → 改 → 写回」，两个请求同时进来时后写的会把先写的覆盖掉。实测并发点 10 次只落 1 次。现在所有写接口串同一个队列（`withWriteLock`），实测 10 次并发全部落盘。
- **大请求体会把连接打断**：以前超过 64KB 的 body 直接 `req.destroy()`，前端只看到 `fetch failed`；改成读完丢弃并回 `413 {"error":"body too large"}`。
- **坏季度把接口打成 500**：`/api/season?q=xxxx` 现在回 `400` 并说明「季度写成 2026Q4 这种」，不再抛异常。
- **恢复备份的路径校验**：`/api/restore` 除了名字白名单，还要求这份备份真的在 `/api/backups` 列表里，传别的名字回 404 并列出可用备份。
- **`library.json` 坏了时的提示**：`/api/state` 不再只丢一句 JSON 解析错误，会带上「面板底栏『恢复上一版』可以回滚」的 hint。
- **`tools/sync_bangumi.mjs` 开头有 BOM**，`node --check` 直接报语法错；已去掉 BOM。
- **进度标签语义打架**：「剩余话数」和「落后话数」是两个数，以前都写「差 N」。现在卡片写「19/24 · 剩 5 话」，比按开播日算的进度少看时才追加「落后 N」。
- **页面 `favicon` 404**：加了个内联 SVG 图标，控制台不再报警。
- **空操作也写盘**：`POST /api/progress` 传 `delta:0`、或连点到话数上限，以前照样写 `library.json` + 留备份 + 记历史 + 重算 `today.txt`；现在直接回 `{changed:false}`，不落盘。

**改**
- **面板默认页签改成「本周」**（周历板更好扫），与 VSCode 插件 daily-anime 的用法一致；文档同步。
- 本周页只列在追、且不足 6 部时，板子下面补一句「想看整季排片就勾上『连本季一起看』」，免得看着像坏了。
- `tools/check_panel_ui.mjs` 升级成真正的体检：收集页面里的未捕获异常与 `console.error`，并走一遍「本周七列 / 记一话 → 撤回」；有报错就 FAIL。
- `cache/` 清掉 63 个临时浏览器 profile（约 596MB）。

## [0.12] — 2026-11-04

**改**（面板重做成深色周历板 + 封面）

- **整站深色重画**：`#0e1116` 底、卡片式分区、细描边、衬线标题；顶栏 sticky + 毛玻璃。原来那套「米色纸感 + 大字」全部换掉。
- **「本周」变成七列周历板**（参考 VSCode 插件 daily-anime 的排布）：一天一列、天头 `周X · 今天 · N 部`；一部一张卡（**封面** + 时刻 + 名字 + 进度条 + 悬停 `−` `+` `×`）。今天那列红色描边，非在追的条目降透明度并标「本季」。
- **封面**：`lib/bgm.mjs` 的 `subjectMeta()` 抽出 `images.grid / images.small`，存进 `data/season/<季度>.json`；`/api/state` 新增 `images` 映射，前端缺图时退化成首字方块。
- **「本季」变六列真表格**：`勾选 / 封面 / 番名(+首播日·标签) / 话数 / 评分 / 状态·时刻`，按放送日分组，行高压到 60px 出头，一屏能看到十几部。
- **「今天」两栏**：左侧 `今天放送` 宽行 + `接下来` 三天卡片，右侧摘要栏（在追 / 待补完 / 这周柱图 / TIARA说 / 今日一句）。
- **修「切换制式 / 同步后永远卡在读缓存」**：`loadSeason()` 只在有数据时重画；切换 tab 时按需拉取；同步/设置改动后统一 `refresh()`，不再把 `seasonBody` 停在骨架屏。

**工程**
- `panel/index.html` 整文件重写（约 950 行原生 JS，无构建）。
- 开季缓存 `tools/season.mjs --q <季度> --refresh` 现在会写出带 `image` 的新缓存；旧缓存（无 image）会自动重拉一次。
- `/api/state` 增加 `images`；失败时静默降级，不影响主流程。

## [0.11] — 2026-11-04

**改**（面板整体重画 + 桌宠只显示在追的）

- **面板改成整页宽表格**：最大 1180px 居中，三页签 `今天 / 本周 / 本季`，左侧主区是表格、右侧 296px 侧栏放「在追 / 这周 / TIARA说 / 今日一句」。原来那套 372px 窄卡片 + 页面里再画一个立绘的布局全部删掉——**页面上不再出现第二个桌宠**，也不再有大片空白。
- **「今天」页补上「接下来三天」**：今天没番时页面上半部分不再是空的，直接给往后三天的在追排片。
- **桌宠的番组表只列在追的番**：`w{d}_{i}_mine` 由 `build_today.mjs` 按 `watching[]` 标记，Pet 只渲染 `mine=1` 的行；一部都没在追时显示「接下来三天没有你在追的番」。
- 参考 [yuc.wiki](https://yuc.wiki/) 的信息密度：一行一部、时间列等宽、天头分段、`—` 表示时刻未定、不做卡片堆叠。

**工程**
- `lib/today.mjs` 的 `allShows()` 每条加 `mine` 字段；`tools/build_today.mjs` 多写 `w{d}_{i}_mine`。
- `panel/index.html` 重写（约 900 行，原生 JS，无构建步骤）；`PET_POPUP_SHOT=1` 启动桌宠可重出弹层截图 `cache/pet_popup.png`。

## [0.10] — 2026-11-04

**改**（这版只做「能读」，不动数据）

- **面板番组表改成真表格**：原来「本周排片」是 `时间跨度 + 前 3 部 + 等 N 部（M 部时间未定）` 拼出来的一长串，现在是一天一段、**一部一行**的表格——`.thead` 表头（时间 / 番名 / 进度）+ `.trow` 行，列宽固定、隔行浅底、今天的天头红字。默认只列在追的番，天头右侧「连本季一起看」把本季放送表也摊开；一天超过 5 部折叠成「还有 N 部 · 点开看全部」。状态记在 `localStorage`（`kx.weekAll` / `kx.weekOpen`）。
- **今日 / 在追 / 待补完 也用同一套表格**：时间列（30 小时制下 `25:00`）、番名列（下面一行小字「已看 3/12 · 差 9 · 待播」+ 进度条）、右侧 `−` `+` `×` 操作列；原来的角标不再和文字重复。
- **桌宠气泡跟着收**：原来今天没番时会把整周排片拼成「周一 23:00 A、22:30 B、…」一坨，现在固定为 `今天` + `接下来` 三天——每天一条天头（`明天 / 周五`，右边「N 部」）+ 一部一行，超过 5 部折叠成「还有 N 部，在网页面板里看全表」。
- **本季番剧页签也用同一套表格**：`放送日 / 番名 / 状态` 三列，一行一部，勾选框在最左；番名下面一行小字写「话数 · 首播日 · 评分 · 类型」，不再堆成两三行。
- 没写开播时刻的番，时间列显示 `—`，不再摆一排 `--:--`。
- 面板空态文案改了：今天没番时提示「去「本季番剧」挑几部，或者给在追的补上开播时刻」，不再讲 `weekday` 空不空。

**工程**

- `Pet.cs` 新增 `DayBar(label, n)`、`TimeCell()`、`SnapshotElement()`；环境变量 `PET_POPUP_SHOT=1` 启动时会把「番组表」弹层的版式渲染成 `cache/pet_popup.png`（验版式用，不影响正常使用）。

## [0.9] — 2026-11-04

**新增**

- **本季番剧表（选番入口）**：面板新增「本季番剧」页签。`fetchSeason()` 按季度拉 Bangumi 全量新番（`/v0/search/subjects`，167 部量级），缓存到 `data/season/<季度>.json`（12 小时）；表格支持只看 TV、隐藏已在追、按放送日/评分/名字排序、行内搜索，勾选后「加入在追」一次写库（`POST /api/season/apply`），带 `track_from`。见 §8.3。
- **放送星期自动补齐**：搜索接口本身不带星期，`fetchSeason()` 只对这个季度**缺星期**的条目补拉详情，从 infobox 的「放送星期」解析；失败就显示「星期未定」，不猜。`POST /api/season/subject` 可单部补拉。
- **就地补时刻**：本季表里点时刻那一格，填 `HH:MM` 就写进你自己的 `library.json`（`POST /api/season/time`），不动 Bangumi 缓存。Bangumi 没有放送时刻，这是唯一能精确到点的路。
- **`track_from`**：新加进在追的番记下入坑日期，「第几话该到了」从这天开始算，不会一进来就显示「差 9 话」；`expectedEpisode()` 现在会跳过 `skipped_weeks` 里的休播周。
- **追番统计**：`GET /api/stats` + 面板「本地数据」区，连续追番天数 / 本周话数 / 累计话数 / 近 14 天柱图（纯 DOM，没有图表库）。
- **导出**：`GET /api/export?fmt=ics` 生成日历（每个放送日一条 RRULE 周重复），`?fmt=md` 生成 Markdown 周表；面板底部两个按钮直接下载。
- **通知**：桌宠的开播提醒额外弹一条 Windows 托盘气泡通知；面板在标签页后台时也会发浏览器通知（需你点一次允许）。
- **同步预览**：面板「同步」改成先跑 `dry_run` 预览会改哪几部，弹窗确认后才落盘。
- **账号面板**：底部「账号」填 Bangumi 用户名 / 私有 token / 代理，写 `data/bgm.json`（token 只显示掩码）。
- **首次引导**：库里一部番都没有时，打开面板会弹一次三步引导，之后用 `localStorage` 记住不再打扰。

**修**

- `lib/bgm.mjs` 的 `httpGet` 重构成 `httpRequest(method, url, opts)`，支持 POST 与代理隧道；收藏列表（`/v0/users/-/collections`）之前只能读不能写，现在会带 token 走。
- 面板本周排片：`time_cst` 为空的条目不再把 `--:--` 当成最早的一档排在最前，改为排最后并计入「N 部时间未定」。
- `server.mjs` 的 `apiSeasonApply` 同时接受 `add: [id]` 与 `items: [{id}]` 两种载荷（命令行与面板各用一套）。
- `tools/doctor.mjs` 新增 `data/bgm.json`（账号/token/代理）与 `data/season/`（缓存份数与新鲜度）两项检查，缺文件只 warn 不 error。

## [0.8] — 2026-11-04

**新增**

- **星期表自动补全**：`mergeLibrary` 新增第三参 `{ weekday: 'watching' | 'all' }`，把 Bangumi 当季放送表按星期写进 `library.json` 的 `weekday`（已存在的不重复插）；CLI 加 `--weekday-all`，`POST /api/sync` 认 `?weekday=all`。默认 `watching` 只补「在追 + 收藏」的少数几部。见 §5.5。
- **今日清单与放送表分家**：`buildToday()` 把当天的条目拆成 `today`（自己在追的）和 `side`（本季同档、还没追的）；面板「今天」只列前者，后者收进可折叠的「本季同档 N 部」。
- **桌宠尺寸并入偏好文件**：`pet_scale` 从 `state.json` 挪到 `data/settings.json`，面板底栏新增「尺寸」下拉（70%–200%）；桌宠启动时先读 settings，`PET_SCALE` 环境变量仍可临时覆盖。`/api/settings` 现在同时管 `clock` 与 `pet_scale`。
- **一键追番**：「本季同档」里的番变成一排小标签（`?side=open` 可直接展开看），点一下就进「在追」，名字和星期从星期表继承；在追列表每行右侧的 `×` 把它退回本季同档。对应 `POST /api/watch`。
- **改尺寸不用重启桌宠**：桌宠每 4 秒看一眼 `data/settings.json`，`pet_scale` 变了就以底部中点为锚点重排，并说一句「大小换成 150% 了」。
- **面板改数据，桌宠自己跟上**：同一个 4 秒轮询也会看 `ghost/master/today.txt` 的修改时间；面板点了 `+`/`−`、同步或恢复备份后，桌宠直接重载数据并说一句「数据更新了」，不用再去右键「重算今日数据」。

**修**

- `tools/build_pet.mjs` 给 csc 加 `/codepage:65001`：`Pet.cs` 是无 BOM 的 UTF-8，不指定的话菜单里的中文会按系统 ANSI 编译成乱码。
- 面板底栏加上「尺寸」后，`.panel-foot` 的 `flex-wrap` 会把提示文字挤到第二行——补 `.scale-wrap` / `.scale-sel` 样式让三件控件保持一行。
- `server.mjs` 的 `rebuildToday()` 现在串起三份产物：`build_today` → `build_ghost` → `build_yaya`。以前在面板点了 `+`/`−`，`ghost-yaya/master/today.json` 不会跟着更新，SSP 里的到点提醒会拿到旧数据。
- `tools/doctor.mjs`：「桌宠尺寸」改从 `data/settings.json` 读（之前还在看 `state.json`），并新增「YAYA 产物」一致性检查（`ghost-yaya` 的 `today.json` 比 `data/today.json` 旧超过 1 小时就提醒重跑）。
- `tools/pack_ssp.mjs --yaya` 之前会覆盖成 `dist/TIARA-ssp.zip`：改成按版本自动命名（`TIARA-yaya.zip` / `TIARA-ssp.zip`），并把 `YAYA` 开关的声明提到 `OUT` 之前（否则 `--yaya` 会撞上 TDZ 直接报错）。

**修**

- 面板本周排片不再把一整季的名字糊成一行：改成「时间跨度 + 前 3 部 + 等 N 部（M 部时间未定）」；没写时间的条目排到最后并标「不定期」，不再渲染成 `--:--` 抢占第一个位置。
- 放送表条目没有进度记录时，徽标从误导性的「已看齐」改成「未开始」。
- `server.mjs` 的 `/api/state` 补 `side` 字段；面板 `data/settings.json` 与 `state.json` 的读写口径统一。

## [0.7] — 2026-11-04

**新增**

- 时间显示制式：**30 小时制（默认）/ 24 小时制**可切换。`lib/today.mjs` 的 `displayClock()` 做换算（05:00 之前算前一天深夜，01:00 → 25:00，星期回退一天），`buildToday()` 给每条数据附 `time_disp` / `weekday_disp`，原字段保留不动。见 §5.6。
- 面板顶栏 `30h / 24h` 切换按钮；`GET/POST /api/settings`；偏好存 `data/settings.json`。30 小时制下「本周排片」会重新按换算后的星期分桶（周四 01:00 归到周三 25:00 那行）。
- 桌宠尺寸自定义：右键 → 桌宠尺寸 → 70% / 85% / 100% / 125% / 150%；窗口与立绘同步缩放、以底部中点为准，存 `state.json` 的 `pet_scale`。调试用 `PET_SCALE=1.25` 可临时预览（不写回文件）。
- Bangumi 真接口首次跑通：`/calendar` 是 `{0..6: {...}}` 形态（0 = 周一），`fetchCalendar` 里做了归一化，经本地代理 0.5 秒拿回 7 天 114 部。

**修**

- `data/settings.json` 管用户偏好（`clock` + `pet_scale`），`state.json` 管瞬时状态（位置 / 层级 / 已提醒），两个文件各管一件事。
- 桌宠「本周排片」用 `w{d}_1_wd_disp` 决定行标签，30 小时制下深夜档不再显示在原星期下。
- `tools/doctor.mjs` 增加「时间制式」「桌宠尺寸」两项检查。

## [0.6] — 2026-11-04

**新增**

- YAYA 版 SSP 人格：`ghost-yaya/master/{yaya.txt,basis.dic,today.json}`，`OnSecondChange` 每 30 秒比对 `all_shows`，到点念一句提醒；同一话靠 `yayaDone` 去重。见 §10.2。
- `tools/build_yaya.mjs`：从 `data/talks.json` 生成 `basis.dic`，带 `--check` 静态检查（段落配对、引号闭合、`%()` 里的裸引号）。
- `lib/today.mjs` 新增 `allShows()`：合并在追列表与手写整周排片表，去重后按周几 + 时间排序；`data/today.json` 与 YAYA 侧共用这份数据。
- `data/today.json` 的 `all_shows`（含 `weekday` / `min` / `time_cst` / `ep_expected`），YAYA 直接 `FREADJSON`。
- `pack_ssp.mjs --yaya`：打 YAYA 版包（`dist/TIARA-yaya.zip`），安装说明随包切换。
- 桌面：启动脚本顺带跑 `build_yaya`。
- 测试：`test/yaya.test.mjs` 8 例（转义、候选行、时间解析、字典静态检查、`allShows` 合并）。

## [0.5] — 2026-11-04

**新增**

- 桌宠：托盘图标（显示/隐藏、番组表、网页、退出）、开机自启（`HKCU\…\Run`）、启动时后台自动同步（缓存 >12 小时才跑）。
- 桌宠：提醒补发——启动头两分钟窗口放宽到 6 小时，关机期间错过的开播提醒会补一次；已提醒键写进 `state.json`，重启不重复。
- 桌宠：点「打开网页番组表」会先探 7788–7799 的 `/api/health`，再退回 `cache/panel_port.txt`，端口变了也能打开。
- 面板：搜索/筛选框（`Esc` / `×` 清空，输入时不吃快捷键）、底部「恢复上一版」、累计话数与最近一笔进度。
- 服务：`/api/history`、`/api/backups`、`POST /api/restore`；写库前留 `data/library.json.bak` + `data/backups/` 滚动 5 份 + `data/history.jsonl`。
- 服务：端口被占自动从 7788 试到 7799，真实端口写 `cache/panel_port.txt`。
- `doctor` 扩展：`state.json`、备份/历史、7788–7799 实际端口、单测文件。

**修**

- **跨站写保护**：所有写接口校验 `Origin`，非本机来源 403，避免乱逛的网页改你的番组表。
- 面板顶栏「同步」按钮排版（不再折成两行）；`apiVersion` 不再列不存在的 `goods.txt`。
- 桌宠呼吸动画 40ms → 50ms（20fps 足够），隐藏/最小化时保持 4Hz，省一点 CPU。

## [0.4] — 2026-11-04

**新增**

- `lib/bgm.mjs` + `tools/sync_bangumi.mjs`：Bangumi 放送表 / 收藏同步，支持 HTTP(S) 代理（CONNECT 隧道）、`--dry-run`、`--take-progress`、`--fixture` 离线样本；写盘前自动 `.bak`。详见 §5.5。
- `POST /api/sync`；面板底部「同步 Bangumi」按钮；桌宠右键「同步 Bangumi」。
- 单测：`test/bgm.test.mjs`（合并规则 + chunked 解析）、`test/today.test.mjs`（跨日 / `25:30` / 空 weekday / 落后判定），共 18 例，`node --test "test/*.test.mjs"`。
- 台词池 `refresh` / `refreshFail` / `syncWait` / `syncOk` / `syncFail`。
- `words.txt` 从 6 段扩到 13 段：`自己紹介`、`OnNadeNade`、`OnMouseWheel`、`朝/昼/夜`、`積み`；`OnBoot` 改成多条轮换；新增台词池 `selfIntro` / `nade` / `wheel` / `morning` / `noon` / `evening` / `catchup`。
- 窗口层级：右键「窗口层级」→ 置顶 / 普通 / 沉底（`SetWindowPos` 的 `HWND_TOPMOST` / `HWND_NOTOPMOST` / `HWND_BOTTOM`），状态存 `data/state.json`。
- `tools/test_drag.ps1`：拖动回归脚本（模拟按下—移动—松开，比对窗口位移）。

**修**

- **拖动手感**：原来用「窗口内坐标」算位移，窗口一动参考系就跟着动，鼠标越拖越追不上。改成 `GetCursorPos` 的屏幕坐标 + DIP 缩放换算，拖动期间暂停呼吸动画。
- 拖动测试：`moved=-384 maxErr=0`（旧实现 `-144 / 240`）。
- `expectedEpisode` 单独调用时自己算「本周已播」集合，不再依赖调用方传参。

## [0.3] — 2026-11-04

**新增**

- `tools/doctor.mjs`：一键自检（文件 / 数据 / 立绘 / 端口 / 桌宠）。
- `停止TIARA.bat`；`打开番组表.bat` 改成「已在跑就复用」，不再起第二个服务。
- 桌宠：到点提醒（开播后 90 秒窗口）、跨日自动重算、位置记忆（`data/state.json`）、立绘内存缓存、透明区域点击穿透、`lateNight` / `remind` / `midnight` 台词。
- 面板：`在追 N 部` 全量列表（带 `−` `+`）、开播前提醒气泡、键盘（P / Esc / S）、面板内滚动与底部不再重叠。
- `today.txt` 新增 `show{n}_unix`（提醒用）。
- 台词池新增 `remind`、`midnight`，`lateNight` 加一句。

**修**

- `server.mjs`：路由去掉 query string（`/?v=3` 不再 404）。
- `library.json`：`weekday` 与 `watching` 的名字对齐（`doctor` 发现的不一致）。
- 表情缺图由「一律退回 normal」改成「就近回退」（`sleepy→sad`、`think→normal`）。

**仍待办**：见 §13。

## [0.2] — 2026-11-03

- 面板重写：今日 / 落后 / 待补完 / 本周排片 / 今日一句 / 本地数据六个分区。
- `+` `−` 记账接口 `/api/progress`。

## [0.1]
- 桌宠 + `today.txt` + 生成脚本跑通。

---
