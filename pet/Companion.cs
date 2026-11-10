using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;

namespace UkagakaBangumi
{
    public partial class PetWindow
    {
        sealed class CompanionStory
        {
            public readonly string Id, Title, Opening, First, Second, FirstEnding, SecondEnding;
            public CompanionStory(string id, string title, string opening, string first, string second, string firstEnding, string secondEnding)
            {
                Id = id; Title = title; Opening = opening; First = first; Second = second;
                FirstEnding = firstEnding; SecondEnding = secondEnding;
            }
        }

        static readonly CompanionStory[] Stories =
        {
            new CompanionStory("first-page", "手账第一页",
                "会长，手账印歪了。第一页只够写一行。是写今天的日期，还是把位置留给我们第一次忘记看时间的那一晚？",
                "写下今天", "留一个空格",
                "日期写好了。我在下面画了一条很短的线。以后要是忘了从哪天开始，就沿着这条线找回来。",
                "那就空着。我夹了张纸条，免得以后以为自己漏填。上面写的是——等会长有空的时候。"),
            new CompanionStory("after-credits", "片尾之后",
                "片尾字幕都走完了，桌面还亮着。我本来要把这页归档……会长，最后一话该写「看完了」，还是「还想再看」？",
                "写「看完了」", "写「还想再看」",
                "好。「看完了」。我把句号写小一点，给你下次想起它的时候留个位置。",
                "那我先不夹书签。……等等，夹在第一话好了。万一有一天你想从头再来呢。"),
            new CompanionStory("next-season", "寄给下一季",
                "下一季的表还是空白。我想在页角给未来的我们留句话。你想提醒自己别追太多，还是记得把喜欢的留到有空的时候？",
                "别排太满", "把喜欢的留好",
                "我写了「留一个晚上给自己」。如果到时候你忘了，我可以装作这是学生会规定。",
                "写好了。等你有空，我把那一页翻给你。今天先合上，喜欢的东西可以慢慢看。"),
        };

        const int RecentLimit = 12;
        readonly List<string> _recentLines = new List<string>();
        Dictionary<string, int> _storyProgress = new Dictionary<string, int>();
        string _companionImport = "";
        DateTime _companionImportStamp;
        Window _companionWindow, _focusWindow;
        StackPanel _companionContent, _focusContent;
        TextBlock _focusStatus;
        CompanionStory _openStory;
        bool _showRecent;
        long _focusUntil, _quietUntil;
        int _focusPausedSeconds;
        bool _reminderTrayOnly;

        static T StateValue<T>(JavaScriptSerializer serializer, Dictionary<string, object> state, string key)
        {
            object value;
            return state.TryGetValue(key, out value) && value != null ? serializer.ConvertToType<T>(value) : default(T);
        }

        static Dictionary<string, int> ValidStoryProgress(Dictionary<string, int> progress)
        {
            var result = new Dictionary<string, int>();
            if (progress == null) return result;
            foreach (var story in Stories)
            {
                int step;
                if (progress.TryGetValue(story.Id, out step) && step >= 0 && step <= 2) result[story.Id] = step;
            }
            return result;
        }

        void LoadCompanionState(JavaScriptSerializer serializer, Dictionary<string, object> state)
        {
            _companionImport = StateValue<string>(serializer, state, "companion_import") ?? "";
            _storyProgress = ValidStoryProgress(StateValue<Dictionary<string, int>>(serializer, state, "stories"));
            var lines = StateValue<List<string>>(serializer, state, "recent_lines");
            if (lines != null)
            {
                _recentLines.AddRange(lines.FindAll(line => !string.IsNullOrEmpty(line) && line.Length <= 320));
                if (_recentLines.Count > RecentLimit) _recentLines.RemoveRange(0, _recentLines.Count - RecentLimit);
            }
            _focusUntil = StateValue<long>(serializer, state, "focus_until");
            _focusPausedSeconds = Math.Max(0, Math.Min(180 * 60, StateValue<int>(serializer, state, "focus_paused_seconds")));
            _quietUntil = StateValue<long>(serializer, state, "quiet_until");
            _reminderTrayOnly = StateValue<bool>(serializer, state, "reminder_tray_only");
        }

        void CheckCompanionImport()
        {
            if (_selfTest || _closing) return;
            string data = Path.Combine(_root, "data");
            string file = Path.Combine(data, "companion-import.json");
            string journal = Path.Combine(data, ".migration-pending.json");
            try
            {
                var stamp = File.GetLastWriteTimeUtc(file);
                if (stamp == _companionImportStamp || !File.Exists(file) || File.Exists(journal)) return;
                var serializer = new JavaScriptSerializer();
                Dictionary<string, object> envelope;
                using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                using (var reader = new StreamReader(stream, Encoding.UTF8))
                    envelope = serializer.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                if (File.Exists(journal)) return;
                string id = StateValue<string>(serializer, envelope, "id");
                if (id == _companionImport) { _companionImportStamp = stamp; return; }
                Guid key;
                var memory = StateValue<Dictionary<string, object>>(serializer, envelope, "companion");
                if (memory == null || !Guid.TryParseExact(id, "N", out key)) return;
                var progress = ValidStoryProgress(StateValue<Dictionary<string, int>>(serializer, memory, "stories"));
                string first = StateValue<string>(serializer, memory, "first_seen");
                DateTime meeting;
                if (DateTime.TryParseExact(first, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out meeting))
                {
                    SetU("first_seen", first);
                    int days = (DateTime.Now.Date - meeting).Days + 1;
                    foreach (int mark in new[] { 7, 30, 100, 200, 365 }) SetU("milestone_" + mark, days >= mark ? "1" : "0");
                }
                if (memory.ContainsKey("affinity"))
                    SetU("affinity", Math.Max(0, Math.Min(100, StateValue<int>(serializer, memory, "affinity"))).ToString(CultureInfo.InvariantCulture));
                _storyProgress = progress;
                string previousImport = _companionImport;
                _companionImport = id;
                if (!SaveState()) { _companionImport = previousImport; return; }
                _companionImportStamp = stamp;
                RefreshCompanion();
                Log("companion import applied");
            }
            catch (Exception ex) { Log("companion import: " + ex.Message); }
        }

        void RememberLine(string text)
        {
            if (text.Length > 320) text = text.Substring(0, char.IsHighSurrogate(text[318]) ? 318 : 319) + "…";
            if (_recentLines.Count > 0 && _recentLines[_recentLines.Count - 1] == text) return;
            if (_recentLines.Count >= RecentLimit) _recentLines.RemoveAt(0);
            _recentLines.Add(text);
            SaveState();
            if (_showRecent) RefreshCompanion();
        }

        Window UtilityWindow(string title, out StackPanel content)
        {
            if (!IsVisible) ShowFromTray();
            var panel = new StackPanel { Margin = new Thickness(18) };
            var window = new Window
            {
                Owner = this, Title = title, Width = 414, MinWidth = 340, MaxHeight = Math.Max(230, CurrentWorkAreaDip().Height - 40),
                SizeToContent = SizeToContent.Height, ShowInTaskbar = false, WindowStartupLocation = WindowStartupLocation.CenterScreen,
                Background = ScheduleWash, FontFamily = new System.Windows.Media.FontFamily("Microsoft YaHei UI"),
                Content = new ScrollViewer { Content = panel, VerticalScrollBarVisibility = ScrollBarVisibility.Auto }
            };
            window.PreviewKeyDown += (s, e) => { if (e.Key == Key.Escape) { e.Handled = true; window.Close(); } };
            content = panel;
            return window;
        }

        void UtilityText(Panel panel, string text, bool title = false)
        {
            var label = ScheduleText(text, title ? 19 : 13, title ? ScheduleInk : ScheduleMuted, title);
            label.TextWrapping = TextWrapping.Wrap;
            label.Margin = new Thickness(0, 0, 0, 9);
            panel.Children.Add(label);
        }

        Button UtilityButton(Panel panel, string text, string id, Action action)
        {
            var button = BubbleButton(text, text, false);
            AutomationProperties.SetAutomationId(button, id);
            button.Click += delegate { action(); };
            button.Margin = new Thickness(0, 0, 6, 6);
            panel.Children.Add(button);
            return button;
        }

        void OpenCompanion(bool recent)
        {
            CheckCompanionImport();
            _openStory = null;
            _showRecent = recent;
            if (_companionWindow == null)
            {
                _companionWindow = UtilityWindow("TIARA · 陪伴手账", out _companionContent);
                _companionWindow.Closed += delegate { _companionWindow = null; _companionContent = null; _showRecent = false; };
                RefreshCompanion();
                _companionWindow.Show();
            }
            else { RefreshCompanion(); _companionWindow.Activate(); }
        }

        void RefreshCompanion()
        {
            var panel = _companionContent;
            if (panel == null) return;
            panel.Children.Clear();
            var tabs = new WrapPanel();
            panel.Children.Add(tabs);
            UtilityButton(tabs, "手账", "companion-home", () => OpenCompanion(false));
            UtilityButton(tabs, "最近台词", "companion-recent", () => OpenCompanion(true));
            if (_showRecent)
            {
                UtilityText(panel, "最近台词", true);
                if (_recentLines.Count == 0) UtilityText(panel, "还没有台词。");
                for (int i = _recentLines.Count - 1; i >= 0; i--) UtilityText(panel, _recentLines[i]);
                return;
            }
            if (_openStory == null)
            {
                UtilityText(panel, "陪伴手账", true);
                UtilityText(panel, "首次见面 " + UV("first_seen", "—") + "　·　好感 " + UI("affinity") + " / 100");
                DateTime meeting;
                if (DateTime.TryParseExact(UV("first_seen", ""), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out meeting))
                {
                    int days = (DateTime.Today - meeting).Days + 1;
                    if (days > 0) UtilityText(panel, "今天是一起度过的第 " + days + " 天");
                }
                string watched = FirstCompletedEntry();
                if (watched != null) UtilityText(panel, watched);
                foreach (var story in Stories)
                {
                    int step;
                    string status = !_storyProgress.TryGetValue(story.Id, out step) ? "未读" : step == 0 ? "继续" : "回看";
                    var item = story;
                    UtilityButton(panel, story.Title + "　·　" + status, story.Id, () =>
                    {
                        CheckCompanionImport();
                        _openStory = item;
                        if (!_storyProgress.ContainsKey(item.Id)) { _storyProgress[item.Id] = 0; SaveState(); }
                        RefreshCompanion();
                    });
                }
                return;
            }
            var current = _openStory;
            int progress;
            _storyProgress.TryGetValue(current.Id, out progress);
            UtilityText(panel, current.Title, true);
            UtilityText(panel, current.Opening);
            if (progress > 0)
            {
                UtilityText(panel, "你的选择 · " + (progress == 1 ? current.First : current.Second));
                UtilityText(panel, progress == 1 ? current.FirstEnding : current.SecondEnding);
            }
            else
            {
                var choices = new WrapPanel();
                panel.Children.Add(choices);
                UtilityButton(choices, current.First, "story-choice-one", () => FinishStory(current, 1));
                UtilityButton(choices, current.Second, "story-choice-two", () => FinishStory(current, 2));
            }
        }

        void FinishStory(CompanionStory story, int choice)
        {
            CheckCompanionImport();
            int step;
            if (!_storyProgress.TryGetValue(story.Id, out step) || step != 0) return;
            _storyProgress[story.Id] = choice;
            SaveState();
            RefreshCompanion();
        }

        string FirstCompletedEntry()
        {
            try
            {
                string file = Path.Combine(_root, "data", "library.json");
                Dictionary<string, object> library;
                using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                using (var reader = new StreamReader(stream, Encoding.UTF8))
                    library = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                DateTime earliest = DateTime.MaxValue;
                string title = null;
                foreach (string list in new[] { "watching", "paused", "archived" })
                {
                    object entries;
                    var rows = library.TryGetValue(list, out entries) ? AsList(entries) : null;
                    if (rows == null) continue;
                    foreach (object entry in rows)
                    {
                        var row = entry as Dictionary<string, object>;
                        object episodes, progress, watched, name;
                        int total, seen;
                        DateTime date;
                        if (row == null || !row.TryGetValue("eps", out episodes) || !int.TryParse(Str(episodes), out total) || total <= 0 ||
                            !row.TryGetValue("ep_status", out progress) || !int.TryParse(Str(progress), out seen) || seen < total ||
                            !row.TryGetValue("last_watched", out watched) ||
                            !DateTime.TryParseExact(Str(watched), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out date) ||
                            date >= earliest) continue;
                        if (!row.TryGetValue("name_cn", out name) || string.IsNullOrWhiteSpace(Str(name))) row.TryGetValue("name", out name);
                        if (string.IsNullOrWhiteSpace(Str(name))) continue;
                        earliest = date;
                        title = Str(name);
                    }
                }
                return title == null ? null : "最早的看完记录 · " + earliest.ToString("yyyy-MM-dd") + " · " + title;
            }
            catch (Exception ex) { Log("companion journal: " + ex.Message); return null; }
        }

        bool FocusActive { get { return _focusUntil > 0 || _focusPausedSeconds > 0; } }
        bool AmbientQuiet { get { return FocusActive || _quietUntil > UnixNow(); } }

        void OpenFocus()
        {
            if (_focusWindow == null)
            {
                _focusWindow = UtilityWindow("TIARA · 专注与安静", out _focusContent);
                _focusWindow.Closed += delegate { _focusWindow = null; _focusContent = null; _focusStatus = null; };
                RefreshFocus();
                _focusWindow.Show();
            }
            else { RefreshFocus(); _focusWindow.Activate(); }
        }

        void FocusChanged()
        {
            if (AmbientQuiet) { CancelSequence(); DismissBubble(); }
            SaveState();
            RefreshFocus();
        }

        void StartFocus(int minutes)
        {
            if (FocusActive) return;
            _focusUntil = UnixNow() + minutes * 60;
            FocusChanged();
        }

        void ToggleFocusPause()
        {
            if (_focusUntil > 0)
            {
                int remaining = (int)(_focusUntil - UnixNow());
                if (remaining <= 0) { TickFocus(); return; }
                _focusPausedSeconds = remaining;
                _focusUntil = 0;
            }
            else if (_focusPausedSeconds > 0)
            {
                _focusUntil = UnixNow() + _focusPausedSeconds;
                _focusPausedSeconds = 0;
            }
            FocusChanged();
        }

        void RefreshFocus()
        {
            var panel = _focusContent;
            if (panel == null) return;
            panel.Children.Clear();
            UtilityText(panel, "专注与安静", true);
            _focusStatus = ScheduleText("", 20, ScheduleInk, true);
            _focusStatus.Margin = new Thickness(0, 0, 0, 10);
            AutomationProperties.SetAutomationId(_focusStatus, "focus-status");
            panel.Children.Add(_focusStatus);
            UpdateFocusLabel();
            var buttons = new WrapPanel();
            panel.Children.Add(buttons);
            if (FocusActive)
            {
                UtilityButton(buttons, _focusUntil > 0 ? "暂停" : "继续", "focus-pause", ToggleFocusPause);
                UtilityButton(buttons, "结束计时", "focus-end", () => { _focusUntil = 0; _focusPausedSeconds = 0; FocusChanged(); });
            }
            else
            {
                UtilityButton(buttons, "开始 25 分钟", "focus-25", () => StartFocus(25));
                var minutes = new TextBox { Text = "25", Width = 55, Margin = new Thickness(0, 0, 6, 6), VerticalContentAlignment = VerticalAlignment.Center };
                AutomationProperties.SetName(minutes, "自订分钟数");
                AutomationProperties.SetAutomationId(minutes, "focus-minutes");
                buttons.Children.Add(minutes);
                var status = ScheduleText("", 12, ScheduleMuted);
                UtilityButton(buttons, "自订分钟", "focus-custom", () =>
                {
                    int value;
                    if (int.TryParse(minutes.Text, out value) && value >= 1 && value <= 180) StartFocus(value);
                    else status.Text = "请输入 1–180 分钟。";
                });
                panel.Children.Add(status);
            }
            bool quiet = _quietUntil > UnixNow();
            UtilityButton(panel, quiet ? "取消临时安静" : "临时安静 30 分钟", "focus-quiet", () =>
            {
                _quietUntil = quiet ? 0 : UnixNow() + 30 * 60;
                FocusChanged();
            });
            UtilityText(panel, "专注和临时安静期间暂停闲聊与报时。");
            var tray = new CheckBox { Content = "开播提醒只走托盘", IsChecked = _reminderTrayOnly, Foreground = ScheduleInk };
            AutomationProperties.SetAutomationId(tray, "focus-tray-only");
            tray.Checked += delegate { _reminderTrayOnly = true; SaveState(); };
            tray.Unchecked += delegate { _reminderTrayOnly = false; SaveState(); };
            panel.Children.Add(tray);
            UtilityText(panel, "托盘模式全天生效。单番静音和免打扰优先于开播通知。");
        }

        void UpdateFocusLabel()
        {
            if (_focusStatus == null) return;
            int seconds = _focusUntil > 0 ? (int)Math.Max(0, _focusUntil - UnixNow()) : _focusPausedSeconds;
            string remaining = (seconds / 60).ToString("00") + ":" + (seconds % 60).ToString("00");
            _focusStatus.Text = (FocusActive ? (_focusUntil > 0 ? "剩余 " : "已暂停 ") + remaining : "计时待命") +
                (_quietUntil > UnixNow() ? " · 临时安静" : "");
        }

        void TickFocus()
        {
            long now = UnixNow();
            bool finished = _focusUntil > 0 && _focusUntil <= now;
            bool quietExpired = _quietUntil > 0 && _quietUntil <= now;
            if (!finished && !quietExpired) { UpdateFocusLabel(); return; }
            if (finished) _focusUntil = 0;
            if (quietExpired) _quietUntil = 0;
            SaveState();
            RefreshFocus();
            if (finished)
            {
                const string text = "时间到了。会长，先松一口气吧。";
                if (IsVisible && !AmbientQuiet) Say(new Line(text, 1), true);
                Notify("TIARA · 专注结束", text);
            }
        }
    }
}
