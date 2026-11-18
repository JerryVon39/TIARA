using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace UkagakaBangumi
{
    public partial class PetWindow
    {
        public sealed class DesktopNote
        {
            public string Id { get; set; }
            public string Text { get; set; }
            public string ShowId { get; set; }
            public string ShowName { get; set; }
            public bool Done { get; set; }
            public long DueAt { get; set; }
            public long NotifiedAt { get; set; }

            public DesktopNote Copy() { return (DesktopNote)MemberwiseClone(); }
        }

        sealed class BubbleTheme
        {
            public readonly string Name;
            public readonly Brush Fill, Line, Accent, Button, Hover;
            public BubbleTheme(string name, string fill, string line, string accent, string button, string hover)
            {
                Name = name;
                var colors = new BrushConverter();
                Fill = (Brush)colors.ConvertFromString(fill);
                Line = (Brush)colors.ConvertFromString(line);
                Accent = (Brush)colors.ConvertFromString(accent);
                Button = (Brush)colors.ConvertFromString(button);
                Hover = (Brush)colors.ConvertFromString(hover);
            }
        }

        static readonly BubbleTheme[] BubbleThemes =
        {
            new BubbleTheme("暖白", "#F4FFFDF8", "#DCCDB6", "#933D38", "#F8EDE1", "#F3DBD1"),
            new BubbleTheme("樱粉", "#F8FFF2F5", "#E6B8C3", "#8A3E58", "#F9E2EA", "#F3CEDD"),
            new BubbleTheme("晴蓝", "#F8F0F8FF", "#A7C9DF", "#235B7C", "#DEEFFF", "#CCE4F6"),
        };
        static readonly double[] BubbleFontFactors = { 0.9, 1, 1.2 };
        const int NoteLimit = 30;
        List<DesktopNote> _notes = new List<DesktopNote>();
        Window _notesWindow, _appearanceWindow;
        StackPanel _notesContent;
        bool _showCompletedNotes;
        bool _editingNote;
        string _notesQuery = "";
        int _notesSort;
        long _nextNoteCheck;
        const long LastNoteSecond = 253402214399L;
        string _shellName = "master";
        int _bubbleThemeIndex, _bubbleSizeIndex = 1;
        TextBlock _bubbleHeading;
        Button _bubbleClose;

        BubbleTheme ActiveBubbleTheme { get { return BubbleThemes[_bubbleThemeIndex]; } }
        string ActiveShellPath { get { return Path.Combine(_root, "shell", _shellName); } }

        void LoadDesktopExtras(JavaScriptSerializer serializer, Dictionary<string, object> state)
        {
            var notes = StateValue<List<DesktopNote>>(serializer, state, "desktop_notes");
            if (notes != null) ReplaceDesktopNotes(notes);
            _notesSort = Math.Max(0, Math.Min(2, StateValue<int>(serializer, state, "notes_sort")));
            string shell = StateValue<string>(serializer, state, "desktop_shell");
            if (ShellOptions().Contains(shell)) _shellName = shell;
            if (state.ContainsKey("bubble_theme"))
                _bubbleThemeIndex = Math.Max(0, Math.Min(BubbleThemes.Length - 1, StateValue<int>(serializer, state, "bubble_theme")));
            if (state.ContainsKey("bubble_size"))
                _bubbleSizeIndex = Math.Max(0, Math.Min(BubbleFontFactors.Length - 1, StateValue<int>(serializer, state, "bubble_size")));
        }

        void ReplaceDesktopNotes(List<DesktopNote> notes)
        {
            var restored = new List<DesktopNote>();
            var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var note in notes)
            {
                Guid id;
                if (note == null || !Guid.TryParseExact(note.Id, "N", out id) || !ids.Add(note.Id) ||
                    string.IsNullOrWhiteSpace(note.Text) || note.Text.Length > 240) continue;
                if (note.DueAt < 0 || note.DueAt > LastNoteSecond) note.DueAt = 0;
                if (note.DueAt == 0 || note.NotifiedAt < note.DueAt || note.NotifiedAt > LastNoteSecond) note.NotifiedAt = 0;
                restored.Add(note);
                if (restored.Count == NoteLimit) break;
            }
            _notes = restored;
        }

        void ApplyDesktopImport(JavaScriptSerializer serializer, Dictionary<string, object> desktop)
        {
            var notes = StateValue<List<DesktopNote>>(serializer, desktop, "notes");
            if (notes != null)
            {
                ReplaceDesktopNotes(notes);
                RefreshNotes();
            }
            var appearance = StateValue<Dictionary<string, object>>(serializer, desktop, "appearance");
            if (appearance == null) return;
            string requested = StateValue<string>(serializer, appearance, "shell");
            string shell = ShellOptions().Contains(requested) ? requested : "master";
            bool changedShell = shell != _shellName;
            _shellName = shell;
            _bubbleThemeIndex = Math.Max(0, Math.Min(BubbleThemes.Length - 1, StateValue<int>(serializer, appearance, "theme")));
            _bubbleSizeIndex = Math.Max(0, Math.Min(BubbleFontFactors.Length - 1, StateValue<int>(serializer, appearance, "size")));
            if (appearance.ContainsKey("bubble_time"))
                _bubbleTimeIndex = Math.Max(0, Math.Min(3, StateValue<int>(serializer, appearance, "bubble_time")));
            if (appearance.ContainsKey("reduce_motion")) _reduceMotion = StateValue<bool>(serializer, appearance, "reduce_motion");
            if (appearance.ContainsKey("idle_chatter")) _idleChatter = StateValue<bool>(serializer, appearance, "idle_chatter");
            if (appearance.ContainsKey("hourly_chatter")) _hourlyChatter = StateValue<bool>(serializer, appearance, "hourly_chatter");
            double scale = ClampScale(StateValue<double>(serializer, appearance, "scale"));
            if (_bubbleSkin == null)
            {
                if (!_scaleFromEnv) _scale = scale;
                return;
            }
            if (_appearanceWindow != null) _appearanceWindow.Close();
            DismissBubble();
            if (!_scaleFromEnv) ApplyScale(scale, false, false);
            if (changedShell) LoadShell();
            ApplyBubbleTheme();
        }

        static Uri ViewingUri(string value)
        {
            Uri uri;
            if (string.IsNullOrEmpty(value) || value.Length > 2048 ||
                (!value.StartsWith("https://", StringComparison.OrdinalIgnoreCase) && !value.StartsWith("http://", StringComparison.OrdinalIgnoreCase)))
                return null;
            foreach (char c in value) if (char.IsWhiteSpace(c) || char.IsControl(c) || c == '\\') return null;
            return Uri.TryCreate(value, UriKind.Absolute, out uri) && uri.Host.Length > 0 && uri.UserInfo.Length == 0 ? uri : null;
        }

        void OpenViewingLink(string value)
        {
            var uri = ViewingUri(value);
            if (uri == null) return;
            try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); }
            catch (Exception ex)
            {
                Log("could not open viewing link: " + ex.GetType().Name);
                Say(new Line("打开观看链接失败。", 2), true);
            }
        }

        void OpenNotes()
        {
            RecordQuickUse("notes");
            if (_notesWindow != null) { _notesWindow.Activate(); return; }
            _notesWindow = UtilityWindow("TIARA · 桌面便条", out _notesContent);
            _notesWindow.WindowStartupLocation = WindowStartupLocation.Manual;
            _notesWindow.Width = 356;
            _notesWindow.SizeChanged += delegate { PlaceNotes(); };
            _notesWindow.Closed += delegate { _notesWindow = null; _notesContent = null; _editingNote = false; };
            RefreshNotes();
            PlaceNotes();
            _notesWindow.Show();
        }

        void PlaceNotes()
        {
            var notes = _notesWindow;
            if (notes == null || double.IsNaN(Left) || double.IsNaN(Top)) return;
            var work = CurrentWorkAreaDip();
            double atRight = Left + Width + 10;
            double x = atRight + notes.Width <= work.Right ? atRight : Left - notes.Width - 10;
            double y = _bubbleBelow ? Top : Top + Height - (ScaledH + 12);
            notes.Left = Math.Max(work.Left, Math.Min(x, work.Right - notes.Width));
            notes.Top = Math.Max(work.Top, Math.Min(y, work.Bottom - Math.Max(100, notes.ActualHeight)));
        }

        void RefreshNotes()
        {
            var panel = _notesContent;
            if (panel == null) return;
            _editingNote = false;
            panel.Children.Clear();
            UtilityText(panel, "桌面便条", true);
            var tools = new WrapPanel();
            panel.Children.Add(tools);
            UtilityButton(tools, "新便条", "note-new", () => EditNote(null)).IsEnabled = _notes.Count < NoteLimit;
            int done = _notes.FindAll(note => note.Done).Count;
            UtilityButton(tools, (_showCompletedNotes ? "收起已完成 " : "已完成 ") + done, "note-completed", () =>
            {
                _showCompletedNotes = !_showCompletedNotes;
                RefreshNotes();
            }).IsEnabled = done > 0;
            if (_notes.Count >= NoteLimit) UtilityText(panel, "便条已满。可在「已完成」里删除旧便条。");
            var search = new TextBox { Text = _notesQuery, Margin = new Thickness(0, 0, 0, 6), MaxLength = 120 };
            UtilityText(panel, "按便条内容或关联番剧搜索");
            AutomationProperties.SetName(search, "搜索便条");
            AutomationProperties.SetAutomationId(search, "note-search");
            panel.Children.Add(search);
            var sort = AppearanceOptions("排序便条", "note-sort", new[] { "新建在前", "到期在前", "按内容排序" }, _notesSort);
            panel.Children.Add(sort);
            var list = new StackPanel();
            panel.Children.Add(list);
            search.TextChanged += delegate { _notesQuery = search.Text.Trim(); RenderNotes(list); };
            sort.SelectionChanged += delegate { _notesSort = sort.SelectedIndex; SaveState(); RenderNotes(list); };
            RenderNotes(list);
        }

        void RenderNotes(StackPanel panel)
        {
            panel.Children.Clear();
            IEnumerable<DesktopNote> matches = _notes.Where(note => (!note.Done || _showCompletedNotes) &&
                (note.Text.IndexOf(_notesQuery, StringComparison.CurrentCultureIgnoreCase) >= 0 ||
                (note.ShowName ?? "").IndexOf(_notesQuery, StringComparison.CurrentCultureIgnoreCase) >= 0));
            if (_notesSort == 1) matches = matches.OrderBy(note => note.Done).ThenBy(note => note.DueAt == 0 ? long.MaxValue : note.DueAt);
            else if (_notesSort == 2) matches = matches.OrderBy(note => note.Done).ThenBy(note => note.Text, StringComparer.CurrentCultureIgnoreCase);
            var visible = matches.ToList();
            if (visible.Count == 0) UtilityText(panel, _notesQuery.Length > 0 ? "没有匹配的便条。" : "手边没有待办便条。");
            foreach (var note in visible)
            {
                UtilityText(panel, (note.Done ? "✓ " : "") + note.Text);
                if (!string.IsNullOrEmpty(note.ShowName)) UtilityText(panel, "关联番剧 · " + note.ShowName);
                if (note.DueAt > 0)
                    UtilityText(panel, (note.Done ? "原到期" : note.DueAt <= UnixNow() ? "已到期" : "到期") + " · " + NoteTime(note.DueAt));
                var actions = new WrapPanel { Margin = new Thickness(0, 0, 0, 8) };
                panel.Children.Add(actions);
                if (!string.IsNullOrEmpty(note.ShowId))
                    UtilityButton(actions, "番剧详情", "note-show-" + note.Id, () => OpenWebPanel("?watch=" + Uri.EscapeDataString(note.ShowId)));
                if (note.Done)
                {
                    UtilityButton(actions, "恢复", "note-restore-" + note.Id, () => ChangeNote(() => note.Done = false));
                    UtilityButton(actions, "删除", "note-delete-" + note.Id, () =>
                    {
                        if (MessageBox.Show(_notesWindow, "删除这条已完成的便条？", "桌面便条", MessageBoxButton.YesNo, MessageBoxImage.Question) == MessageBoxResult.Yes)
                            ChangeNote(() => _notes.Remove(note));
                    });
                }
                else
                {
                    UtilityButton(actions, "完成", "note-done-" + note.Id, () => ChangeNote(() => note.Done = true));
                    UtilityButton(actions, "编辑", "note-edit-" + note.Id, () => EditNote(note));
                }
            }
        }

        void ChangeNote(Action change)
        {
            bool saved = CommitNoteChange(change);
            RefreshNotes();
            if (!saved) UtilityText(_notesContent, "暂时无法写入磁盘。请检查安装目录的写入权限。");
        }

        bool CommitNoteChange(Action change)
        {
            var previous = _notes.Select(note => note.Copy()).ToList();
            change();
            if (SaveState()) { _nextNoteCheck = 0; return true; }
            _notes = previous;
            return false;
        }

        static string NoteTime(long seconds)
        {
            return new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddSeconds(seconds).ToLocalTime()
                .ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture);
        }

        void TickNotes()
        {
            if (_selfTest || _closing || _notes.Count == 0) return;
            long now = UnixNow();
            if (_nextNoteCheck > now && _nextNoteCheck <= now + 15) return;
            _nextNoteCheck = now + 15;
            if (AmbientQuiet) return;
            var due = _notes.FindAll(note => !note.Done && note.DueAt > 0 && note.DueAt <= now && note.NotifiedAt == 0);
            if (due.Count == 0 || ReminderQuiet(ReadReminderSettings(), now)) return;
            if (!CommitNoteChange(() => due.ForEach(note => note.NotifiedAt = now))) return;
            _nextNoteCheck = now + 15;
            string preview = due[0].Text.Length <= 100 ? due[0].Text : due[0].Text.Substring(0, 99) + "…";
            Notify("TIARA · 便条到期", due.Count == 1 ? preview : due.Count + " 条便条到期，请打开桌面便条查看。");
            if (!_editingNote) RefreshNotes();
        }

        void EditNote(DesktopNote note)
        {
            var panel = _notesContent;
            _editingNote = true;
            panel.Children.Clear();
            UtilityText(panel, note == null ? "新便条" : "编辑便条", true);
            var text = new TextBox { Text = note == null ? "" : note.Text, TextWrapping = TextWrapping.Wrap,
                AcceptsReturn = true, MaxLength = 240, MinHeight = 72, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
            AutomationProperties.SetName(text, "便条内容");
            AutomationProperties.SetAutomationId(text, "note-text");
            panel.Children.Add(text);
            UtilityText(panel, "关联番剧（可选）");
            var shows = ReadMenuShows(true);
            var select = new ComboBox { Margin = new Thickness(0, 0, 0, 10) };
            AutomationProperties.SetName(select, "关联番剧");
            AutomationProperties.SetAutomationId(select, "note-select");
            var items = new List<MenuShow> { new MenuShow { Name = "未关联" } };
            items.AddRange(shows);
            string previous = note == null ? "" : note.ShowId;
            if (!string.IsNullOrEmpty(previous) && !items.Exists(item => item.Id == previous))
                items.Add(new MenuShow { Id = previous, Name = note.ShowName });
            foreach (var show in items) select.Items.Add(show.Name);
            select.SelectedIndex = Math.Max(0, items.FindIndex(item => !string.IsNullOrEmpty(previous) && item.Id == previous));
            panel.Children.Add(select);
            UtilityText(panel, "到期时间（本机时区，可留空）");
            var deadline = new TextBox { Text = note != null && note.DueAt > 0 ? NoteTime(note.DueAt) : "",
                MaxLength = 16, Margin = new Thickness(0, 0, 0, 8) };
            AutomationProperties.SetName(deadline, "到期时间，格式 年-月-日 时:分");
            AutomationProperties.SetAutomationId(deadline, "note-deadline");
            panel.Children.Add(deadline);
            UtilityText(panel, "例如 2026-12-01 20:30。专注和免打扰结束后再通知。");
            var actions = new WrapPanel();
            panel.Children.Add(actions);
            var status = ScheduleText("", 12, ScheduleMuted);
            UtilityButton(actions, "保存便条", "note-save", () =>
            {
                string value = text.Text.Trim();
                if (value.Length == 0) { status.Text = "请写一点内容。"; text.Focus(); return; }
                string time = deadline.Text.Trim();
                long at = 0;
                if (time.Length > 0)
                {
                    DateTime local;
                    if (!DateTime.TryParseExact(time, "yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out local) ||
                        local.Year < 1971 || local.Year > 9998 || TimeZoneInfo.Local.IsInvalidTime(local))
                    {
                        status.Text = "请输入有效的本机日期和时间，例如 2026-12-01 20:30。"; deadline.Focus(); return;
                    }
                    at = (long)(local.ToUniversalTime() - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalSeconds;
                }
                var chosen = items[Math.Max(0, select.SelectedIndex)];
                bool saved = CommitNoteChange(() =>
                {
                    var edited = note == null ? new DesktopNote { Id = Guid.NewGuid().ToString("N") } : _notes.Find(item => item.Id == note.Id);
                    edited.Text = value;
                    edited.ShowId = chosen.Id;
                    edited.ShowName = chosen.Id == null ? null : chosen.Name;
                    if (edited.DueAt != at) edited.NotifiedAt = 0;
                    edited.DueAt = at;
                    if (note == null) _notes.Insert(0, edited);
                });
                if (saved) RefreshNotes();
                else status.Text = "暂时无法写入磁盘。可以重试保存。";
            });
            UtilityButton(actions, "取消", "note-cancel", RefreshNotes);
            panel.Children.Add(status);
            text.Focus();
        }

        List<string> ShellOptions()
        {
            var names = new List<string> { "master" };
            string root = Path.Combine(_root, "shell");
            if (!Directory.Exists(root)) return names;
            foreach (string folder in Directory.GetDirectories(root))
            {
                string name = Path.GetFileName(folder);
                if (string.Equals(name, "master", StringComparison.OrdinalIgnoreCase) || name.StartsWith(".") ||
                    !File.Exists(Path.Combine(folder, "surface0.png"))) continue;
                names.Add(name);
            }
            return names;
        }

        static BitmapImage LocalBitmap(string file)
        {
            var image = new BitmapImage();
            image.BeginInit();
            image.CacheOption = BitmapCacheOption.OnLoad;
            image.UriSource = new Uri(file);
            image.EndInit();
            image.Freeze();
            return image;
        }

        static ComboBox AppearanceOptions(string name, string id, IEnumerable<string> values, int selected)
        {
            var choice = new ComboBox { Margin = new Thickness(0, 0, 0, 8) };
            AutomationProperties.SetName(choice, name);
            AutomationProperties.SetAutomationId(choice, id);
            foreach (string value in values) choice.Items.Add(value);
            choice.SelectedIndex = selected;
            return choice;
        }

        void OpenAppearance()
        {
            if (_appearanceWindow != null) { _appearanceWindow.Activate(); return; }
            StackPanel panel;
            _appearanceWindow = UtilityWindow("TIARA · 换装与气泡", out panel);
            _appearanceWindow.Closed += delegate { _appearanceWindow = null; };
            UtilityText(panel, "换装与气泡", true);
            var names = ShellOptions();
            UtilityText(panel, "本地立绘套装");
            var shell = AppearanceOptions("立绘套装", "appearance-shell", names, Math.Max(0, names.IndexOf(_shellName)));
            panel.Children.Add(shell);
            var sprite = new Image { Height = 130, Stretch = Stretch.Uniform, Margin = new Thickness(0, 0, 0, 10) };
            AutomationProperties.SetName(sprite, "立绘预览");
            AutomationProperties.SetAutomationId(sprite, "appearance-preview");
            panel.Children.Add(sprite);
            UtilityText(panel, "气泡配色与字号");
            var theme = AppearanceOptions("气泡配色", "appearance-theme", Array.ConvertAll(BubbleThemes, item => item.Name), _bubbleThemeIndex);
            var size = AppearanceOptions("气泡字号", "appearance-size", new[] { "小", "标准", "大" }, _bubbleSizeIndex);
            panel.Children.Add(theme);
            panel.Children.Add(size);
            UtilityText(panel, "气泡停留时间");
            var delay = AppearanceOptions("气泡停留时间", "appearance-bubble-time",
                new[] { "按台词长度", "至少 15 秒", "30 秒", "手动关闭" }, _bubbleTimeIndex);
            panel.Children.Add(delay);
            bool reduceMotion = _reduceMotion;
            CompanionOption(panel, "减弱动画（立即显示全文）", "appearance-reduce-motion", _reduceMotion, value => reduceMotion = value);
            var sample = new TextBlock { Text = "会长，今天的记录也写好了。", TextWrapping = TextWrapping.Wrap, Foreground = Ink };
            var bubble = new Border { Child = sample, Padding = new Thickness(12), Margin = new Thickness(0, 0, 0, 10),
                CornerRadius = new CornerRadius(10), BorderThickness = new Thickness(1) };
            panel.Children.Add(bubble);
            var actions = new WrapPanel();
            panel.Children.Add(actions);
            var status = ScheduleText("", 12, ScheduleMuted);
            Button apply = UtilityButton(actions, "应用外观", "appearance-apply", () =>
            {
                if (sprite.Source == null) return;
                string selectedShell = names[shell.SelectedIndex];
                bool changedShell = _shellName != selectedShell;
                _shellName = selectedShell;
                _bubbleThemeIndex = theme.SelectedIndex;
                _bubbleSizeIndex = size.SelectedIndex;
                _bubbleTimeIndex = delay.SelectedIndex;
                _reduceMotion = reduceMotion;
                DismissBubble();
                if (changedShell) LoadShell();
                ApplyBubbleTheme();
                status.Text = SaveState() ? "已应用。" : "已应用。暂时无法写入磁盘。";
            });
            UtilityButton(actions, "关闭", "appearance-close", () => _appearanceWindow.Close());
            panel.Children.Add(status);
            Action previewShell = delegate
            {
                sprite.Source = null;
                try { sprite.Source = LocalBitmap(Path.Combine(_root, "shell", names[shell.SelectedIndex], "surface0.png")); }
                catch (Exception ex) { Log("shell preview: " + ex.Message); }
                apply.IsEnabled = sprite.Source != null;
                status.Text = sprite.Source == null ? "这套立绘的首张图片无法读取。" : "";
            };
            Action previewBubble = delegate
            {
                var colors = BubbleThemes[theme.SelectedIndex];
                bubble.Background = colors.Fill;
                bubble.BorderBrush = colors.Line;
                sample.FontSize = 14.5 * BubbleFontFactors[size.SelectedIndex];
            };
            shell.SelectionChanged += delegate { previewShell(); };
            theme.SelectionChanged += delegate { previewBubble(); };
            size.SelectionChanged += delegate { previewBubble(); };
            previewShell();
            previewBubble();
            _appearanceWindow.Show();
        }

        void ApplyBubbleTheme()
        {
            var colors = ActiveBubbleTheme;
            _bubbleSkin.Fill = colors.Fill;
            _bubbleSkin.Stroke = colors.Line;
            _bubbleHeading.Foreground = _bubbleClose.Foreground = colors.Accent;
            _bubbleText.FontSize = BubbleFontSize;
            _bubbleText.LineHeight = Math.Round(BubbleFontSize * 1.58);
            ApplyBubbleShape();
        }

        void PlayRockPaperScissors()
        {
            string[] moves = { "石头", "剪刀", "布" };
            int opponent = _rnd.Next(moves.Length);
            var choices = new Choice[moves.Length];
            for (int i = 0; i < choices.Length; i++)
            {
                int move = i;
                choices[i] = new Choice(moves[move], () =>
                {
                    int outcome = (opponent - move + moves.Length) % moves.Length;
                    string result = outcome == 0 ? "平局。……默契倒是不错。" :
                        outcome == 1 ? "会长赢了。我会把这局记在心里。" : "这次是我赢。会长，还来一局吗？";
                    SayWithChoices(new Line("你出" + moves[move] + "，我出" + moves[opponent] + "。\n" + result, 1),
                        new Choice("再来一局", PlayRockPaperScissors), new Choice("结束", delegate { }));
                });
            }
            SayWithChoices(new Line("猜拳吧。会长，三、二、一。", 1), choices);
        }
    }
}
