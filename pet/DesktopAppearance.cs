using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Web.Script.Serialization;

namespace UkagakaBangumi
{
    public partial class PetWindow
    {
        static readonly string[] WindowLayers = { "top", "normal", "bottom" };
        string _previousShellName;
        bool _appearanceSavePending;

        sealed class AppearanceDraft
        {
            public string Shell, Layer;
            public double Scale;
            public int Theme, TextSize, BubbleTime;
            public bool ReduceMotion, HideFullscreen, Recall;

            public bool SameAppearance(AppearanceDraft other)
            {
                return Shell == other.Shell && Layer == other.Layer && Theme == other.Theme && TextSize == other.TextSize &&
                    BubbleTime == other.BubbleTime && ReduceMotion == other.ReduceMotion &&
                    HideFullscreen == other.HideFullscreen && Recall == other.Recall;
            }
        }

        AppearanceDraft CurrentAppearance()
        {
            return new AppearanceDraft
            {
                Shell = _shellName, Layer = _layer, Scale = _requestedScale,
                Theme = _bubbleThemeIndex, TextSize = _bubbleSizeIndex, BubbleTime = _bubbleTimeIndex,
                ReduceMotion = _reduceMotion, HideFullscreen = _hideFullscreen, Recall = _recallKeyEnabled
            };
        }

        void SetAppearanceOptions(AppearanceDraft draft, string previousShell)
        {
            _previousShellName = previousShell;
            _bubbleThemeIndex = draft.Theme;
            _bubbleSizeIndex = draft.TextSize;
            _bubbleTimeIndex = draft.BubbleTime;
            _reduceMotion = draft.ReduceMotion;
            _hideFullscreen = draft.HideFullscreen;
            _recallKeyEnabled = draft.Recall;
        }

        void ShowAppearance(AppearanceDraft draft, ShellSkin skin, string previousShell)
        {
            SetAppearanceOptions(draft, previousShell);
            if (_shellName != draft.Shell)
            {
                _shellName = draft.Shell;
                UseShellSkin(skin);
            }
            if (_layer != draft.Layer)
            {
                _layer = draft.Layer;
                if (_recallLayerTimer != null) _recallLayerTimer.Stop();
                ApplyLayer();
            }
            if (!_scaleFromEnv) ApplyScale(draft.Scale, false, false);
            ApplyRecallHotkey(new WindowInteropHelper(this).Handle);
            ApplyBubbleTheme();
            UpdateLayout();
            if (BubbleReading) ApplyHeight(true);
            SnapIntoWorkArea();
        }

        AppearanceDraft ReadSavedAppearance(JavaScriptSerializer serializer, Dictionary<string, object> settings, out string previousShell)
        {
            previousShell = null;
            var value = settings == null ? null : StateValue<Dictionary<string, object>>(serializer, settings, "desktop_appearance");
            if (value == null) return null;
            string layer = StateValue<string>(serializer, value, "layer");
            string shell = StateValue<string>(serializer, value, "shell");
            if (!WindowLayers.Contains(layer) || string.IsNullOrEmpty(shell)) return null;
            var options = ShellOptions();
            string previous = StateValue<string>(serializer, value, "previous_shell");
            previousShell = options.Contains(previous) && previous != shell ? previous : null;
            return new AppearanceDraft
            {
                Shell = options.Contains(shell) ? shell : "master",
                Layer = layer,
                Scale = ValidScale(StateValue<double>(serializer, settings, "pet_scale")),
                Theme = Math.Max(0, Math.Min(BubbleThemes.Length - 1, StateValue<int>(serializer, value, "theme"))),
                TextSize = Math.Max(0, Math.Min(BubbleFontFactors.Length - 1, StateValue<int>(serializer, value, "size"))),
                BubbleTime = Math.Max(0, Math.Min(3, StateValue<int>(serializer, value, "bubble_time"))),
                ReduceMotion = StateValue<bool>(serializer, value, "reduce_motion"),
                HideFullscreen = StateValue<bool>(serializer, value, "hide_fullscreen"),
                Recall = StateValue<bool>(serializer, value, "recall_hotkey")
            };
        }

        void LoadSavedAppearance(JavaScriptSerializer serializer, Dictionary<string, object> settings)
        {
            string previous;
            var saved = ReadSavedAppearance(serializer, settings, out previous);
            if (saved == null) return;
            _shellName = saved.Shell;
            _layer = saved.Layer;
            SetAppearanceOptions(saved, previous);
        }

        bool ApplySavedAppearance(JavaScriptSerializer serializer, Dictionary<string, object> settings)
        {
            string previous;
            var saved = ReadSavedAppearance(serializer, settings, out previous);
            if (saved == null || (saved.SameAppearance(CurrentAppearance()) && previous == _previousShellName)) return false;
            var skin = OpenShellSkin(saved.Shell);
            if (skin.Resolve(0) == null)
            {
                saved.Shell = "master";
                skin = OpenShellSkin(saved.Shell);
            }
            ShowAppearance(saved, skin, previous);
            SaveState();
            TickDesktopVisibility();
            return true;
        }

        void SaveAppearance(AppearanceDraft draft, ShellSkin skin, string previousShell, bool saveScale, Action<string> done)
        {
            if (_selfTest || _closing) { done("本机设置暂时无法保存。"); return; }
            if (_settingsWritePending || _settingsPatch.Count > 0)
            {
                done("还有设置正在保存，请稍后重试。");
                return;
            }
            var serializer = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };
            var payload = new Dictionary<string, object> {
                { "appearance", new {
                    shell = draft.Shell, previous_shell = previousShell, layer = draft.Layer,
                    theme = draft.Theme, size = draft.TextSize, bubble_time = draft.BubbleTime,
                    reduce_motion = draft.ReduceMotion, hide_fullscreen = draft.HideFullscreen, recall_hotkey = draft.Recall
                } }
            };
            if (!_scaleFromEnv) payload["fallback_scale"] = Math.Round(_requestedScale, 2);
            saveScale = saveScale && !_scaleFromEnv;
            if (saveScale) payload["pet_scale"] = Math.Round(draft.Scale, 2);
            _appearanceSavePending = true;
            string body = serializer.Serialize(payload);
            Action<string> completed = raw =>
            {
                string error = "外观未能保存。当前外观未更改，草稿仍可重试。";
                try
                {
                    var reply = ReadProgressResponse(serializer, raw);
                    Dictionary<string, object> settings;
                    if (reply != null && StateValue<bool>(serializer, reply, "ok"))
                        settings = StateValue<Dictionary<string, object>>(serializer, reply, "settings");
                    else
                    {
                        // A lost response can follow a successful disk write.
                        string file = Path.Combine(_root, "data", "settings.json");
                        settings = serializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(file, Encoding.UTF8));
                    }
                    string previous;
                    var saved = ReadSavedAppearance(serializer, settings, out previous);
                    if (!_closing && saved != null && saved.SameAppearance(draft) && previous == previousShell &&
                        (!saveScale || Math.Abs(saved.Scale - draft.Scale) < 0.005))
                    {
                        ShowAppearance(saved, skin, previous);
                        SaveState();
                        TickDesktopVisibility();
                        error = null;
                    }
                }
                catch (Exception ex) { Log("appearance save: " + ex.Message); }
                finally
                {
                    _appearanceSavePending = false;
                    if (_settingsPatch.Count > 0) SendSettingsPatch();
                    if (!_closing) done(error);
                }
            };
            UsePanel(port => PostJsonAsync("http://127.0.0.1:" + port + "/api/desktop/appearance", body, completed),
                false, () => completed(null));
        }

        string ShellDisplayName(string name)
        {
            if (name == "master") return "TIARA 默认";
            if (name == "tiara2") return "TIARA 经典";
            try
            {
                var file = Path.Combine(_root, "shell", name, "descript.txt");
                if (File.Exists(file))
                {
                    var line = File.ReadLines(file, Encoding.UTF8).FirstOrDefault(x => x.StartsWith("name,", StringComparison.OrdinalIgnoreCase));
                    if (line != null && line.Length > 5 && !line.Contains("\ufffd")) return line.Substring(5).Trim();
                }
            }
            catch (IOException) {}
            catch (UnauthorizedAccessException) {}
            return name;
        }

        static StackPanel AddAppearanceTab(TabControl tabs, string title, string id)
        {
            var content = new StackPanel { Margin = new Thickness(12, 10, 12, 0) };
            var tab = new TabItem { Header = title, Content = content };
            AutomationProperties.SetAutomationId(tab, id);
            tabs.Items.Add(tab);
            return content;
        }

        void OpenAppearance()
        {
            if (_appearanceWindow != null) { _appearanceWindow.Activate(); return; }
            StackPanel panel;
            var win = UtilityWindow("TIARA · 换装与显示", out panel);
            _appearanceWindow = win;
            win.Closed += delegate { _appearanceWindow = null; };
            win.Width = 460;
            win.WindowStartupLocation = WindowStartupLocation.CenterOwner;
            var scroll = (ScrollViewer)win.Content;
            win.Content = null;
            var root = new DockPanel();
            var footer = new StackPanel { Margin = new Thickness(18, 0, 18, 12) };
            DockPanel.SetDock(footer, Dock.Bottom);
            root.Children.Add(footer);
            root.Children.Add(scroll);
            win.Content = root;

            var draft = CurrentAppearance();
            var savedAtOpen = CurrentAppearance();
            var tabs = new TabControl();
            panel.Children.Add(tabs);
            var wardrobe = AddAppearanceTab(tabs, "立绘", "appearance-tab-shell");
            var display = AddAppearanceTab(tabs, "显示与召回", "appearance-tab-display");
            var bubbles = AddAppearanceTab(tabs, "气泡", "appearance-tab-bubble");
            tabs.SelectedIndex = 0;

            var names = ShellOptions();
            var current = ScheduleText("", 12, ScheduleMuted);
            wardrobe.Children.Add(current);
            UtilityText(wardrobe, "立绘套装");
            var shell = AppearanceOptions("立绘套装", "appearance-shell", names.Select(ShellDisplayName), Math.Max(0, names.IndexOf(draft.Shell)));
            wardrobe.Children.Add(shell);
            UtilityText(wardrobe, "逐张预览表情");
            var expression = AppearanceOptions("预览表情", "appearance-expression", ShellFaceLabels, 0);
            wardrobe.Children.Add(expression);
            var preview = new Grid { Height = 210, Margin = new Thickness(0, 0, 0, 8), Background = ScheduleWash };
            wardrobe.Children.Add(preview);
            var hint = ScheduleText("", 12, ScheduleMuted);
            hint.TextWrapping = TextWrapping.Wrap;
            wardrobe.Children.Add(hint);

            var scales = new SortedSet<double> { 0.5, 0.7, 0.85, 1, 1.25, 1.5, 1.75, 2, draft.Scale }.ToArray();
            var scale = AppearanceOptions("桌宠尺寸", "appearance-scale",
                scales.Select(value => (value * 100).ToString("0", CultureInfo.InvariantCulture) + "%"), Array.IndexOf(scales, draft.Scale));
            scale.IsEnabled = !_scaleFromEnv;
            var scaleHint = ScheduleText("", 12, ScheduleMuted);
            scaleHint.TextWrapping = TextWrapping.Wrap;
            UtilityText(display, "桌宠尺寸");
            display.Children.Add(scale);
            display.Children.Add(scaleHint);
            UtilityText(display, "窗口层级");
            var layer = AppearanceOptions("窗口层级", "appearance-layer", new[] { "置顶", "普通", "沉底" }, Array.IndexOf(WindowLayers, draft.Layer));
            display.Children.Add(layer);
            var hide = CompanionOption(display, "本屏全屏时暂时隐藏桌宠", "window-hide-fullscreen", draft.HideFullscreen, value => draft.HideFullscreen = value);
            var recall = CompanionOption(display, "启用找回快捷键 " + RecallKeys, "window-recall-hotkey", draft.Recall, value => draft.Recall = value);
            UtilityButton(display, "恢复默认显示", "appearance-reset-display", () =>
            {
                if (!_scaleFromEnv) scale.SelectedIndex = Array.IndexOf(scales, 1d);
                layer.SelectedIndex = 0;
                hide.IsChecked = false;
                recall.IsChecked = false;
            });
            UtilityText(display, "恢复默认显示会先改动草稿，点「应用」后保存。");
            var recallStatus = ScheduleText("", 12, ScheduleMuted);
            display.Children.Add(recallStatus);
            var position = new WrapPanel();
            display.Children.Add(position);
            UtilityButton(position, "找回桌宠", "appearance-recall", () => RecallDesktop(false));
            AddPositionReset(position, "appearance-reset-position");
            UtilityText(display, "找回和重置位置会立即生效。");

            UtilityText(bubbles, "气泡配色与字号");
            var theme = AppearanceOptions("气泡配色", "appearance-theme", Array.ConvertAll(BubbleThemes, item => item.Name), draft.Theme);
            var size = AppearanceOptions("气泡字号", "appearance-size", new[] { "小", "标准", "大" }, draft.TextSize);
            bubbles.Children.Add(theme);
            bubbles.Children.Add(size);
            UtilityText(bubbles, "气泡停留时间");
            var delay = AppearanceOptions("气泡停留时间", "appearance-bubble-time",
                new[] { "按台词长度", "至少 15 秒", "30 秒", "手动关闭" }, draft.BubbleTime);
            bubbles.Children.Add(delay);
            var motion = CompanionOption(bubbles, "减弱动画（立即显示全文）", "appearance-reduce-motion", draft.ReduceMotion, value => draft.ReduceMotion = value);
            var sample = new TextBlock { Text = "会长，今天的记录也写好了。", TextWrapping = TextWrapping.Wrap, Foreground = Ink };
            var bubble = new Border { Child = sample, Padding = new Thickness(12), Margin = new Thickness(0, 6, 0, 0),
                CornerRadius = new CornerRadius(10), BorderThickness = new Thickness(1) };
            bubbles.Children.Add(bubble);

            var status = ScheduleText("", 12, ScheduleMuted);
            status.TextWrapping = TextWrapping.Wrap;
            AutomationProperties.SetAutomationId(status, "appearance-status");
            UtilityText(footer, "应用前只预览。关闭窗口会放弃未应用的修改。");
            footer.Children.Add(status);
            var actions = new WrapPanel { Margin = new Thickness(0, 6, 0, 0) };
            footer.Children.Add(actions);
            Button apply = null, undo = null, close = null;
            ShellSkin stagedSkin = null;
            string stagedName = null;
            bool saving = false, canApply = false;
            Action readDraft = delegate
            {
                draft.Shell = names[shell.SelectedIndex];
                draft.Layer = WindowLayers[layer.SelectedIndex];
                draft.Scale = scales[scale.SelectedIndex];
                draft.Theme = theme.SelectedIndex;
                draft.TextSize = size.SelectedIndex;
                draft.BubbleTime = delay.SelectedIndex;
            };
            Action refresh = delegate
            {
                if (shell.SelectedIndex < 0 || scale.SelectedIndex < 0) return;
                readDraft();
                bool dirty = !draft.SameAppearance(savedAtOpen) || Math.Abs(draft.Scale - savedAtOpen.Scale) > 0.001;
                current.Text = "正在使用 " + ShellDisplayName(_shellName);
                tabs.IsEnabled = !saving;
                apply.IsEnabled = !saving && canApply && dirty;
                close.IsEnabled = !saving;
                close.Content = dirty ? "放弃修改" : "关闭";
                undo.IsEnabled = !saving && !string.IsNullOrEmpty(_previousShellName);
                undo.ToolTip = undo.IsEnabled ? "切回 " + ShellDisplayName(_previousShellName) : null;
                recallStatus.Text = !_recallKeyEnabled ? "也可从托盘找回桌宠。" : _recallKeyRegistered
                    ? "找回快捷键已启用。" : "快捷键当前不可用，可从托盘找回。";
                scaleHint.Text = _scaleFromEnv ? "尺寸由当前启动参数指定。" :
                    draft.Scale > MaxScale() ? "本屏放不下此尺寸，桌宠会暂时缩小。" : "";
            };
            Action<string> startSaving = message =>
            {
                saving = true;
                status.Text = message;
                refresh();
            };
            Action selectSavedScale = delegate
            {
                int index = Array.IndexOf(scales, savedAtOpen.Scale);
                if (index < 0)
                {
                    scales = new SortedSet<double>(scales) { savedAtOpen.Scale }.ToArray();
                    scale.Items.Clear();
                    foreach (double value in scales)
                        scale.Items.Add((value * 100).ToString("0", CultureInfo.InvariantCulture) + "%");
                    index = Array.IndexOf(scales, savedAtOpen.Scale);
                }
                scale.SelectedIndex = index;
            };
            Action showPreview = delegate
            {
                string name = names[shell.SelectedIndex];
                if (stagedSkin == null || name != stagedName)
                {
                    stagedName = name;
                    stagedSkin = OpenShellSkin(name);
                }
                preview.Children.Clear();
                var normal = stagedSkin.Resolve(0);
                canApply = normal != null;
                refresh();
                var art = normal == null ? null : stagedSkin.Resolve(expression.SelectedIndex);
                hint.Text = art == null ? "这套立绘的首张图片无法读取，当前外观继续使用。" :
                    art.Slot == expression.SelectedIndex ? "" :
                    "缺少「" + ShellFaceLabels[expression.SelectedIndex] + "」，显示「" + ShellFaceLabels[art.Slot] + "」。";
                if (art == null) return;
                var image = new Image { Source = art.Base, Stretch = Stretch.Uniform };
                AutomationProperties.SetName(image, "立绘预览 · " + ShellFaceLabels[art.Slot]);
                AutomationProperties.SetAutomationId(image, "appearance-preview");
                preview.Children.Add(image);
                foreach (var overlay in art.Overlays)
                    preview.Children.Add(new Image { Source = overlay, Stretch = Stretch.Uniform, IsHitTestVisible = false });
            };
            Action previewBubble = delegate
            {
                var colors = BubbleThemes[theme.SelectedIndex];
                bubble.Background = colors.Fill;
                bubble.BorderBrush = colors.Line;
                sample.FontSize = 14.5 * BubbleFontFactors[size.SelectedIndex];
            };
            apply = UtilityButton(actions, "应用", "appearance-apply", () =>
            {
                if (saving) return;
                readDraft();
                var skin = OpenShellSkin(draft.Shell);
                if (skin.Resolve(0) == null) { status.Text = "立绘已无法读取，草稿仍保留。"; return; }
                string previous = _shellName == draft.Shell ? _previousShellName : _shellName;
                bool scaleChanged = Math.Abs(draft.Scale - savedAtOpen.Scale) > 0.001;
                startSaving("正在保存外观…");
                SaveAppearance(draft, skin, previous, scaleChanged, error =>
                {
                    saving = false;
                    if (error == null)
                    {
                        savedAtOpen = CurrentAppearance();
                        selectSavedScale();
                    }
                    status.Text = error ?? "已应用。";
                    refresh();
                });
            });
            undo = UtilityButton(actions, "撤销换装", "appearance-undo", () =>
            {
                if (saving || string.IsNullOrEmpty(_previousShellName)) return;
                var original = CurrentAppearance();
                var selectedShellMatches = draft.Shell == original.Shell;
                original.Shell = _previousShellName;
                var skin = OpenShellSkin(original.Shell);
                if (skin.Resolve(0) == null) { status.Text = "上一套立绘已无法读取。"; return; }
                startSaving("正在保存撤销…");
                SaveAppearance(original, skin, null, false, error =>
                {
                    saving = false;
                    if (error == null)
                    {
                        savedAtOpen.Shell = _shellName;
                        if (selectedShellMatches) shell.SelectedIndex = names.IndexOf(_shellName);
                    }
                    status.Text = error ?? "已切回上一套立绘。";
                    refresh();
                });
            });
            close = UtilityButton(actions, "关闭", "appearance-close", () => win.Close());
            win.Closing += (sender, args) => { if (saving && !_closing) args.Cancel = true; };
            shell.SelectionChanged += delegate { showPreview(); };
            expression.SelectionChanged += delegate { showPreview(); };
            theme.SelectionChanged += delegate { previewBubble(); refresh(); };
            size.SelectionChanged += delegate { previewBubble(); refresh(); };
            scale.SelectionChanged += delegate { refresh(); };
            layer.SelectionChanged += delegate { refresh(); };
            delay.SelectionChanged += delegate { refresh(); };
            foreach (var option in new[] { hide, recall, motion })
            {
                option.Checked += delegate { refresh(); };
                option.Unchecked += delegate { refresh(); };
            }
            showPreview();
            previewBubble();
            win.Show();
        }
    }
}
