# v0.53.0 验收记录

项目检查通过，190 项自动测试全部通过。

- **更新与取消。** 可控订阅端按 UID 对比连续的 iCalendar 响应。临时跨日改期保留 UID 并提高 SEQUENCE；暂停和归档发出取消状态，继续后以同 UID 恢复。旧的单次导出选项和提醒规则继续通过自动测试。 [iCalendar 标准](https://www.rfc-editor.org/rfc/rfc5545.html)
- **缓存与入口。** 同一地址的数据和 ETag 保持稳定，内容一致时返回 304。重启服务后仍可使用旧的 ETag。Edge 从解压的便携版打开「导出日历」，核对本机订阅地址并实际重复请求。
- **试验范围。** 本机面板提供滚动 28 天的自用排片，订阅试验没有内置闹铃。第三方客户端自行决定刷新频率，本轮使用可控本机订阅端；微软文档指出 Outlook 网页日历订阅更新可能超过 24 小时。本机地址适用于可直接访问本机服务的程序。 [Outlook 订阅说明](https://support.microsoft.com/en-us/outlook/import-or-subscribe-to-a-calendar-in-outlook-com-or-outlook-on-the-web)
- **安装包。** 两个公开 ZIP 和 SHA-256 清单重新生成并校验。桌宠用包内运行时启动网页；SSP 公开包沿用空库。
