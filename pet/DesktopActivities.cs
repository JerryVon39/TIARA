using System;
using System.Collections.Generic;
using System.Linq;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using TrayMenu = System.Windows.Forms.ContextMenuStrip;
using TrayMenuItem = System.Windows.Forms.ToolStripMenuItem;

namespace UkagakaBangumi
{
    public partial class PetWindow
    {
        const int QuickPinLimit = 3;
        static readonly string[] QuickKeys = { "notes", "companion", "focus", "web" };
        const string ScheduleMenuLabel = "我的排片";
        const string MarkMenuLabel = "记一话";
        const string UndoMenuLabel = "撤销上次进度修改";
        const string AppearanceMenuLabel = "换装与显示";
        const string RecallMenuLabel = "找回桌宠";
        const string ReminderCenterMenuLabel = "提醒中心";
        static readonly string[] QuickNames = { "桌面便条", "陪伴手账", "专注与安静", "打开网页面板" };
        readonly List<string> _trayPins = new List<string>();
        readonly List<string> _petPins = new List<string>();
        readonly List<string> _recentQuick = new List<string>();
        Window _quickMenuSettings, _guessWindow;
        StackPanel _guessContent;
        readonly List<int> _guesses = new List<int>();
        int _guessTarget;
        string _guessMessage = "";

        void LoadDesktopActivities(JavaScriptSerializer serializer, Dictionary<string, object> state)
        {
            LoadQuickKeys(_trayPins, StateValue<List<string>>(serializer, state, "tray_pins"), QuickKeys);
            LoadQuickKeys(_petPins, StateValue<List<string>>(serializer, state, "pet_pins"), QuickKeys);
            LoadQuickKeys(_recentQuick, StateValue<List<string>>(serializer, state, "recent_quick"), QuickKeys);
        }

        static void LoadQuickKeys(List<string> target, List<string> stored, IEnumerable<string> supported)
        {
            if (stored != null) target.AddRange(stored.Where(supported.Contains).Distinct().Take(QuickPinLimit));
        }

        void RecordQuickUse(string action)
        {
            if (!QuickKeys.Contains(action) || (_recentQuick.Count > 0 && _recentQuick[0] == action)) return;
            _recentQuick.Remove(action);
            _recentQuick.Insert(0, action);
            if (_recentQuick.Count > QuickPinLimit) _recentQuick.RemoveAt(QuickPinLimit);
            SaveState();
        }

        string QuickName(string key) { return QuickNames[Array.IndexOf(QuickKeys, key)]; }

        void RunQuickAction(string key)
        {
            switch (key)
            {
                case "schedule":
                    if (!IsVisible) ShowFromTray();
                    if (!PanelOpen) TogglePanel();
                    break;
                case "notes": OpenNotes(); break;
                case "companion": OpenCompanion(false); break;
                case "focus": OpenFocus(); break;
                case "web": OpenWebPanel(); break;
                case "snoozes": OpenReminderCenter(); break;
            }
        }

        string[] RecentMenuActions(List<string> pins)
        {
            return _recentQuick.Where(key => !pins.Contains(key)).ToArray();
        }

        void AddPetQuickItems(ContextMenu menu, string[] recent)
        {
            foreach (string key in _petPins)
            {
                var pin = Item(QuickName(key), (s, e) => RunQuickAction(key));
                AutomationProperties.SetAutomationId(pin, "pet-quick-" + key);
                menu.Items.Add(pin);
            }
            if (recent.Length > 0)
                menu.Items.Add(Sub("最近使用", recent.Select(key => Item(QuickName(key), (s, e) => RunQuickAction(key))).ToArray()));
        }

        void AddTrayQuickItems(TrayMenu menu, string[] recent)
        {
            foreach (string key in _trayPins) menu.Items.Add(TrayAction(key));
            if (recent.Length == 0) return;
            var submenu = new TrayMenuItem("最近使用") { Name = "tray-recent-actions" };
            foreach (string key in recent) submenu.DropDownItems.Add(TrayAction(key));
            menu.Items.Add(submenu);
        }

        TrayMenuItem TrayAction(string key)
        {
            var item = new TrayMenuItem(QuickName(key)) { Name = "tray-quick-" + key };
            item.Click += delegate { RunQuickAction(key); };
            return item;
        }

        void OpenQuickMenuSettings()
        {
            if (_quickMenuSettings != null) { _quickMenuSettings.Activate(); return; }
            StackPanel panel;
            _quickMenuSettings = UtilityWindow("TIARA · 常用菜单", out panel);
            _quickMenuSettings.Closed += delegate { _quickMenuSettings = null; };
            UtilityText(panel, "常用菜单", true);
            UtilityText(panel, "「我的排片」和「提醒中心」始终显示。每处可以另外固定 3 项常用菜单。");
            QuickSettingsGroup(panel, "托盘", "tray", _trayPins);
            QuickSettingsGroup(panel, "立绘右键", "pet", _petPins);
            _quickMenuSettings.Show();
        }

        void QuickSettingsGroup(StackPanel panel, string title, string id, List<string> pins)
        {
            UtilityText(panel, title, true);
            var options = new WrapPanel();
            panel.Children.Add(options);
            var status = ScheduleText("", 12, ScheduleMuted);
            bool refreshing = false;
            foreach (string key in QuickKeys)
            {
                var option = CompanionOption(options, QuickName(key), "quick-setting-" + id + "-" + key, pins.Contains(key), selected =>
                {
                    if (refreshing) return;
                    var before = pins.ToArray();
                    if (selected && pins.Count < QuickPinLimit) pins.Add(key);
                    else if (!selected) pins.Remove(key);
                    if (!SaveState())
                    {
                        pins.Clear();
                        pins.AddRange(before);
                        status.Text = "暂时无法保存，请重试。";
                    }
                    else status.Text = "已固定 " + pins.Count + " / " + QuickPinLimit + " 项。";
                    refreshing = true;
                    UpdateQuickOptions(options, pins, id);
                    refreshing = false;
                });
                option.Margin = new Thickness(0, 4, 12, 3);
            }
            UpdateQuickOptions(options, pins, id);
            panel.Children.Add(status);
        }

        void UpdateQuickOptions(WrapPanel options, List<string> pins, string id)
        {
            string prefix = "quick-setting-" + id + "-";
            foreach (CheckBox option in options.Children)
            {
                bool selected = pins.Contains(AutomationProperties.GetAutomationId(option).Substring(prefix.Length));
                option.IsChecked = selected;
                option.IsEnabled = selected || pins.Count < QuickPinLimit;
            }
        }

        void OpenGuessGame()
        {
            if (_guessWindow != null) { _guessWindow.Activate(); return; }
            _guessWindow = UtilityWindow("TIARA · 猜数字", out _guessContent);
            _guessWindow.Closed += delegate { _guessWindow = null; _guessContent = null; };
            if (_guessTarget == 0) ResetGuessGame();
            else RenderGuessGame();
            _guessWindow.Show();
        }

        void ResetGuessGame()
        {
            _guessTarget = _rnd.Next(1, 21);
            _guesses.Clear();
            _guessMessage = "会长，猜猜我把哪个数字写在记录簿上了。";
            RenderGuessGame();
        }

        void RenderGuessGame()
        {
            var panel = _guessContent;
            if (panel == null) return;
            panel.Children.Clear();
            UtilityText(panel, "猜数字", true);
            UtilityText(panel, "1–20 之间，最多猜 5 次。关闭本窗口后可以回来继续。");
            bool won = _guesses.Contains(_guessTarget);
            bool ended = won || _guesses.Count == 5;
            var status = ScheduleText(_guessMessage, 13, ScheduleInk);
            AutomationProperties.SetAutomationId(status, "guess-status");
            panel.Children.Add(status);
            if (_guesses.Count > 0) UtilityText(panel, "已猜 " + string.Join("、", _guesses) + "　·　剩余 " + (5 - _guesses.Count) + " 次");
            var actions = new WrapPanel { Margin = new Thickness(0, 8, 0, 0) };
            panel.Children.Add(actions);
            if (ended)
            {
                UtilityButton(actions, "再来一局", "guess-again", ResetGuessGame);
                return;
            }
            var value = new TextBox { Width = 64, MaxLength = 2, Margin = new Thickness(0, 0, 8, 5), VerticalContentAlignment = VerticalAlignment.Center };
            AutomationProperties.SetName(value, "你的答案");
            AutomationProperties.SetAutomationId(value, "guess-value");
            value.Loaded += delegate { value.Focus(); };
            actions.Children.Add(value);
            var submit = UtilityButton(actions, "猜这个数", "guess-submit", () =>
            {
                int guess;
                if (!int.TryParse(value.Text, out guess) || guess < 1 || guess > 20)
                { status.Text = "请输入 1–20 之间的整数。"; value.Focus(); return; }
                if (_guesses.Contains(guess)) { status.Text = "这个数字已经猜过。"; value.Focus(); return; }
                _guesses.Add(guess);
                _guessMessage = guess == _guessTarget ? "答对了，是 " + _guessTarget + "。" :
                    _guesses.Count == 5 ? "这一局结束。答案是 " + _guessTarget + "。" :
                    guess < _guessTarget ? "再大一点。" : "再小一点。";
                RenderGuessGame();
            });
            submit.IsDefault = true;
        }
    }
}
