# v0.56.0 验收记录

项目检查通过，191 项自动测试全部通过。

- **离线朗读。** 用解压后的桌宠加载 Windows 的 Microsoft Huihui Desktop（zh-CN）。中文样句在较快语速下输出到本地 WAV，收到 12 个语音边界。一次运行中初始化约 141 毫秒，发出请求后约 25 毫秒收到第一段语音进度。数据来自本机合成，实际发音体验取决于设备安装的语音。 [Windows SpeechSynthesizer](https://learn.microsoft.com/en-us/dotnet/api/system.speech.synthesis?view=netframework-4.8.1)
- **静音和专注。** 静音后无法发起朗读，进入专注立即停止当前台词，专注结束前保持安静。
- **对白试演。** 使用 342 DIP 宽的实际 WPF 窗口，两个模式均完整显示 TIARA 与阿番的说话标识。四句依序出场，切换单双气泡保留已到达的句子。窄窗口适合默认单气泡，双气泡以纵向错开保留上一个说话者。
- **发行包。** 使用 v0.55.0 桌宠状态副本测试，两个公开 ZIP 已重新生成并校验 SHA-256。
