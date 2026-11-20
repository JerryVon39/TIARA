# 季度目录来源

季度目录来自 [bangumi-data](https://github.com/bangumi-data/bangumi-data) 的 `dist/data.json`，按 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 分发改编数据。TIARA 从 2019Q1 起按北京时间首播日期分季，提取标题、类型、Bangumi 编号、结束日期及原播周档。`index.json` 记录源文件 SHA-256、取得时间、各季条目数和缺封面原因。后续联网更新使用 [Bangumi API](https://github.com/bangumi/api)。

条目缩略图使用 Bangumi 的公开封面接口或相同编号的本地封面副本，缩至最多 100 × 210 像素，按编号去重。封面可能属于各自权利人。目录的数据授权不涵盖封面版权。无 Bangumi 编号或上游缺图的条目显示名称首字占位。

使用 `py tools/build_season_catalog.py <data.json> --checked-at <带时区的取得时间> --covers` 重建。生成缩略图需要 Pillow 和 requests，代理可通过 `--proxy` 配置。日常重建重用现有缩略图，用 `--refresh-covers` 核对来源变化并只替换内容变动的文件。

打包前运行 `node tools/check_season_catalog.mjs --current`，核对 2019Q1 到打包当季的连续性、条目数、缩略图文件及缺图记录。
