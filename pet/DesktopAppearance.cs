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

namespace UkagakaBangumi
{
    public partial class PetWindow
    {
        static readonly string[] WindowLayers = { "top", "normal", "bottom" };
        string _previousShellName;

        sealed class AppearanceDraft
        {
            public string Shell, Layer;
            public double Scale;
            public int Theme, TextSize, BubbleTime;
            public bool ReduceMotion, HideFullscreen, Recall;
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

        void ShowAppearance(AppearanceDraft draft, ShellSkin skin, string previousShell)
        {
            _previousShellName = previousShell;
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
            _bubbleThemeIndex = draft.Theme;
            _bubbleSizeIndex = draft.TextSize;
            _bubbleTimeIndex = draft.BubbleTime;
            _reduceMotion = draft.ReduceMotion;
            _hideFullscreen = draft.HideFullscreen;
            _recallKeyEnabled = draft.Recall;
            ApplyRecallHotkey(new WindowInteropHelper(this).Handle);
            ApplyBubbleTheme();
            UpdateLayout();
            if (BubbleReading) ApplyHeight(true);
            SnapIntoWorkArea();
        }

        bool SaveAppearance(AppearanceDraft draft, ShellSkin skin, string previousShell)
        {
            var before = CurrentAppearance();
            var previous = _previousShellName;
            var active = _activeSkin;
            ShowAppearance(draft, skin, previousShell);
            if (!SaveState())
            {
                ShowAppearance(before, active, previous);
                return false;
            }
            if (!_scaleFromEnv && Math.Abs(before.Scale - _requestedScale) > 0.001)
                QueueSettingsPatch("pet_scale", Math.Round(_requestedScale, 2));
            TickDesktopVisibility();
            return true;
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
            CompanionOption(display, "本屏全屏时暂时隐藏桌宠", "window-hide-fullscreen", draft.HideFullscreen, value => draft.HideFullscreen = value);
            CompanionOption(display, "启用找回快捷键 " + RecallKeys, "window-recall-hotkey", draft.Recall, value => draft.Recall = value);
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
            CompanionOption(bubbles, "减弱动画（立即显示全文）", "appearance-reduce-motion", draft.ReduceMotion, value => draft.ReduceMotion = value);
            var sample = new TextBlock { Text = "会长，今天的记录也写好了。", TextWrapping = TextWrapping.Wrap, Foreground = Ink };
            var bubble = new Border { Child = sample, Padding = new Thickness(12), Margin = new Thickness(0, 6, 0, 0),
                CornerRadius = new CornerRadius(10), BorderThickness = new Thickness(1) };
            bubbles.Children.Add(bubble);

            var status = ScheduleText("", 12, ScheduleMuted);
            status.TextWrapping = TextWrapping.Wrap;
            AutomationProperties.SetAutomationId(status, "appearance-status");
            footer.Children.Add(status);
            var actions = new WrapPanel { Margin = new Thickness(0, 6, 0, 0) };
            footer.Children.Add(actions);
            Button apply = null, undo = null;
            ShellSkin stagedSkin = null;
            string stagedName = null;
            Action refresh = delegate
            {
                current.Text = "正在使用 " + ShellDisplayName(_shellName);
                undo.IsEnabled = !string.IsNullOrEmpty(_previousShellName);
                undo.ToolTip = undo.IsEnabled ? "切回 " + ShellDisplayName(_previousShellName) : null;
                recallStatus.Text = !_recallKeyEnabled ? "也可从托盘找回桌宠。" : _recallKeyRegistered
                    ? "找回快捷键已启用。" : "快捷键当前不可用，可从托盘找回。";
                scaleHint.Text = _scaleFromEnv ? "尺寸由当前启动参数指定。" :
                    scales[scale.SelectedIndex] > MaxScale() ? "本屏放不下此尺寸，桌宠会暂时缩小。" : "";
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
                apply.IsEnabled = normal != null;
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
                draft.Shell = names[shell.SelectedIndex];
                var skin = OpenShellSkin(draft.Shell);
                if (skin.Resolve(0) == null) { status.Text = "立绘已无法读取，已保留当前外观。"; return; }
                draft.Layer = WindowLayers[layer.SelectedIndex];
                draft.Scale = scales[scale.SelectedIndex];
                draft.Theme = theme.SelectedIndex;
                draft.TextSize = size.SelectedIndex;
                draft.BubbleTime = delay.SelectedIndex;
                string previous = _shellName == draft.Shell ? _previousShellName : _shellName;
                status.Text = SaveAppearance(draft, skin, previous) ? "已应用。" : "外观保存失败，已恢复原设置。";
                refresh();
            });
            undo = UtilityButton(actions, "撤销换装", "appearance-undo", () =>
            {
                var original = CurrentAppearance();
                original.Shell = _previousShellName;
                var skin = OpenShellSkin(original.Shell);
                if (skin.Resolve(0) == null) { status.Text = "上一套立绘已无法读取，已保留当前外观。"; return; }
                if (SaveAppearance(original, skin, null))
                {
                    shell.SelectedIndex = names.IndexOf(_shellName);
                    status.Text = "已切回上一套立绘。";
                }
                else status.Text = "撤销未能保存，已保留当前外观。";
                refresh();
            });
            UtilityButton(actions, "取消", "appearance-close", () => win.Close());
            shell.SelectionChanged += delegate { showPreview(); };
            expression.SelectionChanged += delegate { showPreview(); };
            theme.SelectionChanged += delegate { previewBubble(); };
            size.SelectionChanged += delegate { previewBubble(); };
            scale.SelectionChanged += delegate { refresh(); };
            refresh();
            showPreview();
            previewBubble();
            win.Show();
        }
    }
}
