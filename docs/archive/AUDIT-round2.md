# 阶段性体检报告 · 2026-11-04（v0.13）

体检对象：`伪春菜` 整仓库（数据层 / 面板 / 桌宠 / SSP 产物 / 命令行工具链）。
方法：静态读码 + 真实接口压测 + 浏览器自动化（Edge CDP）+ 数据一致性核对 + 产物重建。

---

## 一、结论先说

| 项 | 结果 |
| --- | --- |
| 单元测试 | **43 / 43 通过**（`node --test "test/*.test.mjs"`） |
| 自检 doctor | **✅ 可以开工**（1 条提醒：本机 bgm.tv 需代理） |
| 面板交互体检 | **PASS**：切制式 / 切页签 / 改尺寸 / 本周七列 / 记一话 全过，**页面零报错** |
| 产物重建链 | `build_today → build_ghost → build_yaya` 三份均正常 |
| 写库并发 | 修前 **10 次并发只落 1 次**，修后 **10 / 10 全落** |
| 仓库体积 | 4.0 MB（不含 cache/.git）；`cache/` 从 628 MB 清到 31.6 MB |

发现并修掉 **8 个真问题**，其中 1 个会**静默丢数据**（并发写库），1 个会把连接直接打断（大 body），其余是健壮性与体验。下面逐条给证据。

---

## 二、修掉的问题（含复现证据）

### 1. 并发写库会丢数据（严重）

`server.mjs` 的写接口是「读 `library.json` → 改 → 写回」。两个请求同时进来，后写的会把先写的覆盖掉。

复现：对一个条目并发 `POST /api/progress` 10 次（每次 +1），预期 +10。

```
修前：ep_status 18 → 19        （只落了 1 次，丢 9 次）
修后：ep_status 18 → 28        （10 次全落）
```

修法：`withWriteLock(fn)` 单条全局 Promise 队列，`apiProgress` / `apiSync` / `apiSettings` / `apiSeasonApply` / `apiSeasonTime` / `apiSeasonSubject` / `apiRestore` / `apiRebuild` 全部串行落盘。副作用是这些接口的耗时变成「排队 + 一次 IO」，实测仍在 10 ms 量级。

### 2. 超过 64KB 的请求体把连接打断

旧代码 `req.destroy()`，前端只看到 `TypeError: fetch failed`，没有任何可读原因。

修法：读完丢弃并回 `413 {"ok":false,"error":"body too large"}`，连接保持正常。

### 3. 坏季度参数打成 500

`GET /api/season?q=2026Q5` 或 `q=xxxx` 以前抛异常 → 500 + 堆栈。现在回 `400`，并直接告诉你正确写法（`2026Q4`）。

### 4. 恢复备份的路径校验不够

`POST /api/restore` 原来只做名字白名单前缀判断。现在再加一层：名字必须真实出现在 `/api/backups` 列表里，否则 404 并把可用备份列出来。顺手把 `safeJoin` 的 `startsWith(base + sep)` 补齐，避免 `panel-bar` 这种兄弟目录绕过。

### 5. `library.json` 坏掉时，面板只显示一句 JSON 解析错误

`/api/state` 现在会带 `hint`：「面板底栏『恢复上一版』可以回滚」，把自救路径直接摆在报错旁边。

### 6. `tools/sync_bangumi.mjs` 开头带 BOM

`node --check` 直接报 `Invalid or unexpected token`。已去 BOM。这类问题会让 `doctor` 的「脚本可解析」检查漏判。

### 7. 进度文案语义打架

同一个 `差 N` 既是「总话数还差几话」，又是「比按开播日算的进度少几话」，两个数不一样。

修法：卡片写 `19/24 · 剩 5 话`，只有真的落后才追加 `· 落后 1`；`lib/today.mjs` 的口播文案与 `data/talks.json` 的话术同步改成「落后 N 话」。

### 8. 页面 `favicon` 404

浏览器控制台每次打开都多一条红字。加了内联 SVG 图标（`小`），现在控制台干净——这也是自动化体检能 `PASS` 的前提。

### 9. 空操作也写盘、也留历史

`POST /api/progress` 传 `delta:0`（或连点到话数上限）以前照样写一遍 `library.json`、留一份 `.bak`、记一条 `history.jsonl`，还重算一次 `today.txt`。现在结论没变就直接回 `{changed:false}`，什么都不落盘：

```
{"ok":true,"id":"554779","prev":0,"ep_status":0,"eps":12,"changed":false,"rebuilt":false}
```

---

## 三、顺手做的改进

- **本季页季度条**：`‹ 2025Q4 … 2027Q1 ›` 七个季度胶囊，过去几季直接点，不用改地址。
- **封面尺寸**：底栏 `封面 小 / 中 / 大`，写 `localStorage`，影响本周卡片与本季表格（`--cv-w/--cv-h`）。
- **本周页空态提示**：只列在追且不足 6 部时，板子下面补一句「想看整季排片就勾上『连本季一起看』」。
- **默认页签改「本周」**：周历板比「今天」更适合扫一眼，和参考的 daily-anime 一致；文档已同步。
- **`/api/state` 带上 `expected_eps`**：卡片能区分「剩」和「落后」，不用前端再算一遍。
- **`check_panel_ui.mjs` 升级**：收集 `Runtime.exceptionThrown` / `console.error` / `Log.entryAdded`，并走一遍「本周七列 + 记一话 → 撤回」；有报错即 FAIL。这条现在是回归网。

---

## 四、仍然存在的问题（按优先级，均已知不致命）

| 级别 | 问题 | 说明 / 现状 |
| --- | --- | --- |
| P1 | Bangumi **没有放送时刻** | 接口只给日期。同步进来的番「时间未定」，要精确到点只能在本季表里手填（`POST /api/season/time`）。这是数据源限制，不是 bug |
| P1 | 多实例同写一份库 | 单进程内已串行；同时开 7788 与 7789 两个实例时没有跨进程锁。日常只用 `启动TIARA.bat` 起一个，风险低 |
| P2 | `data/history.jsonl` 不轮转 | 目前 40 行 / 5.4 KB，一年也就几百 KB；`library.json.bak` 与 `data/backups/` 已滚动 5 份 |
| P2 | 面板/服务端没有单元测试 | 只有 CDP 冒烟（`tools/check_panel_ui.mjs`）。纯函数在 `lib/` 有 43 例覆盖，但 HTTP 层没有 |
| P2 | SSP 版没有到点提醒 | 只有 YAYA 版能（`OnSecondChange` 每 30 秒比对 `today.json`）；普通版靠 `＊OnBoot` 口播，关掉就没了 |
| P3 | `sleepy` / `think` 没有真差分 | 只有 4 张立绘，缺的表情退回 `normal`；用 ComfyUI 补过一版但画风不一致，已弃用 |
| P3 | 桌面通知可能被「专注助手」吞 | 通知走托盘气泡，系统专注模式下不显示；不影响桌宠自己的气泡 |

---

## 五、体检脚本怎么跑

```bash
node --test "test/*.test.mjs"     # 43 例纯函数单测
node tools/doctor.mjs             # 环境 / 数据 / 偏好 / 缓存 自检
node tools/check_panel_ui.mjs     # 真浏览器跑一遍面板交互，有页面报错就 FAIL
```

三个都在 README §12.1 里，改完代码习惯性跑一遍即可。

---

## 六、边角数据（供后续对比）

- 代码量：`server.mjs` 936 行、`panel/index.html` 1101 行、`pet/Pet.cs` 1898 行、`lib/today.mjs` 323 行、`lib/bgm.mjs` 475 行、`README.md` 672 行。
- 接口耗时（本机）：`/api/state` 71 ms，`/api/progress` / `/api/settings` / `/api/health` 均 < 10 ms。
- 桌宠常驻 CPU：8 秒里 0.29 秒 ≈ 3.6%（33 ms 一跳的呼吸动画 + 4 秒一次的 `today.txt` 轮询）。
- `pet.log` 每次启动清空，不会无限增长。
- `cache/` 里已清掉 63 个临时浏览器 profile；自动化体检用 `--user-data-dir` 时记得用后即删。
