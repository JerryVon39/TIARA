# SSP 外观和 TIARA 人格素材试验

## 预览 SSP 立绘

```powershell
node tools/inspect_ssp_shell.mjs 'C:\Test\shell\master' --surface 0 --html 'C:\Test\ssp-preview.html'
```

工具读取同一目录的 PNG。可直接预览 `surface0.png` 等整图，或者读取 UTF-8 和 Shift_JIS 的 `surfaces.txt`。支持单个 `surfaceN` 段内按顺序叠放 `element`、整数偏移和矩形 `collision`。预览页把叠层与碰撞区画在一起。复杂范围、追加段、换装绑定、动画和碰撞多边形保留给 SSP 渲染器。 [UKADOC surfaces.txt](https://ukatech.shillest.net/ukadoc-spec/descript/shell-surfaces/)

## 检查人格素材

试验清单为 UTF-8 的 `persona.json`，同一目录放 `talks.json` 和 `shell/`。图片由你准备，`shell/surface0.png` 是默认预览。其余表情图和可选的 `faces.json`、`surfaces.json` 沿用 TIARA 立绘格式。

```json
{
  "format": "tiara-persona",
  "schema": 1,
  "id": "evening-blue",
  "name": "晴蓝夜读",
  "theme": { "bubble": "blue", "size": "standard" }
}
```

`id` 使用小写英文字母、数字与短横线，开头为字母。气泡主题可选 `warm`、`pink` 或 `blue`，字号可选 `small`、`standard` 或 `large`。预览显示静态资源和缺件，所有检查通过后可在试验目录切换。

```powershell
node tools/persona_trial.mjs inspect 'C:\Test\evening-blue'
node tools/persona_trial.mjs switch 'C:\Test\evening-blue' 'C:\Test\TIARA-preview'
node tools/persona_trial.mjs restore 'C:\Test\TIARA-preview'
```

解压便携包作为试验目录。在切换或恢复前先退出这份桌宠，再启动查看效果。恢复会使用试验前的台词、立绘和气泡设置，保留期间新增的便条或观看数据。便携包自带的 Node.js 也能执行这些工具。
