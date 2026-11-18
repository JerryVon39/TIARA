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
            public readonly int RequiredAffinity;
            public CompanionStory(string id, string title, string opening, string first, string second, string firstEnding, string secondEnding, int requiredAffinity = 0)
            {
                Id = id; Title = title; Opening = opening; First = first; Second = second;
                FirstEnding = firstEnding; SecondEnding = secondEnding;
                RequiredAffinity = requiredAffinity;
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
            new CompanionStory("two-cups", "两杯茶",
                "办公室有两只杯子。一只放在我的记录簿旁，一只给会长。下次见面，先喝茶，还是先看今天的安排？",
                "先喝茶", "先说今天的安排",
                "我把茶杯放在门边了。下次你一来，我就先把杯子递给你。",
                "好。今日安排放在最上面，茶放右手边。会长进门就能看到。", 20),
            new CompanionStory("after-duty", "值日后的十分钟",
                "值日结束以后，还有十分钟才到锁门的时间。会长想安静坐一会儿，还是让我记得叫你起来休息？",
                "让我安静一会儿", "提醒我休息",
                "好。我只说一声时间到了。剩下的事，等会长准备好再聊。",
                "那我会提醒你放下笔，喝水，走两步。工作可以等十分钟。", 45),
            new CompanionStory("president-note", "给会长的便笺",
                "我写了一张便笺，写到最后才想起，学生会的便笺要有落款。会长想把它夹在手账里，还是贴在最后一页？",
                "夹在手账里", "贴在最后一页",
                "会长，今天看到哪里，我都替你记着。没做完的事，明天来得及。\n——TIARA",
                "会长，下次翻到这里时，可以从你喜欢的那一页开始。值日室的灯，我给你留着。\n——TIARA", 75),
        };

        public sealed class AffinityDay
        {
            public string date { get; set; }
            public int touch { get; set; }
            public string activity { get; set; }
            public int activity_points { get; set; }
            public int story { get; set; }
        }

        public sealed class HolidayLetter
        {
            public string received { get; set; }
            public bool read { get; set; }
            public bool announced { get; set; }
        }

        static readonly int[] RelationshipThresholds = { 0, 20, 45, 75 };
        static readonly string[] RelationshipNames = { "初识", "熟络", "默契", "信赖" };
        AffinityDay _affinityDay = new AffinityDay();
        const int RecentLimit = 12;
        const int FavoriteLimit = 50;
        readonly List<string> _recentLines = new List<string>();
        List<string> _favoriteLines = new List<string>();
        string _firstDuty = "";
        HolidayLetter _newYearLetter;
        bool _idleChatter = true, _hourlyChatter = true, _reduceMotion;
        int _bubbleTimeIndex;
        Action _pendingChatter;
        bool _pendingHour;
        long _chatterExpires;
        Dictionary<string, int> _storyProgress = new Dictionary<string, int>();
        string _companionImport = "";
        DateTime _companionImportStamp;
        Window _companionWindow, _focusWindow;
        StackPanel _companionContent, _focusContent;
        TextBlock _focusStatus;
        CompanionStory _openStory;
        int _companionTab;
        long _focusUntil, _quietUntil;
        int _focusPausedSeconds;
        int _focusMinutes = 25;
        bool _reminderTrayOnly;
        bool _chooseDuty, _focusDuty;

        bool BubbleReading
        {
            get { return _bubbleHost != null && _bubbleHost.Visibility == Visibility.Visible; }
        }

        bool CompanionReading
        {
            get { return (_companionWindow != null && _companionWindow.IsVisible) || (_dialogueWindow != null && _dialogueWindow.IsVisible); }
        }
        bool ReducePetMotion { get { return _reduceMotion || !SystemParameters.ClientAreaAnimation; } }

        bool ChatterCanSpeak
        {
            get { return IsVisible && !_closing && !_dragging && !BubbleReading && !CompanionReading && _seq == null; }
        }

        bool ReminderCanSpeak
        {
            get
            {
                return IsVisible && !_reminderTrayOnly && !_dragging && !BubbleReading && !CompanionReading && _seq == null;
            }
        }

        void OfferChatter(Action speak, bool hourly = false)
        {
            if (AmbientQuiet || !IsVisible || (hourly ? !_hourlyChatter : !_idleChatter)) return;
            long now = UnixNow();
            if (_pendingChatter != null && _pendingHour && !hourly && now < _chatterExpires && _hourlyChatter) return;
            _pendingChatter = speak;
            _pendingHour = hourly;
            _chatterExpires = now + (hourly ? 300 : 120);
            TryChatter();
        }

        void TryChatter()
        {
            if (_pendingChatter == null) return;
            if (AmbientQuiet || !IsVisible || UnixNow() >= _chatterExpires || (_pendingHour ? !_hourlyChatter : !_idleChatter))
            {
                _pendingChatter = null;
                return;
            }
            if (!ChatterCanSpeak) return;
            var speak = _pendingChatter;
            _pendingChatter = null;
            speak();
        }

        static string CompanionDate(string value)
        {
            DateTime date;
            return DateTime.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out date) ? value : "";
        }

        static HolidayLetter ValidHolidayLetter(HolidayLetter letter)
        {
            DateTime received;
            return letter != null &&
                DateTime.TryParseExact(letter.received, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out received) &&
                received.Month == 1 && received.Day <= 7 ? letter : null;
        }

        void TickHolidayLetter(DateTime now)
        {
            if (_selfTest || _closing || now.Month != 1 || now.Day > 7) return;
            if (_newYearLetter == null)
            {
                _newYearLetter = new HolidayLetter { received = now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) };
                if (!SaveState()) { _newYearLetter = null; return; }
                if (_companionTab == 4 || (_companionTab == 0 && _openStory == null)) RefreshCompanion();
            }
            if (_newYearLetter.read || _newYearLetter.announced || !_idleChatter || AmbientQuiet ||
                !_newYearLetter.received.StartsWith(now.Year.ToString(CultureInfo.InvariantCulture) + "-", StringComparison.Ordinal) ||
                ReminderQuiet(ReadReminderSettings(), UnixNow())) return;
            _newYearLetter.announced = true;
            if (!SaveState()) { _newYearLetter.announced = false; return; }
            Notify("TIARA · 元旦来信", "会长，陪伴手账里有一封信。什么时候想读，什么时候来。");
        }

        static List<string> ValidFavorites(List<string> lines)
        {
            var result = new List<string>();
            var seen = new HashSet<string>();
            if (lines == null) return result;
            foreach (string line in lines)
            {
                if (string.IsNullOrWhiteSpace(line) || line.Length > 320 || !seen.Add(line)) continue;
                result.Add(line);
                if (result.Count == FavoriteLimit) break;
            }
            return result;
        }

        static string AffinityDate() { return DateTime.UtcNow.AddHours(8).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture); }

        AffinityDay AffinityToday()
        {
            string date = AffinityDate();
            if (_affinityDay.date != date) _affinityDay = new AffinityDay { date = date };
            return _affinityDay;
        }

        int RelationshipStage
        {
            get
            {
                int affinity = UI("affinity");
                for (int i = RelationshipThresholds.Length - 1; i > 0; i--)
                    if (affinity >= RelationshipThresholds[i]) return i;
                return 0;
            }
        }

        int AddAffinity(int points)
        {
            int current = Math.Max(0, Math.Min(100, UI("affinity")));
            int gain = Math.Min(points, 100 - current);
            SetU("affinity", (current + gain).ToString(CultureInfo.InvariantCulture));
            return gain;
        }

        void AwardTouchAffinity(int points)
        {
            CheckCompanionImport();
            var day = AffinityToday();
            day.touch += AddAffinity(Math.Min(points, Math.Max(0, 3 - day.touch)));
        }

        int CompleteCompanionActivity(string kind)
        {
            CheckCompanionImport();
            var day = AffinityToday();
            if (!string.IsNullOrEmpty(day.activity)) return 0;
            day.activity = kind;
            day.activity_points = AddAffinity(2);
            return day.activity_points;
        }

        void InviteToTea()
        {
            SayWithChoices(new Line("茶泡好了，会长。想坐一会儿吗？", 1),
                new Choice("一起喝茶", () =>
                {
                    int gain = CompleteCompanionActivity("tea");
                    SaveState();
                    RefreshCompanion();
                    Say(new Line("今天的记录先翻到这里。……茶刚好能喝。" +
                        (gain > 0 ? "\n好感 +" + gain : ""), 1), true);
                }), new Choice("晚点再喝", delegate { }));
        }

        Line RelationshipGreeting(Dictionary<string, string> context)
        {
            string[] lines = {
                "{nickname}，副会长到任。今天的记录已经打开了。",
                "{nickname}，你来了。我把常用的那页翻好了。",
                "{nickname}，今天也从上次停下的地方接着来吧。",
                "{nickname}，你的座位留好了。我在这里。"
            };
            int choice;
            string preference = "";
            if (_storyProgress.TryGetValue("two-cups", out choice))
            {
                if (choice == 1) preference = "先坐一会儿，茶还热着。";
                if (choice == 2) preference = "今天有 {count} 部排片，我把清单放在手边了。";
            }
            return new Line(FillCtx(lines[RelationshipStage] + preference, context), RelationshipStage > 0 ? 1 : 0);
        }

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
            _affinityDay = StateValue<AffinityDay>(serializer, state, "affinity_daily") ?? new AffinityDay();
            var lines = StateValue<List<string>>(serializer, state, "recent_lines");
            if (lines != null)
            {
                _recentLines.AddRange(lines.FindAll(line => !string.IsNullOrEmpty(line) && line.Length <= 320));
                if (_recentLines.Count > RecentLimit) _recentLines.RemoveRange(0, _recentLines.Count - RecentLimit);
            }
            _focusUntil = StateValue<long>(serializer, state, "focus_until");
            _focusPausedSeconds = Math.Max(0, Math.Min(180 * 60, StateValue<int>(serializer, state, "focus_paused_seconds")));
            int duration = StateValue<int>(serializer, state, "focus_minutes");
            if (duration >= 1 && duration <= 180) _focusMinutes = duration;
            _focusDuty = FocusActive && StateValue<bool>(serializer, state, "focus_duty");
            _quietUntil = StateValue<long>(serializer, state, "quiet_until");
            _reminderTrayOnly = StateValue<bool>(serializer, state, "reminder_tray_only");
            _favoriteLines = ValidFavorites(StateValue<List<string>>(serializer, state, "favorite_lines"));
            _firstDuty = CompanionDate(StateValue<string>(serializer, state, "first_duty"));
            _newYearLetter = ValidHolidayLetter(StateValue<HolidayLetter>(serializer, state, "new_year_letter"));
            if (state.ContainsKey("idle_chatter")) _idleChatter = StateValue<bool>(serializer, state, "idle_chatter");
            if (state.ContainsKey("hourly_chatter")) _hourlyChatter = StateValue<bool>(serializer, state, "hourly_chatter");
            _bubbleTimeIndex = Math.Max(0, Math.Min(3, StateValue<int>(serializer, state, "bubble_time")));
            _reduceMotion = StateValue<bool>(serializer, state, "reduce_motion");
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
                var desktop = StateValue<Dictionary<string, object>>(serializer, envelope, "desktop");
                if (!Guid.TryParseExact(id, "N", out key) || (memory == null && desktop == null)) return;
                if (memory != null)
                {
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
                    _storyProgress = ValidStoryProgress(StateValue<Dictionary<string, int>>(serializer, memory, "stories"));
                    _affinityDay = StateValue<AffinityDay>(serializer, memory, "affinity_daily") ?? new AffinityDay();
                    if (memory.ContainsKey("first_duty"))
                        _firstDuty = CompanionDate(StateValue<string>(serializer, memory, "first_duty"));
                    if (memory.ContainsKey("new_year_letter"))
                        _newYearLetter = ValidHolidayLetter(StateValue<HolidayLetter>(serializer, memory, "new_year_letter"));
                }
                if (desktop != null)
                {
                    if (desktop.ContainsKey("favorites"))
                        _favoriteLines = ValidFavorites(StateValue<List<string>>(serializer, desktop, "favorites"));
                    ApplyDesktopImport(serializer, desktop);
                }
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
            if (_companionTab == 1) RefreshCompanion();
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
            RecordQuickUse("companion");
            OpenCompanionTab(recent ? 1 : 0);
        }

        void OpenCompanionTab(int tab)
        {
            CheckCompanionImport();
            _openStory = null;
            _companionTab = tab;
            if (_companionWindow == null)
            {
                _companionWindow = UtilityWindow("TIARA · 陪伴手账", out _companionContent);
                _companionWindow.Closed += delegate
                {
                    StopCompanionSpeech("已停止朗读。");
                    _companionWindow = null;
                    _companionContent = null;
                    _companionTab = 0;
                };
                RefreshCompanion();
                _companionWindow.Show();
            }
            else { RefreshCompanion(); _companionWindow.Activate(); }
        }

        CheckBox CompanionOption(Panel panel, string label, string id, bool value, Action<bool> change)
        {
            var option = new CheckBox { Content = label, IsChecked = value, Foreground = ScheduleInk, Margin = new Thickness(0, 5, 0, 5) };
            AutomationProperties.SetAutomationId(option, id);
            option.Checked += delegate { change(true); };
            option.Unchecked += delegate { change(false); };
            panel.Children.Add(option);
            return option;
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
            UtilityButton(tabs, "收藏", "companion-favorites", () => OpenCompanionTab(2));
            UtilityButton(tabs, _newYearLetter != null && !_newYearLetter.read ? "来信（未读）" : "来信",
                "companion-letter", () => OpenCompanionTab(4));
            UtilityButton(tabs, "偏好", "companion-preferences", () => OpenCompanionTab(3));
            if (_companionTab == 4)
            {
                ShowHolidayLetter(panel);
                return;
            }
            if (_companionTab == 3)
            {
                UtilityText(panel, "陪伴偏好", true);
                CompanionOption(panel, "启动问候和闲聊", "companion-idle-chatter", _idleChatter, value => { _idleChatter = value; SaveState(); });
                CompanionOption(panel, "整点报时", "companion-hourly-chatter", _hourlyChatter, value => { _hourlyChatter = value; SaveState(); });
                UtilityText(panel, "专注和临时安静时，桌宠暂停闲聊与报时。");
                CompanionSpeechOptions(panel);
                return;
            }
            if (_companionTab == 1 || _companionTab == 2)
            {
                bool favorites = _companionTab == 2;
                var lines = favorites ? _favoriteLines : _recentLines;
                UtilityText(panel, favorites ? "收藏台词 · " + lines.Count + " / " + FavoriteLimit : "最近台词", true);
                if (lines.Count == 0) UtilityText(panel, "这里还没有台词。");
                var status = ScheduleText("", 12, ScheduleMuted);
                panel.Children.Add(status);
                if (lines.Count > 0) UtilityButton(panel, "停止朗读", "companion-speech-stop", () => StopCompanionSpeech("已停止朗读。"));
                for (int i = lines.Count - 1; i >= 0; i--)
                {
                    string line = lines[i];
                    UtilityText(panel, line);
                    var actions = new WrapPanel { Margin = new Thickness(0, 0, 0, 8) };
                    panel.Children.Add(actions);
                    UtilityButton(actions, "复制", "companion-copy-" + i, () =>
                    {
                        try { Clipboard.SetText(line); status.Text = "已复制台词。"; }
                        catch (System.Runtime.InteropServices.ExternalException) { status.Text = "剪贴板忙，请稍候重试。"; }
                    });
                    UtilityButton(actions, "朗读", "companion-speech-" + i, () => ReadCompanionLine(line, status));
                    bool saved = _favoriteLines.Contains(line);
                    var toggle = UtilityButton(actions, saved ? "取消收藏" : "收藏", "companion-favorite-" + i, () =>
                    {
                        var previous = new List<string>(_favoriteLines);
                        if (saved) _favoriteLines.Remove(line);
                        else if (_favoriteLines.Count < FavoriteLimit) _favoriteLines.Add(line);
                        if (!SaveState()) { _favoriteLines = previous; status.Text = "暂时无法保存，请稍候重试。"; return; }
                        RefreshCompanion();
                    });
                    toggle.IsEnabled = saved || _favoriteLines.Count < FavoriteLimit;
                }
                return;
            }
            if (_openStory == null)
            {
                UtilityText(panel, "陪伴手账", true);
                UtilityText(panel, "首次见面 " + UV("first_seen", "—") + "　·　好感 " + UI("affinity") + " / 100");
                int stage = RelationshipStage;
                UtilityText(panel, "关系 · " + RelationshipNames[stage] + (stage + 1 < RelationshipNames.Length ?
                    "　距「" + RelationshipNames[stage + 1] + "」还差 " + (RelationshipThresholds[stage + 1] - UI("affinity")) + " 点" : "　已达最高阶段"));
                var today = AffinityToday();
                UtilityText(panel, "今日好感 · 摸头与拥抱 +" + today.touch + " / 3　陪伴 +" + today.activity_points + " / 2　剧情 +" + today.story);
                if (!string.IsNullOrEmpty(today.activity)) UtilityText(panel, "今日陪伴 · 已完成" + (today.activity == "tea" ? "喝茶" : "值日"));
                var actions = new WrapPanel();
                panel.Children.Add(actions);
                UtilityButton(actions, "喝杯茶", "companion-tea", InviteToTea);
                UtilityButton(actions, "一起值日", "companion-duty", () => OpenFocus(true));
                UtilityButton(actions, "对白试演", "companion-dialogue", OpenDialoguePrototype);
                DateTime meeting;
                if (DateTime.TryParseExact(UV("first_seen", ""), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out meeting))
                {
                    int days = (DateTime.Today - meeting).Days + 1;
                    if (days > 0) UtilityText(panel, "今天是一起度过的第 " + days + " 天");
                }
                string watched = FirstCompletedEntry();
                if (watched != null) UtilityText(panel, watched);
                if (_firstDuty.Length > 0) UtilityText(panel, "第一次一起值日 · " + _firstDuty);
                foreach (var story in Stories)
                {
                    int step;
                    bool started = _storyProgress.TryGetValue(story.Id, out step);
                    bool unlocked = started || UI("affinity") >= story.RequiredAffinity;
                    string status = !unlocked ? "好感 " + story.RequiredAffinity + " 解锁" : !started ? "未读" : step == 0 ? "继续" : "回看";
                    var item = story;
                    UtilityButton(panel, story.Title + "　·　" + status, story.Id, () =>
                    {
                        CheckCompanionImport();
                        if (!_storyProgress.ContainsKey(item.Id) && UI("affinity") < item.RequiredAffinity) return;
                        _openStory = item;
                        if (!_storyProgress.ContainsKey(item.Id)) { _storyProgress[item.Id] = 0; SaveState(); }
                        RefreshCompanion();
                    }).IsEnabled = unlocked;
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
                if (current.Id == "president-note") UtilityText(panel, "来自 TIARA 的便笺", true);
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

        void ShowHolidayLetter(StackPanel panel)
        {
            UtilityText(panel, "元旦来信", true);
            if (_newYearLetter == null)
            {
                UtilityText(panel, "1 月 1 日至 7 日启动桌宠，会收到这封信。收到后可以随时回看。");
                return;
            }
            UtilityText(panel, "收到于 " + _newYearLetter.received);
            if (!_newYearLetter.read)
            {
                var status = ScheduleText("", 12, ScheduleMuted);
                UtilityButton(panel, "拆开信封", "companion-letter-read", () =>
                {
                    _newYearLetter.read = true;
                    if (SaveState()) RefreshCompanion();
                    else { _newYearLetter.read = false; status.Text = "暂时无法保存，请稍候重试。"; }
                });
                panel.Children.Add(status);
                return;
            }
            UtilityText(panel, "会长，新年好。");
            UtilityText(panel, "我翻到去年的记录簿，发现有几格还是空的。本来想顺手填上，想了想，又把笔放回去了。那几天也许只是想休息。这样也很好。");
            UtilityText(panel, "今年的第一页，我给你留了一整行。想追什么，什么时候看，都等你自己写。今天先喝杯茶吧，水刚烧开。");
            UtilityText(panel, "TIARA");
        }

        void FinishStory(CompanionStory story, int choice)
        {
            CheckCompanionImport();
            int step;
            if (!_storyProgress.TryGetValue(story.Id, out step) || step != 0) return;
            _storyProgress[story.Id] = choice;
            if (story.RequiredAffinity > 0) AffinityToday().story += AddAffinity(3);
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
                        object watched, name;
                        DateTime date;
                        if (row == null || !FinishedWatch(row) ||
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

        void OpenFocus(bool duty = false)
        {
            _chooseDuty = duty;
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
            if (AmbientQuiet)
            {
                CancelSequence();
                DismissBubble();
                StopCompanionSpeech("已停止朗读，进入专注或临时安静。");
            }
            SaveState();
            RefreshFocus();
        }

        void StartFocus(int minutes)
        {
            if (FocusActive) return;
            _focusMinutes = minutes;
            _focusDuty = _chooseDuty;
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
            UtilityText(panel, (FocusActive ? _focusDuty : _chooseDuty) ? "一起值日" : "专注与安静", true);
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
                UtilityButton(buttons, "结束计时", "focus-end", () =>
                {
                    _focusUntil = 0;
                    _focusPausedSeconds = 0;
                    _focusDuty = false;
                    FocusChanged();
                });
            }
            else
            {
                UtilityButton(buttons, (_chooseDuty ? "值日 " : "开始 ") + _focusMinutes + " 分钟", "focus-last-duration", () => StartFocus(_focusMinutes));
                var minutes = new TextBox { Text = _focusMinutes.ToString(CultureInfo.InvariantCulture),
                    Width = 55, Margin = new Thickness(0, 0, 6, 6), VerticalContentAlignment = VerticalAlignment.Center };
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
            var quietOptions = new WrapPanel();
            panel.Children.Add(quietOptions);
            foreach (int minutes in new[] { 15, 30, 60 })
            {
                int selected = minutes;
                UtilityButton(quietOptions, "安静 " + minutes + " 分钟", "focus-quiet-" + minutes, () =>
                {
                    _quietUntil = UnixNow() + selected * 60;
                    FocusChanged();
                });
            }
            if (quiet) UtilityButton(quietOptions, "取消临时安静", "focus-quiet-cancel", () =>
            {
                _quietUntil = 0;
                FocusChanged();
            });
            UtilityText(panel, "专注暂停闲聊和报时。临时安静也会静音桌宠的开播与补番通知。");
            var tray = new CheckBox { Content = "开播与补番提醒只走托盘", IsChecked = _reminderTrayOnly, Foreground = ScheduleInk };
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
            bool duty = finished && _focusDuty;
            if (finished)
            {
                _focusUntil = 0;
                _focusDuty = false;
            }
            if (quietExpired) _quietUntil = 0;
            if (duty && _firstDuty.Length == 0) _firstDuty = AffinityDate();
            int gain = duty ? CompleteCompanionActivity("duty") : 0;
            SaveState();
            RefreshFocus();
            if (duty) RefreshCompanion();
            if (finished)
            {
                string text = "时间到了。会长，先松一口气吧。";
                int choice;
                if (duty && _storyProgress.TryGetValue("after-duty", out choice))
                {
                    if (choice == 1) text = "时间到了。剩下的，等会长准备好再说。";
                    if (choice == 2) text = "值日结束。会长，喝口水，起来走两步吧。";
                }
                if (gain > 0) text += "\n好感 +" + gain;
                if (!AmbientQuiet && ChatterCanSpeak) Say(new Line(text, 1), true);
                Notify(duty ? "TIARA · 值日结束" : "TIARA · 专注结束", text);
            }
        }
    }
}
