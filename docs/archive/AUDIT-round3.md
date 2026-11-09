# TIARA 全项目审查 · 第三轮（v0.25.0）

审查时间：2026-11-05 · 审查者：实现者本人 · 范围：仓库全部源码 / 数据 / 构建产物 / 文档
触发原因：气泡重做（一体轮廓）+ 「气泡不许顶走立绘」修复完成，需要一次尽可能细的全量体检。

---

## 0. 结论摘要

| 维度 | 结论 |
| --- | --- |
| 功能完整性 | 今日/本周/本季三条主线 + 桌宠交互 + SSP 双版本 + 导出/统计/备份 已闭环 |
| 正确性 | 单测 90 例全过；`doctor` 无 error（2 条 info 均为「可选未填」） |
| 稳定性 | 本轮修掉 2 个真 bug（布局自激、立绘被顶走）；无已知崩溃路径 |
| 可维护性 | 3 个巨型文件（`pet/Pet.cs` 3924 行、`server.mjs` 1548、`panel/index.html` 1651）已到该拆分的临界点 |
| 一致性 | README 与实现基本对齐；本轮有 3 处需回写（气泡描述、调试开关、版本号） |
| 安全 | 服务只绑 `127.0.0.1`，写接口校验 Origin；唯一敏感数据是 `data/bgm.json` 的明文 token（已有注释警告） |
| 体积 | 仓库真实体积 ≈ 6 MB（不含 `runtime/` `dist/` `cache/`）；三者为生成物且已 gitignore |

**本轮新增的两个必修项都已修完**（详见 §3、§4）。剩余未做项集中在 §8「建议与优先级」。

---

## 1. 规模与体积

### 1.1 源码行数（含空行与注释）

| 文件 | 行数 | 体积 |
| --- | --- | --- |
| `pet/Pet.cs` | 3924 | 162.7 KB |
| `panel/index.html` | 1651 | 70.8 KB |
| `server.mjs` | 1548 | 53.4 KB |
| `README.md` | 1183 | 59.6 KB |
| `lib/bgm.mjs` | 557 | 21.1 KB |
| `lib/today.mjs` | 354 | 11.6 KB |
| `lib/season-cache.mjs` | 123 | 3.6 KB |
| `lib/zip.mjs` | 120 | 3.8 KB |
| `lib/ics.mjs` | 114 | 3.3 KB |
| `lib/persona.mjs` | 58 | 1.5 KB |
| `lib/cover.mjs` | 53 | 1.5 KB |
| `lib/http-util.mjs` | 52 | 1.5 KB |

### 1.2 目录体积

| 目录 | 体积 | 文件数 | 是否入库 |
| --- | --- | --- | --- |
| `runtime/` | 94.2 MB | 2 | 否（`node.exe` 副本，`tools/fetch_runtime.mjs` 生成） |
| `dist/` | 100.0 MB | 4 | 否（SSP/YAYA/便携包 zip + manifest） |
| `cache/` | 49.5 MB | 209 | 否（截图、日志、临时浏览器 profile） |
| `.git/` | 5.3 MB | 832 | — |
| `data/` | 3.2 MB | 461 | 部分（`covers/`、`undo/`、`season/`、`state.json` 均忽略） |
| `shell/` | 1.5 MB | 15 | 是 |
| 其余源码 | < 1 MB | — | 是 |

结论：**仓库本体 ≈ 6 MB**，其余全是可再生成的产物。`cache/` 又一次涨到 49.5 MB，`tools/clean_cache.mjs` 一条命令可回到 30 MB 上下。

---

## 2. 功能面（实现 vs 文档）

23 条 HTTP 路由：

```
/api/state  /api/season  /api/season/apply  /api/season/subject  /api/season/time
/api/season/time-batch  /api/token  /api/export  /api/stats  /api/progress
/api/watch  /api/undo  /api/reload  /api/sync  /api/settings  /api/nickname
/api/history  /api/backups  /api/restore  /api/say  /api/logs  /api/version  /api/health
外加 /sprite/<name>.png、/cover/<id>.jpg、/（面板）
```

- 写接口统一走 `withWriteLock`（串行化，防并发丢更新）+ `guardWrite`（Origin 校验）+ 备份 + 历史 + 重建快照四件套。
- `GET /api/state` 已瘦身到约 10 KB（`week` 只回必要字段、`images` 只留用得到的封面、`talks` 移出到 `/api/say`）。
- 桌宠侧与面板共用 `data/library.json`，通过 `ghost/master/today.txt` 单向联播（4 秒 mtime 轮询）。

文档一致性检查结果：

| README 说法 | 实际 | 状态 |
| --- | --- | --- |
| v0.24.3 | 本轮升到 v0.25.0 | 需回写（已改） |
| 单测 90 例 | 90 passed | ✅ |
| 服务只监听 `127.0.0.1` | `server.mjs:1484 server.listen(port,'127.0.0.1')` | ✅ |
| 气泡「尖角钉在固定锚点上」 | 锚点已改为 56%，且尖角与气泡合并为一条轮廓 | 需重写（已改） |

---

## 3. 本轮修的 bug ①：气泡顶走立绘

**现象**：说话瞬间立绘在屏幕上跳一下。

**根因**：`ApplyHeight()` 用 `Top = bottom - Height` 让窗口往上长，但立绘是「窗口里的一份内容」——只要窗口底边被 `SnapIntoWorkArea()` 或「往下让一点」逻辑挪动，立绘就跟着挪。

**修法**（`pet/Pet.cs`）：

1. 立绘钉死在窗口的某一侧：气泡在上时 `_uiRoot.VerticalAlignment = Bottom`（立绘贴窗口底边），气泡在下时改 `Top`（立绘贴窗口顶边）。
2. `ApplyHeight()` 全程只改「气泡那一侧」：放得下就 `Height = ScaledH + band; Top = bottom - Height`，立绘在屏幕上的位置恒为 `bottom - ScaledH`。
3. 真的没地方放（例如 200% 尺寸下立绘已占满屏幕）→ **overlay 模式**：窗口不再长高，气泡与立绘挤在同一行，气泡贴顶、压在头发上方（`LayoutBubbleOverlay()`），立绘一动不动。

**实测证据**（同一台机器、同一位置，只改台词长度）：

```
短句  win=940,490 h=657  → 立绘屏幕顶边 = 490 + 657 - 560 = 587
长句  win=940,467 h=680  → 立绘屏幕顶边 = 467 + 680 - 560 = 587   ✅ 完全一致
200%  bubble overlay band=136 roomAbove=25 → 窗口 860x1132 不变，立绘不动
```

---

## 4. 本轮修的 bug ②：气泡轮廓自激膨胀

**现象**：接上一体轮廓改造后，气泡高度一度涨到 4791 px、窗口涨到 3825 px。

**根因**：`Path` 直接做 `Grid` 的子元素，而它的 `Data` 又是按**父容器的 `ActualWidth/ActualHeight`** 算出来的：

```
ActualHeight → 生成几何 → Path.DesiredSize 变大 → 父容器变高 → ActualHeight 变大 → …
```

**修法**：轮廓改由 `Canvas` 承载（`Canvas` 不参与度量，子元素不会回灌父容器尺寸），并给 `Path` 显式 `Width/Height + Stretch.Fill`，几何尺寸与渲染尺寸严格 1:1。

---

## 5. 气泡重做的技术账

| 决策 | 理由 |
| --- | --- |
| 圆角矩形 + 尾巴 → `CombinedGeometry(Union)` 一条轮廓 | 描边连续、不可能出现「箭头和气泡分家」或接缝横线 |
| 尾巴用两条 `QuadraticBezierSegment` 收圆头 | 硬三角形和圆角气泡风格不搭；曲线与 18px 圆角是同一套语言 |
| 尾巴位置由「固定锚点」反算（`_tailAt = anchor - left`） | 句子长短只改气泡宽度，箭头钉在窗口 56% 处不动 |
| 说话时先按整句 `Measure` 再钉住 `MinWidth` | 打字过程中气泡不再一边长一边挪 |
| 气泡与立绘之间留 8–12 px | 贴着头顶会显得「压着人」 |
| 无空位时 overlay 而非缩窗 | 宁可盖住一点头发，也不许立绘位移或气泡出屏 |

---

## 6. 代码质量巡检

### 6.1 未完成标记

`TODO / FIXME / XXX` 全仓 **0 处**（`grep` 命中均为 `onlyTodo` 变量名与 `CultureInfo` 字样，非注释）。

### 6.2 调试开关（本轮清点，共 11 个环境变量）

| 变量 | 用途 | 是否该留 |
| --- | --- | --- |
| `PET_SCALE` | 临时指定桌宠尺寸 | 留（排障用） |
| `PET_POWER` | 强制省电档 | 留 |
| `PET_SNAPSHOT` / `PET_POPUP_SHOT` / `PET_CHOICE_SHOT` | 无头截图 | 留（没有它们就无法回归版式） |
| `PET_SAY` | 指定一句台词 | 留 |
| `PET_SELFTEST` | 自动跑一遍交互 | 留 |
| `PET_HIT_LOG` / `PET_DEBUG_HIT` / `PET_DEBUG_BG` | 命中测试排障 | 低价值，建议合并成一个 `PET_DEBUG=1` |
| `PET_CHOICE_TEST` | 造一个选择肢 | 可并入 `PET_SELFTEST` |

**问题**：这 8 个排障开关 README §12 完全没提，只有读源码才知道 → 已在 §12 补一节。

### 6.3 日志

- 服务端：`logLine()` 统一写 `cache/server.log`（1 MB 轮转 ×3），`console.*` 只剩 1 处（`server.mjs:1509` 端口全占用的启动失败，此时 logger 已就绪，可改但无实际影响）。
- 桌宠：`pet.log` 每次启动重建，不轮转（单次运行体量可控）。

### 6.4 巨型文件

| 文件 | 行数 | 拆分建议 |
| --- | --- | --- |
| `pet/Pet.cs` | 3924 | 按职责切 partial：`UI`（BuildUi/气泡/菜单/弹窗）/ `Talk`（台词池与规则）/ `Persona`（变量与情绪）/ `Net`（面板 API）/ `Data`（today.txt 解析） |
| `panel/index.html` | 1651 | 拆成 `panel.js` + `panel.css`（现在内联，改一行要动 70 KB 文件） |
| `server.mjs` | 1548 | 把 `api*` 系列按域拆到 `server/routes/*.mjs`，保留 `withWriteLock` 与静态服务在主文件 |

未做，因为都属于「纯搬家、零行为变化」的重构，风险收益比不适合和本轮修复混在一起。

---

## 7. 安全与隐私

| 项 | 现状 | 评价 |
| --- | --- | --- |
| 监听地址 | `127.0.0.1` 硬编码 | ✅ 局域网不可达 |
| 写接口 Origin | `guardWrite()`：非本机 Origin → 403 | ✅ 挡 CSRF |
| CORS | 只对同源回 `Access-Control-Allow-Origin` | ✅ |
| Token 存储 | `data/bgm.json` 明文，`.gitignore` 已排除 | ⚠️ 可接受（本地工具），README 已注明「别外传」 |
| 路径穿越 | 静态资源走白名单 + `safeJoin`；`/api/restore` 只认 `data/backups` 下的文件名 | ✅ |
| 请求体积 | `checkBodySize` 上限 + 413 | ✅ |
| 面板 XSS | 所有插值走 `esc()`；`data-*` 属性用 `escAttr()` | ✅ |

无高危项。

---

## 8. 建议与优先级

### P0（下一次动手就该做，成本 ≤ 1 小时）

1. **`panel/index.html` 拆文件**：`panel.css` + `panel.js`。现在 70 KB 内联，diff 噪音大、编辑器卡。
2. **合并排障开关**：`PET_HIT_LOG` / `PET_DEBUG_HIT` / `PET_DEBUG_BG` / `PET_CHOICE_TEST` → `PET_DEBUG=1`（子项用 `PET_DEBUG_HIT=1` 这种二级开关）。
3. **`cache/` 纳入日常**：`npm run clean` 加进 `启动TIARA.bat` 的可选步骤；或在 `doctor` 里对 >200 MB 直接给可执行的一行命令（已有 warn，补上命令）。

### P1（一两天）

4. **`pet/Pet.cs` 拆 partial**：至少把「台词池 + 规则引擎」和「面板 HTTP」拆出去，主文件目标 < 2000 行。
5. **桌宠单测的空白**：C# 侧零测试，唯一保障是 `PET_SELFTEST` 日志人眼扫。建议把「分区命中 / 规则匹配 / 占位符替换」三块纯逻辑抽成 `pet/TiaraLogic.cs`（无 WPF 依赖），用 `dotnet` 或直接 csc 编成 exe 跑断言。
6. **`server.mjs` 路由分文件**：23 条路由集中在 1 个文件里，`/api/season/*` 四兄弟占了近 400 行。

### P2（有空再说）

7. **README 1183 行**：第 5–10 章已经具备独立成页的条件，可拆到 `docs/`，README 只留概览 + 索引。
8. **面板国际化**：现在中文硬编码；若要给非中文用户用，得抽 `i18n.json`（当前明确不做）。
9. **`dist/` 100 MB**：三份 zip 有重复内容（`shell/` + `lib/` 各打一遍），可考虑共用资源包。

---

## 9. 验证记录（本轮收尾）

```
node --test "test/*.test.mjs"   →  90 passed / 0 failed
node tools/doctor.mjs           →  ✅ 可以开工。另有 2 条信息
                                   · 554779 有播出日无时刻（可选）
                                   · 待看队列：2 部落后合计 2 话
node tools/check_panel_ui.mjs   →  PASS（切制式/切页签/改尺寸/本周七列/记一话/行内追番/提示条一行+撤销/键盘/主题/待看/无页面报错）
桌宠三档尺寸快照                 →  cache/audit/b2_short.png（100% 短句）、b3_long.png（100% 40 字）、c_0.5.png、c2x.png（200% overlay）
```

---

## 10. 一句话

功能已经够用，**该收拾的是房子不是家具**：三个巨型文件 + 一堆临时开关，是下一阶段唯一值得投入的地方。
