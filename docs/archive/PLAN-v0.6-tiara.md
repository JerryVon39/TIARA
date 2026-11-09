# TIARA 改造方案（v0.6）

> 需求来源：2026-11-04 23:58 五条——
> ① 先不管立绘，优先功能性；② 面板别依赖 Node.js；③ 本季表要更清晰的表格且切季度别慢；④ 要能直接在番剧行上追番；⑤ 改名 **TIARA**，不再叫「TIARA」。
> 下面每条都给「现状实测 → 方案 → 涉及文件 → 预估」，末尾是实施顺序与验收清单。

---

## 0. 总览

| # | 需求 | 方案一句话 | 预估 |
| --- | --- | --- | --- |
| A | 行内直接追番 | 每行末尾加 `[+ 追]`，点一下就地变成「已看 0/12」 | 0.5 h |
| B | 切季度太慢（实测 16–21 s） | 服务端内存缓存 + 启动预热相邻季 + 分页接口 + 前端骨架先渲染 | 3–4 h |
| C | 表格不够清晰 | 七列固定表头（勾选/封面/番名/放送/话数/评分/状态·操作）+ 排序 + 过滤 + 无限滚动 | 3 h |
| D | 用户可能没装 Node.js | 随包携带 `runtime/node.exe`（94 MB，实测自包含）；后续可选把服务并进 Pet.exe | 1 h（+1–2 天可选） |
| E | 改名 TIARA | `tools/rename.mjs --dry-run` 白名单替换 + 3 个 bat 改名 + 产物重建 | 1 h |

---

## 1. D：不装 Node.js 也能用（先做 A 方案）

### 现状
- `panel` 的全部数据来自 `server.mjs`（936 行，零 npm 依赖），要靠 `node` 才能跑；
- `启动TIARA.bat`、`打开番组表.bat`、Pet.exe 的「打开网页面板」都直接调 `node`；
- 用户机器上没装 Node 就是死路。

### 实测

| 方案 | 体积增量 | 改动量 | 风险 |
| --- | --- | --- | --- |
| **A. 随包带 `runtime/node.exe`** | **+94.2 MB**（zip 后约 30 MB） | 几乎为零（只改启动查找顺序） | 低。本机 `C:\Program Files\nodejs\node.exe` 实测**无同目录 DLL 依赖**，`node -e` 直接跑通 |
| B. C# 版服务并入 Pet.exe | **0**（.NET Framework 4.8 系统自带，本机 4.8.9221） | 约 1 800 行移植（server 936 + bgm 475 + today 323） | 中高。要重写 JSON/代理分页/缓存，双实现易漂移 |
| C. PowerShell `HttpListener` 服务 | 0 | 400–600 行 PS | 高。UTF-8 与 JSON 序列化坑多（本次已踩过 GBK 乱码） |

### 采用：A 优先，B 作为 v0.8 可选项

```bat
:: 启动TIARA.bat（新）
if exist "%~dp0runtime\node.exe" set NODE=%~dp0runtime\node.exe
if not defined NODE where node >nul 2>nul && set NODE=node
if not defined NODE (echo 缺少运行时：把 runtime\node.exe 放回来，或安装 Node.js & pause & exit /b 1)
"%NODE%" "%~dp0server.mjs" --port 7788
```

- 新增 `tools/fetch_runtime.mjs`：从本机 Node 安装目录复制 `node.exe` 到 `runtime/`，记录 sha256 与版本到 `runtime/README.txt`；
- `pet/Pet.cs` 的 `StartServer()` / `OpenWebPanel()` 按同一顺序查找（runtime → PATH）；
- `dist/` 打包脚本把 `runtime/` 一起打进去（`.gitignore` 排除 `runtime/node.exe`，仅提交说明文件）；
- `.gitignore` 加 `runtime/*.exe`。

> 为什么不是 SEA 单文件：Node 官方 SEA 产物同样 ~90 MB，还要 `postject` 注入，收益为零、步骤更多。

---

## 2. B：切季度 16 秒 → 目标 <1 秒

### 实测（本机，2026-11-04）

```
2026Q4   70 ms  167 条  cache      ← 已缓存
2026Q4    7 ms  167 条  cache      ← 二次命中
2026Q3    6 ms  240 条  cache
2026Q2 16602 ms  232 条  net        ← 未缓存：按需全量拉
2025Q4 16112 ms  240 条  net
2026Q1 20936 ms  234 条  net
```

**根因**：`fetchSeason()` 按 `limit=20` 分页跑满 12 页，每页一次 BHGM 往返（经代理约 1.3 s），且**只有点到某个季度才去拉**；前端还要等全量返回才 `innerHTML` 重建 200+ 行。

### 四条改动

1. **服务端内存缓存**（`lib/season-cache.mjs`）
   现在每次请求都 `readFile + JSON.parse` 200 KB；加 `Map<q, {data, at}>`，命中直接返回对象。

2. **启动预热 + 相邻季预取**
   `server.mjs` listen 成功后，用 `setImmediate` 串行预热 `[当前季, 上一季, 下一季]`（不阻塞启动、失败静默）。用户切到相邻季基本秒开。

3. **分页接口**（保持旧参数兼容）
   `GET /api/season?q=2026Q4&offset=0&limit=60` → 返回 `{total, offset, items, next}`；
   不带 `limit` 时行为不变（一次给全，兼容旧调用）。

4. **前端先渲染骨架**
   切季立刻重画表头 + 60 行骨架，右上角显示 `正在拉取 2025Q4 · 已 60/240`，可随时切走（用 `AbortController` 取消）；
   远端单页加 6 s 超时、失败保留旧缓存并标注「显示的是 X 小时前的缓存」。

**预期**：相邻季 <100 ms；冷季首屏 <800 ms；全量后台补齐（进度可见）。

---

## 3. C + A：表格更清晰 + 行内追番

### 现状问题（用户原话：不好用的列表、要勾选再点顶部按钮）
1. 状态列只显示「未追」，没有任何就地操作；
2. 番名列 `1fr` 吃掉全部剩余宽度，名字与副行挤在一起；
3. 没有排序、没有过滤（只看 TV / 隐藏已在追 是两个互不相关的开关）；
4. 240 条一次性渲染，滚动卡。

### 新表格（七列，固定表头）

| 列 | 宽度 | 内容 |
| --- | --- | --- |
| 勾选 | 34 | 批量用，保留 |
| 封面 | 46 | 40×56，`loading=lazy` |
| 番名 | 1fr | 主标题（可 2 行截断）+ 副行「首播日 · 类型 · 平台」 |
| 放送 | 92 | `周四 22:30`（未定显示 `未定`，30h 制式跟随全局） |
| 话数 | 56 | `12 话` |
| 评分 | 56 | `7.4`（悬停给评分人数） |
| **状态 · 操作** | 132 | 未追：`[+ 追]`｜在追：`已看 3/12` + `[−][+][×]` |

配套：
- 表头 `position: sticky`，滚动时列名常驻；
- 排序下拉：`放送日 / 评分 / 名字 / 在追优先`（默认放送日）；
- 过滤改为三态 chip：`全部 / 只看在追 / 只看未追`，另保留「只看 TV」；
- 每页 60 条 + 无限滚动（`IntersectionObserver` 触底加载）；
- 行 hover 高亮，在追行左侧 2px 竖条。

### 行内追番（0.5 h 就能用）

```
面板：click [+ 追] → POST /api/season/apply { ids: [id], ... }
服务端：已有该接口（接受 ids 数组），单条同样走通
成功后：该行 DOM 就地替换成「已看 0/N [−][+][×]」，并刷新顶部在追计数
```

- 勾选 + 顶部「加入在追」保留给「一次追五部」；
- 进入本季页时把 `watching` 的 id 集合喂给表格，已追的直接带进度控件（不再显示「未追」）；
- 失败（网络/坏 id）行内红字提示，不弹窗。

---

## 4. E：改名 TIARA

### 影响面（实测统计）

| 类型 | 位置 | 次数 |
| --- | --- | --- |
| 文档 | `README.md` 17、`PLAN-v0.4.md` 7、`AUDIT*.md` 2、`REFERENCE-taromati2.md` 1 | 27 |
| 桌宠 | `pet/Pet.cs`：文件头注释 L1、`Title` L142/L1937、开场自称 L888、通知前缀 L1616 | 6 |
| 话术 | `data/talks.json`：`note` + L5/L10/L97/L98 自称 | 5 |
| 面板 | `panel/index.html`（页头标题与副标） | 3 |
| 服务 | `server.mjs`（启动日志、`/api/version` name 字段） | 7 |
| 工具 | `pack_ssp / build_yaya / build_ghost / build_pet / season / comfy_*` | 14 |
| ghost/shell | `ghost/master/descript.txt`（`sakura.name,TIARA`）、`shell/master/descript.txt`（`name,TIARA 默认`） | 2 |
| 批处理 | `启动TIARA.bat`、`停止TIARA.bat`（`打开番组表.bat` 名字无「TIARA」，内容有TIARA） | 3 个文件名 + 内容 |

### 做法

新增 `tools/rename.mjs`：

```
node tools/rename.mjs --to TIARA --dry-run     # 打印每个文件将改几处 + 前后对照
node tools/rename.mjs --to TIARA --apply       # 落盘 + 重命名 bat + 重建产物
```

- 白名单替换（不乱扫 `cache/`、`.git/`）：
  `TIARA → TIARA`；`Tiara → Tiara`；`tiara → tiara`；
  `启动TIARA.bat → 启动TIARA.bat`、`停止TIARA.bat → 停止TIARA.bat`；
- **不动**：`data/*.json` 的字段名与键、`settings.json`、`state.json`、`ghost/master` 目录名、`today.txt` 变量名（避免破坏已有数据与契约）；
- **不动**：`C:\Projects\TIARA` 这层目录名（改它会让 git 根、快捷方式、正在运行的进程全部失效；要改另说）；
- 改完自动执行：`node tools/build_today.mjs && node tools/build_ghost.mjs && node tools/build_yaya.mjs && node tools/build_pet.mjs`，再跑 `doctor` + 43 例单测 + 面板截图比对；
- 单独一个 commit：`refactor(rename): TIARA → TIARA`，便于回滚。

---

## 5. 实施顺序（每步一个 commit）

| 顺序 | 任务 | 验收 |
| --- | --- | --- |
| 1 | 行内追番 | 点 `[+ 追]` 后行内变「已看 0/12」，`data/library.json` 多一条，顶部计数 +1 |
| 2 | 切季度提速（缓存 + 预热 + 分页 + 骨架） | 首次启动后切上/下一季 <300 ms；冷季首屏 <1 s 且进度可见 |
| 3 | 表格七列重排 + 排序 + 过滤 + 无限滚动 | 表头滚动固定；三态过滤生效；240 条滚动不卡 |
| 4 | runtime/node.exe 随包 | 把 `node` 从 PATH 临时移除后，双击 `启动TIARA.bat` 仍能开面板 |
| 5 | 改名 TIARA | `grep TIARA` 归零（除 git 历史）；doctor/单测/截图全绿 |

### 总预估：约 1 个工作日（不含可选的 C# 版服务）

---

## 6. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 94 MB 运行时体积 | 打包为 zip（约 30 MB）；README 写清「不想带就自己装 Node」；后续 C# 版可彻底去掉 |
| 预热拖慢启动 | `setImmediate` + 串行 + 单季 12 s 上限，失败静默，不影响 listen |
| 改名漏改 | `--dry-run` 先看 diff；改完 `grep -r TIARA` 断言归零；单测与截图双验 |
| 分页改动破坏旧调用 | 不带 `limit` 时行为完全不变；`test/season.test.mjs` 补 3 例覆盖 offset/limit 边界 |
| 表格重排后截图漂移 | 保留 `tools/check_panel_ui.mjs`，新增「七列表头存在 + 行内追番可点」两条断言 |
