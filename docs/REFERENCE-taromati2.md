# 参考研究：橘花2 修改增强版（Taromati2Enh）

> 对象：`D:\BaiduNetdiskDownload\伪春菜\伪春菜_橘花2修改增强版`（SSP 平台人格包，8 极原作 + fanyang 整合，2009–2013 年间持续更新）
> 结论定位：**它不是"另一个桌宠"，而是一套把「人格」当软件工程做的完整范式**。可借鉴的是结构与机制，不是它的体量。

---

## 一、先看规模（这决定了哪些能学、哪些不能）

| 维度 | 数字 |
| --- | --- |
| 总体积 | `ghost/` 303 MB（其中立绘 163 MB、词典与数据 138 MB） |
| 人格文件 | 18 207 个（`ghost/Taromati2Enh`） |
| 词典模块 | **58 个 `dic`**（`mydic/` 64 个文件，2.4 MB；另有 `mydicen` 59 个、`mydicjp` 13 个语言副本） |
| 换装 | **54 套 shell**（`shell/` 下每个目录一套服装，每套 170–2 050 张图） |
| 立绘 | 主服装 38 个 `surface` 块 + 170 张图；`home` 一套 2 050 张 |
| 外部能力 | `saori/` 60 个插件（截图 `CameraDll`、TTS、SQLite `sqlori`、音频 `mciaudior`、进程、CPUID、简繁转换…） |
| 持久状态 | `yaya_variable.cfg` 252 个变量（好感 253、心情 105、橘花币 5 200…） |
| 自动备份 | `bakeup/` 按日期整目录快照（420 个文件） |
| 更新清单 | `updates.txt` 1 381 行「路径 + md5 + size」 |
| 用户手册 | 说明文件里 20+ 条 Q&A（Q0.3 → Q2.5） |

对照我们的项目：`panel 1 101 行 + server 936 行 + Pet.cs 1 898 行`，立绘 4 张，词典 0 个（话术在 `talks.json`）。

---

## 二、八个真正值得学的地方

### 1. 立绘是「组件」，不是「整张图」——`surfaces.txt`

它每个 `surface` 块长这样（`shell/master/surfaces.txt`，1 231 行）：

```
surface0
{
0interval,never
0pattern0,1001,5,overlay,110,50
0pattern1,1002,5,overlay,110,50
1interval,talk,4
1pattern0,1001,5,overlay,110,50
...
collision0,94,4,197,46,Head
collision1,125,75,165,91,Face
collision2,124,109,151,130,Bust
collision3,104,168,141,190,Hand
point.centerx,132
point.centery,153
}
```

统计结果：**38 个 surface 块 / 312 个 `overlay` 叠加 / 52 个 `alternativestart` 随机变体 / 118 个碰撞矩形**；`interval` 分 `never(104) ｜ talk(31) ｜ sometimes(24) ｜ runonce(2) ｜ rarely(2)`。

三个要点：

- **一张底图 + 眼睛/嘴/腮红等零件叠加**，组合出 38 种状态，而不是画 38 张全身像；
- **`interval,talk`** 让「说话口型」只在说话时叠上去——不需要单独的 `talk.png`；
- **碰撞区自带名字**（`Head/Face/Bust/Hand/Tail`），脚本里 `Reference4` 直接拿到部位名，不用自己算坐标。

> 我们的现状：4 张整图（`normal / smile / sad / talk`），缺 `sleepy / think` 只能回退到 `normal`（`Pet.FaceImage` 的降级），`talk.png` 是一张静态口型。
> **这是最值得抄的一条**：把立绘拆成「底图 + 眼睛层 + 嘴层 + 腮红层」，用一张 `faces.json` 描述组合，就能用 10 张小图表达 30+ 表情，还顺手解决缺图问题。

### 2. 功能按模块拆词典，加载表就是架构图

`yaya.txt` 只有 58 行有意义的内容，每行一个模块，**注释就是功能清单**：

```
dic, mydic\OnCalendar.dic   //日历
dic, mydic\clock.dic        //时间，整点报时
dic, mydic\rpg.dic          //养成系统
dic, mydic\internet.dic     //网络，天气，邮件，RSS
dic, mydic\games.dic        //游戏(OX，21点，猜拳，猜数字，双色球)
...
```

- 加载顺序 = 优先级（越后越能覆盖后者的事件处理）；
- 一个功能一个文件，坏一个不至于全崩；
- 「有哪些功能」= 看这张表，不用读代码。

> 我们的现状：`server.mjs` 936 行单文件，路由和业务混在一起；`lib/` 已经有 `today.mjs / bgm.mjs / season-cache.mjs` 的分层，但 server 还没拆。
> **可落地**：把 server 的路由按域拆成 `server/routes/{state,progress,season,sync,export}.mjs`，主文件只留「注册 + 队列 + 静态托管」。

### 3. 状态持久化 + 按日期快照备份

- `yaya_variable.cfg`：252 个变量，格式 `名字,"值",,`，连 `lastTalk` 的完整台词都存；
- `bakeup/2026-3-28/` 里是 `yaya.txt + yaya_variable.cfg + tama.txt + mydic/ + profile/` —— **每次备份是一个可直接覆盖回去的完整人格快照**；
- 说明文件 Q2.5 直接教用户「数据清零了就去 `bakeup` 找最新日期覆盖」。

> 我们的现状：`data/backups/` 滚动 5 份 `library.json`，粒度是「一份库」，坏掉 `settings.json` / `state.json` / `history.jsonl` 就没救了。
> **可落地**：备份改成「按日期的整目录快照」（`data/backups/2026-11-04/`，含 library/settings/state/history），面板底栏「恢复上一版」列出日期而不是文件名。

### 4. 时间事件是分级的，动画有冷却计数器

`clock.dic` 里同时挂了三种时间事件：

```
OnSecondChange   // 每秒：游戏 tick、语音识别轮询
OnMinuteChange   // 每分钟：闹钟检查 AlarmMonitor
OnHourChange     // 每小时：整点报时
```

而且每个交互都有**冷却计数器**：

```
if headpatflag == 1
{
    if headpattime >= 30 { headpatcount = 0  headpatflag = 0  headpattime = 0 }
    else { headpattime++ }
}
```

—— 摸头后 30 个 tick 内不再触发，并把「连续摸了几次」计入 `headpatcount`。

> 我们的现状：`Pet.cs` 一个 33 ms 的 `DispatcherTimer` 全包（呼吸动画 + 提醒 + 4 秒轮询 `today.txt`）。
> **可落地**：拆成「渲染 33 ms / 逻辑 1 s / 提醒 60 s」三条计时；摸头加 800 ms 冷却 + 今日计数（存 `data/state.json`）。

### 5. 区域化交互 + 递进台词（这是"人格感"的来源）

`aya_mouse.dic` 里，鼠标停在某区累计 32 个 tick 才触发，且台词按「第几次」递进：

```
if reference4 == "Head"
{
    _talk = "TalkSakuraHeadPat.%(GetPhase).%(headpatcount)"
    if ISFUNC(_talk) == 1 { EVAL(_talk)  headpatcount++ }
    else { EVAL("TalkSakuraHeadPat.%(GetPhase)") }   // 没有第 N 句就回退通用句
}
```

`ISFUNC` + 动态函数名 + 回退，用一个机制同时实现：**部位区分 / 次数递进 / 情绪阶段（GetPhase）/ 缺省降级**。

> 我们的现状：一个 head 矩形 → 8 句随机吐槽（`talks.nade`），第二次摸头和第一次没区别。
> **可落地**：`talks.json` 的 `nade` 改成 `nade.head[] / nade.face[] / nade.hand[]`，每区前 3 次各一句、之后回退随机；把「今天被摸了几次」写进 `state.json`，桌宠读它决定语气。

### 6. 增量更新靠清单，不靠整包重下

`updates.txt` 1 381 行，全是 `file,<相对路径>,<md5>,size=<字节>`。SSP 拿本地文件对哈希，只下载变化的。

> 我们的现状：更新 = git pull 或重新解压（`dist/` 里 777 KB 的 SSP 包每次全量重打）。
> **可落地**：给 `dist/` 产物生成 `manifest.json`（path + sha256 + size），`tools/doctor.mjs` 顺手校验「产物是否与源一致」，将来做「检查更新」也有依据。

### 7. 多语言 = 多套词典目录，切换只换加载集

`lang_switch_descript.txt` 列出三套 SHIORI（`yaya.dll / yaya_jp.dll / li.dll`），`mydicen/ mydicjp/` 是同一批模块的语言副本，`lang_switch_save.txt` 记住上次选择。

> 我们的现状：中文硬编码在 `talks.json` 与 `Pet.cs` 的字面量里。
> **可落地**（低优先）：`talks.zh.json / talks.ja.json`，`Pet` 启动按 `settings.lang` 选一份；ghost 的 `words.txt` 同理。

### 8. 用户手册就是产品的一部分

说明文件不是"功能介绍"，是**故障排查手册**：Q0.3「对话框怎么出现」、Q1.6「词典语法错误导致启动不了 → 用 tama.exe 拖 yaya.dll 看报错码」、Q2.5「数据清零怎么恢复」、Q2.4「图标不显示 → 拷 imageres.dll」。

> 我们的 README 有 672 行，但 §12 排错只有 3 条。**可落地**：把这一轮审计遇到的真实故障（端口被占、备份恢复、库坏了、缓存脏了）写成"症状 → 原因 → 一句话解决"的表，比写十段架构说明有用。

---

## 三、不建议照搬的

| 它的做法 | 为什么不学 |
| --- | --- |
| 300 MB 立绘、54 套服装 | 我们用 ComfyUI 补差分都因为画风不一致放弃了；先把「组件化」做对，再谈服装数量 |
| 单文件 234 KB 的 `aya_aitalk.dic` | 巨型词典难以维护、diff 不可读；我们的 `talks.json` 分池已经更清晰 |
| 60 个 SAORI DLL（含 47 MB 的 `icon.dll`） | 二进制插件不可审计、跨架构易挂；我们用 Node 侧车（`lib/bgm.mjs`）+ 标准库覆盖同样能力 |
| 把 API key 明文写进变量（`tuling123` 那个 `key=`） | 我们的 token 走 `data/bgm.json` + 掩码显示，这条别退回去 |
| 用 `.exe` 分发 + 手动覆盖式更新 | 我们有 git 与 `build_*.mjs`，可复现构建更好 |

---

## 四、如果只做三件事（建议顺序）

| 优先级 | 事项 | 具体做法 | 预估 |
| --- | --- | --- | --- |
| **P0** | 立绘组件化 | `shell/master/` 拆成 `base.png + eyes_{open,half,closed}.png + mouth_{0,1}.png + blush.png`；新增 `shell/faces.json` 描述「表情 → 图层组合」；`Pet.FaceImage` 改成拼三层 `Image`；`talk` 状态改为切嘴层 | 半天～1 天 |
| **P1** | 分区交互 + 冷却 | `Pet.cs` 命中区分 Head/Face/Hand（用 `faces.json` 里的归一化矩形）；停留 300 ms 触发；`talks.nade` 分区 + 前 3 次递进；次数存 `state.json`；800 ms 冷却 | 半天 |
| **P1** | 按日期快照备份 | `data/backups/2026-11-04/{library,settings,state}.json + history.jsonl`；保留 14 天；面板「恢复上一版」按日期列 | 2～3 小时 |

顺带值得一提但可以缓的：`server.mjs` 拆路由、`dist/manifest.json` 校验、`talks` 多语言。

---

## 五、一句话总结

它把「摸头」拆成了**碰撞区 + 停留判定 + 冷却计数 + 递进台词 + 缺省回退**五件事，把「立绘」拆成了**底图 + 图层 + 合成规则**，把「记忆」拆成了**变量表 + 日期快照**——**它的强项全是"结构化"，不是"堆内容"**。

我们缺的不是功能数量，而是这套结构：立绘的图层结构、交互的分区结构、状态的备份结构。把这三样补上，TIARA的"人格感"会有一次质变，而代码量增加得很有限。
