# 番组管家伪春菜 · 开工准备清单

> 目标：做一个「类 Bangumi 网站」的桌面宠物 —— 能报今日放送、能看追番进度、能一键 +1、
> 能吐槽新番，并且是**伪春菜（伺か）形态**的人格，而不是一个网页壳子。
> 本文件 = 物料清单 + 技术决策 + 里程碑。开工前只需要照单勾选。

---

## 0. 需求先钉死（默认范围，不同意再改）

| 能力 | 说明 | 优先级 |
|---|---|---|
| 今日放送 | 按中国时区报「今天星期几有哪些番、几点、第几话」 | P0 |
| 我的追番 | 拉「在看」收藏列表，报进度（看到第几话 / 共几话） | P0 |
| 一键 +1 | 对某部番 +1 进度，写回 Bangumi | P0 |
| 角色反应 | 进度变化 / 新番开播 / 深夜 / 久未互动 → 不同表情台词 | P0 |
| 周历面板 | 一个可点的周历卡片（7 天番组表） | P1 |
| 搜索结果 | 关键词搜番，看评分、简介、封面 | P1 |
| 提醒 | 追的番更新了 / 想看的上线了 → 说话 + 气泡提醒 | P1 |
| 语音 | TTS 或预录语音（可选） | P2 |
| 网页内嵌 | 直接开浏览器看 bgm 页面（`\![open,browser,url]`） | P2 |

---

## 1. 三条技术路线（先选一条，别混着来）

### A. 正统伪春菜：SSP + 自写 SHIORI（推荐做「人格本体」）
- 本体用 **SSP**（`ssp.shillest.net`），它负责窗口、立绘、脚本解释、触摸、气泡。
- 人格逻辑用 **SHIORI DLL**（SSP 通过 SHIOLINK 调 `load/request/unload`）。
- 关键约束：**SSP 是 32 位进程 → DLL 必须 x86**。这是全项目最大的坑，先确认。
- 桥接方案（最省力）：
  `SSP → shiori_bridge.dll(x86) → http://127.0.0.1:PORT → Node 服务 → Bangumi API`
  DLL 只做「转发 + 把 JSON 变成 SakuraScript」，业务全在 Node 里写，好调试。
- 优点：真·伪春菜，能进 SSP 生态，能被 `updates2.dau` 网络更新。
- 缺点：DLL 调试无控制台；图片只能本地缓存；UI 表现力受限于立绘 + 气泡。

### B. 自研桌宠：Tauri / Electron + Live2D 或序列帧
- 透明置顶窗口 + 点击穿透 + 托盘 + 多屏 DPI，全部好做。
- 面板能做得比 SSP 漂亮一个量级（封面墙、进度条、评分圆环）。
- 缺点：不是伪春菜，没有 ghost/shell 生态，等于自己造一个平台。

### C. 混合（**最终推荐**）
- **SSP 负责人格**：立绘、触摸、台词、情绪状态机（A 路线）。
- **本地 Web 面板负责数据展示**：周历 / 追番墙 / 搜索（B 路线，用 WebView2 或默认浏览器打开 `http://127.0.0.1:PORT/panel`）。
- 两者共享一个 **Node 数据服务 + SQLite 缓存**。
- 这样：伪春菜的味道有了，Bangumi 网站的信息密度也有了，而且两边可以独立开发、独立崩。

---

## 2. 数据源准备（这是全项目的命门）

### 2.1 账号侧
- [ ] Bangumi 账号（`bgm.tv`）
- [ ] 注册第三方应用：`https://bgm.tv/dev/apps` → 拿 `client_id` / `client_secret`，回调填 `http://127.0.0.1:PORT/callback`
- [ ] 走 OAuth2 拿 `access_token` / `refresh_token`（写操作必须，读「我的收藏」基本也必须）
- [ ] token 落地：Windows DPAPI 加密存 `%LOCALAPPDATA%`，**不要**明文进仓库

### 2.2 接口（以官方文档 `github.com/bangumi/api` 为准，下列为实测/常用）

公共读，无需 token：
```
GET  https://api.bgm.tv/calendar                       # 每日放送，按 JST 周几分组
GET  https://api.bgm.tv/v0/subjects/{id}               # 条目详情（含 rating / eps 总数）
GET  https://api.bgm.tv/v0/subjects/{id}/characters
GET  https://api.bgm.tv/v0/subjects/{id}/persons
GET  https://api.bgm.tv/v0/episodes?subject_id={id}&type=0
POST https://api.bgm.tv/v0/search/subjects             # body: {keyword, filter:{type:[2]}}
```

需要 `Authorization: Bearer <token>`：
```
GET   https://api.bgm.tv/v0/users/-/collections?subject_id={id}
GET   https://api.bgm.tv/v0/users/{username}/collections?subject_type=2&type=3&limit=50&offset=0
POST  https://api.bgm.tv/v0/users/-/collections/{subject_id}      # 改收藏：type/rate/ep_status/comment/tags/private
GET   https://api.bgm.tv/v0/users/-/collections/{subject_id}/episodes
PATCH https://api.bgm.tv/v0/users/-/collections/{subject_id}/episodes   # body: {episode_id:[2]} 标记看过
```

OAuth：
```
授权  https://bgm.tv/oauth/authorize?client_id={id}&response_type=code&redirect_uri={uri}
换票  POST https://bgm.tv/oauth/access_token   (grant_type=authorization_code)
续期  POST https://bgm.tv/oauth/access_token   (grant_type=refresh_token)
```

### 2.3 三条硬规则（踩了就 403/429，别问为什么）
1. **必须带 User-Agent**，且要能识别到你：`ukagaka-bangumi/0.1 (https://github.com/you/repo)`。
   默认的 python-requests / okhttp UA 会被直接拒。
2. **限流**：按 1 req/s 保守设计，每天放送表缓存 6 小时，收藏列表缓存 5 分钟，遇到 429 指数退避。
3. **不要每句话都请求**：桌宠会频繁说话，所有数据必须先落 SQLite，台词只读本地。

### 2.4 图片
- 封面/头像在 `lain.bgm.tv`，同样要 UA；建议**下载到 `cache/img/` 后本地引用**。
- SSP 气泡不能直接显示网络图；面板里有本地文件才能稳定渲染。

---

## 3. 环境准备（本机实测结论，2026-11-04）

| 项 | 状态 | 说明 |
|---|---|---|
| Node.js | ✅ v26.1.0 | 数据服务 / 面板首选 |
| .NET | ✅ 8.0 Runtime + WindowsDesktop 8.0 | 可写 WinForms 面板；**无 SDK**，编译 DLL 需装 SDK 或 VS |
| Git | ✅ | |
| Python | ❌ 只有 WindowsApps 占位 stub | **不要**按 Python 方案规划 |
| SSP | ❌ 未安装 | 需要下载 SSP 本体 |
| 网络到 `api.bgm.tv` | ❌ **不通** | 见下 |

### 3.1 网络：当前最大的阻塞项（已实测）
```
api.bgm.tv   -> 185.45.7.165     TCP 443 失败
bgm.tv       -> 162.125.8.1      （Dropbox 网段，明显被污染）
lain.bgm.tv  -> 173.236.212.42   （DreamHost 网段，可疑）
next.bgm.tv  -> 108.160.172.204  （Dropbox 网段）
本机 127.0.0.1:7890 无监听（系统代理 ProxyEnable=0，但注册表残留 127.0.0.1:7890）
curl --doh-url 亦失败；github.com 可通但握手 8s
```
→ 结论：**先解决出口，再谈开发**。三条路，按省事排序：
1. 起本地代理客户端（Clash/v2rayN），开 TUN 或系统代理，确认 7890 在监听 → 全局生效。
2. 自建反代（Cloudflare Worker，模板已放 `tools/bgm-proxy-worker.js`），把 `api.bgm.tv` 转发成自己的域名 → 改 hosts 或直接换 base URL。
3. 改 DNS 为 DoH（Windows 11：`netsh dns add encryption`），只解决污染、不解决封锁。

---

## 4. 素材准备（伪春菜的门面，最容易卡住的一环）

### 4.1 立绘 / Shell
- [ ] 角色 1 名，**至少 5 个表情差分**：`normal / happy / sad / surprise / sleepy`
      （番组管家建议再加 `think`（查番中）和 `point`（指周历））
- [ ] 尺寸：建议单张 512×768 或 1024×1024，PNG 透明底；SSP 会按 `surface.size` 缩放
- [ ] 眨眼帧（2 帧可省）、口型帧（可选，做语音才需要）
- [ ] Shell 目录结构：
```
shell/master/
  descript.txt          # name, type, surface.size 等元数据
  surface0.png ...      # 每张表情一个编号，编号对上台词里的 \i[n]
  collision*.png        # 可选：可点区域（摸头/摸脸）的形状遮罩
  animation.txt         # 可选：待机小动作
```
  字段细节见 [伺かのシェルの作り方](http://earlduant.github.io/ukagaka-shell-description/surfaces.html)。
- [ ] 素材来源：自绘 / 委托画师 / CC0 素材。**别拿别人的角色立绘直接用**，这是唯一会真出事的地方。

### 4.2 气泡与音效
- [ ] 气泡皮（9-slice PNG），或先用 SSP 自带
- [ ] 音效：出现、点击、新番提醒、深夜晚安（可选）

### 4.3 文字资产（比立绘更耗时间）
- [ ] 角色设定：名字、年龄感、称呼你什么、口癖 2-3 个、不能说什么
- [ ] 台词矩阵（**MVP 200 条起步**，完整 1000+），按场景分：
      `OnBoot / OnClose / 整点 / 今日放送 / 无番日 / 进度+1 / 看到一半 / 深夜 / 久未互动 / 被摸头 / 搜索失败 / 网络断`
- [ ] 情绪状态机：好感度、疲劳、追番焦虑（连续 3 天没看 → 催）

---

## 5. 工程骨架（已建好空目录）

```
伪春菜/
├── PLAN.md                     # 本文件
├── ghost/                      # 人格：descript.txt + 台词 + SHIORI 配置
├── shell/                      # 立绘 surface + collision
├── panel/                      # 周历/追番墙 Web 面板
├── tools/
│   ├── probe_bangumi.mjs       # 数据源探针（网络通了先跑这个）
│   └── bgm-proxy-worker.js     # Cloudflare Worker 反代模板
└── cache/                      # SQLite + 封面图缓存
```

---

## 6. 里程碑

| 阶段 | 内容 | 验收标准 | 预估 |
|---|---|---|---|
| **M0 探针** | `tools/probe_bangumi.mjs` 跑通 | 终端能打印「今日 12 部番 + 我在看 8 部」 | 0.5 天 |
| **M1 会说话** | SSP + 最小 ghost + 桥 DLL | 启动说「主人早，今天 12 部番」 | 2-3 天 |
| **M2 能互动** | 今日放送 / 追番 / +1 / 表情切换 | 点她能报番，说「+1」能写回 Bangumi | 3-5 天 |
| **M3 面板化** | 周历卡片 + 封面墙 + 提醒 | 本地网页能看到一周全番，封面不裂 | 3-5 天 |
| **M4 打磨** | 情绪、语音、网络更新包 | 能装成 `updates2.dau` 分发 | 看心情 |

---

## 7. 坑清单（提前知道能省一周）

1. **32 位**：SSP 是 x86，DLL 也必须 x86。用 .NET 8 写要 NativeAOT `-r win-x86`，否则加载失败且**没有任何报错**。
2. **SakuraScript 不能取返回值**：`\![execute,...]` 只发命令，拿不到 stdout。所以数据必须走 DLL，不能走外部程序。
3. **时区**：Bangumi 放送表按 JST 分组；中国要 +1 小时，跨日番（JST 25:30 = CST 次日 00:30）必须单独处理，否则「今天有什么」永远差一天。
4. **SSP 无控制台**：DLL 里所有异常都要写日志文件，否则崩了不知道原因。
5. **收藏接口的 `type`**：1=想看 2=看过 3=在看 4=搁置 5=抛弃；+1 是 `PATCH .../episodes`，不是改 `ep_status` 就完事（后者是总数）。
6. **图片防盗链**：`lain.bgm.tv` 需要 UA，且 SSP 不能直接吃网络图 → 必须本地缓存。
7. **token 过期**：access_token 有效期有限，`refresh_token` 流程必须实现，否则一周后全崩。
8. **误操作**：+1 会真的写进你的 Bangumi 账号，加二次确认（`\q[确认,Yes]`）。

---

## 8. 下一步（三选一，说一声就开工）

1. **先通网**：我给你 Cloudflare Worker 反代 + hosts 方案，10 分钟把 `api.bgm.tv` 打通。
2. **先出骨**：搭最小可跑 ghost（descript + 台词 + 占位 shell），装进 SSP 就能说话。
3. **先上面板**：跳过 SSP，直接做 Web 周历 + 追番墙，最快看到成品。

---

## 9. 纯本地模式（离线版）—— 推荐作为第一版

「纯本地」= 不请求任何 Bangumi 接口，番组数据来自仓库里的 `data/library.json`，
人格只读本地文件。这不是妥协版，**这就是伪春菜的经典形态**：SSP + ghost + shell 打成
一个压缩包，双击安装，永远不联网也不会坏。

### 9.1 直接删掉的模块（工作量砍掉一半以上）

| 联网版必须写 | 纯本地版 |
|---|---|
| OAuth2 授权 + 回调服务器 | ✗ 不需要 |
| access_token 存储 + 定时 refresh | ✗ 不需要 |
| 反代 / 代理 / DNS 处理 | ✗ 不需要（今天最大的阻塞直接消失） |
| 限流退避、429 重试、失败降级 | ✗ 不需要 |
| 缓存失效策略、SQLite 迁移 | 降级为一个 JSON 文件读写 |
| 双端时区折算 | 只保留一次（写数据时算好） |

### 9.2 但「纯本地」不等于「零逻辑」

关键约束还在：**さくらスクリプト 读不了文件**。要让桌宠说出「今天 3 部番」，
必须有东西在脚本之外读 `library.json`。三条路，按成本排：

1. **纯静态台词**（成本 0）：里々 + `ghost/master/words.txt`，只会说固定台词 +
   随机闲聊。能立刻装进 SSP 跑起来，但报不了今天的番。
2. **每日生成 + 重载**（成本 0.5 天）：Node 脚本读 `library.json` → 生成
   `ghost/master/today.txt` → 重启 SSP（或触发字典重载）。零 DLL、零 YAYA，
   画面里就是当天真实数据。缺点：数据不会在你说话的那一刻实时变。
3. **YAYA 人格**（成本 2–3 天）：YAYA 是自带语言和编译器的 SHIORI，有文件读写和
   时间函数，可以在人格内部直接解析 JSON、判断星期、按进度分支。**纯本地的最优解**，
   一旦跑通，所有逻辑都在人格里，没有外部进程。
4. ~~DLL 桥~~：纯本地时用不上，因为数据就在本地，没有「异步等网络」的需求。

### 9.3 本地数据从哪来

- **手抄**：在追 20 部以内，每季（1/4/7/10 月）花 10 分钟填一次 `weekday`，够用。
- **一次性导出**：借一台能上网的机器或手机浏览器，调一次 API 导出成 `library.json`，
  之后永远离线。导出脚本可以放在 `tools/`，但只在需要时手动跑。
- **半自动**：每季联网同步一次，平时纯离线。数据契约不变，只是换了生成者。

### 9.4 纯本地的代价（提前接受）

1. **数据会旧**：换季时新番表要手动补，这是唯一的持续成本。
2. **+1 只改本地**：不回写 Bangumi 账号。对很多人反而是优点 —— 不会误触，也不会
   因为手滑把 12 话的番标成看完。
3. **没有更新提醒**：本地没有「新一话已放出」的信号，只能靠日期推算。
4. **立绘仍是刚需**：这条在哪个版本里都躲不掉。

### 9.5 结论

**先做纯本地。** 把 `data/library.json` 定成唯一数据契约，人格只认这个文件。
以后想联网，只需要把「谁来生成这个文件」从手抄换成 API 同步 —— 上层一行都不用改。
这是分层设计唯一真正省钱的地方。
