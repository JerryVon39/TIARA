using System;
using System.Collections.Generic;
using System.Linq;
using System.Speech.Synthesis;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;

namespace UkagakaBangumi
{
    public partial class PetWindow
    {
        bool _speechMuted;
        int _speechRate;
        SpeechSynthesizer _localSpeech;
        Prompt _speechPrompt;
        TextBlock _speechStatus;

        void LoadCompanionPresentation(JavaScriptSerializer serializer, Dictionary<string, object> state)
        {
            _speechMuted = StateValue<bool>(serializer, state, "speech_muted");
            _speechRate = Math.Max(-2, Math.Min(2, StateValue<int>(serializer, state, "speech_rate")));
        }

        SpeechSynthesizer GetChineseVoice()
        {
            if (_localSpeech != null) return _localSpeech;
            var engine = new SpeechSynthesizer();
            try
            {
                var voice = engine.GetInstalledVoices().Where(item => item.Enabled && item.VoiceInfo.Culture.TwoLetterISOLanguageName == "zh")
                    .OrderByDescending(item => item.VoiceInfo.Culture.Name == "zh-CN").FirstOrDefault();
                if (voice == null) { engine.Dispose(); return null; }
                engine.SelectVoice(voice.VoiceInfo.Name);
                engine.SpeakCompleted += (sender, result) => Dispatcher.BeginInvoke(new Action(delegate
                {
                    if (result.Prompt != _speechPrompt) return;
                    _speechPrompt = null;
                    if (_speechStatus != null) _speechStatus.Text = result.Error == null ? "朗读结束。" : "Windows 无法播放这句台词。";
                    _speechStatus = null;
                }));
                _localSpeech = engine;
                return engine;
            }
            catch { engine.Dispose(); throw; }
        }

        void ReadCompanionLine(string text, TextBlock status)
        {
            if (_speechMuted) { status.Text = "朗读已静音，可在「偏好」开启。"; return; }
            if (AmbientQuiet) { status.Text = "专注或临时安静结束后可以朗读。"; return; }
            try
            {
                var voice = GetChineseVoice();
                if (voice == null) { status.Text = "Windows 尚未提供可用的中文语音。"; return; }
                StopCompanionSpeech("已停止朗读。");
                voice.Rate = _speechRate;
                _speechPrompt = voice.SpeakAsync(text);
                _speechStatus = status;
                status.Text = "正在朗读 · " + voice.Voice.Name;
            }
            catch (Exception ex)
            {
                Log("speech unavailable: " + ex.GetType().Name);
                status.Text = "Windows 暂时无法开始朗读，请检查语音和音频设备。";
            }
        }

        void StopCompanionSpeech(string message)
        {
            if (_speechPrompt == null) return;
            _speechPrompt = null;
            try { _localSpeech.SpeakAsyncCancelAll(); }
            catch (Exception ex) { Log("speech cancel: " + ex.GetType().Name); }
            if (_speechStatus != null) _speechStatus.Text = message;
            _speechStatus = null;
        }

        void CompanionSpeechOptions(StackPanel panel)
        {
            UtilityText(panel, "离线朗读", true);
            UtilityText(panel, "选择最近台词或收藏中的一句，由 Windows 中文语音朗读。");
            CompanionOption(panel, "朗读静音", "companion-speech-mute", _speechMuted, value =>
            {
                _speechMuted = value;
                if (value) StopCompanionSpeech("已静音。");
                SaveState();
            });
            var speeds = new[] { -2, 0, 2 };
            var rate = AppearanceOptions("朗读语速", "companion-speech-rate", new[] { "较慢", "标准", "较快" },
                _speechRate < 0 ? 0 : _speechRate > 0 ? 2 : 1);
            panel.Children.Add(rate);
            rate.SelectionChanged += delegate
            {
                _speechRate = speeds[rate.SelectedIndex];
                SaveState();
            };
        }

        sealed class DialogueLine
        {
            public bool Narration { get; private set; }
            public string Text { get; private set; }
            public DialogueLine(bool narration, string text) { Narration = narration; Text = text; }
        }

        static readonly DialogueLine[] SampleDialogue = {
            new DialogueLine(false, "今晚的排片空出了一格。会长想补哪一部？"),
            new DialogueLine(true, "阿番把两张旧票根摆在簿子旁，一张朝上，一张背面还写着片名。"),
            new DialogueLine(false, "先留着吧。哪天想起来，我们就从那张票根接着看。"),
            new DialogueLine(true, "她没催着选，只把写着片名的那面轻轻翻了过来。"),
        };
        readonly Queue<DialogueLine> _dialogueQueue = new Queue<DialogueLine>();
        DialogueLine _dialogueCurrent, _dialogueTiara, _dialogueNarration;
        Window _dialogueWindow;
        StackPanel _dialogueCards;
        Button _dialogueNext;
        TextBlock _dialogueStatus;
        bool _dialogueTwoBubbles;
        int _dialogueRead;

        void OpenDialoguePrototype()
        {
            if (_dialogueWindow != null) { _dialogueWindow.Activate(); return; }
            StackPanel body;
            _dialogueWindow = UtilityWindow("TIARA · 双角色对白试演", out body);
            _dialogueWindow.Closed += delegate { _dialogueWindow = null; _dialogueCards = null; };
            UtilityText(body, "排片簿的一格", true);
            var mode = new WrapPanel { Margin = new Thickness(0, 0, 0, 7) };
            body.Children.Add(mode);
            var single = new RadioButton { Content = "一个气泡", GroupName = "dialogue", IsChecked = !_dialogueTwoBubbles, Margin = new Thickness(0, 0, 10, 0) };
            var doubleBubble = new RadioButton { Content = "两个气泡", GroupName = "dialogue", IsChecked = _dialogueTwoBubbles };
            AutomationProperties.SetAutomationId(single, "dialogue-single");
            AutomationProperties.SetAutomationId(doubleBubble, "dialogue-two");
            mode.Children.Add(single);
            mode.Children.Add(doubleBubble);
            _dialogueCards = new StackPanel();
            body.Children.Add(_dialogueCards);
            _dialogueStatus = ScheduleText("", 12, ScheduleMuted);
            AutomationProperties.SetAutomationId(_dialogueStatus, "dialogue-progress");
            body.Children.Add(_dialogueStatus);
            var buttons = new WrapPanel();
            body.Children.Add(buttons);
            _dialogueNext = UtilityButton(buttons, "下一句", "dialogue-next", ReadDialogueLine);
            UtilityButton(buttons, "从头播放", "dialogue-replay", ResetDialogue);
            single.Checked += delegate { _dialogueTwoBubbles = false; RefreshDialogue(); };
            doubleBubble.Checked += delegate { _dialogueTwoBubbles = true; RefreshDialogue(); };
            ResetDialogue();
            _dialogueWindow.Show();
        }

        void ResetDialogue()
        {
            _dialogueQueue.Clear();
            foreach (var line in SampleDialogue) _dialogueQueue.Enqueue(line);
            _dialogueCurrent = _dialogueTiara = _dialogueNarration = null;
            _dialogueRead = 0;
            ReadDialogueLine();
        }

        void ReadDialogueLine()
        {
            if (_dialogueQueue.Count == 0) return;
            _dialogueCurrent = _dialogueQueue.Dequeue();
            if (_dialogueCurrent.Narration) _dialogueNarration = _dialogueCurrent;
            else _dialogueTiara = _dialogueCurrent;
            _dialogueRead++;
            RefreshDialogue();
        }

        void RefreshDialogue()
        {
            _dialogueCards.Children.Clear();
            if (_dialogueTwoBubbles)
            {
                if (_dialogueTiara != null) AddDialogueCard(_dialogueTiara);
                if (_dialogueNarration != null) AddDialogueCard(_dialogueNarration);
            }
            else if (_dialogueCurrent != null) AddDialogueCard(_dialogueCurrent);
            _dialogueStatus.Text = _dialogueRead + " / " + SampleDialogue.Length + (_dialogueQueue.Count == 0 ? " · 结束" : "");
            _dialogueNext.IsEnabled = _dialogueQueue.Count > 0;
        }

        void AddDialogueCard(DialogueLine line)
        {
            string speaker = line.Narration ? "阿番 · 旁白" : "TIARA";
            var card = new Border
            {
                Background = line.Narration ? ScheduleWash : SchedulePinkWash, BorderBrush = ScheduleLine,
                BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(10), Padding = new Thickness(10),
                Margin = !_dialogueTwoBubbles ? new Thickness(0, 0, 0, 8) :
                    line.Narration ? new Thickness(22, 0, 0, 8) : new Thickness(0, 0, 22, 8),
            };
            AutomationProperties.SetName(card, speaker);
            AutomationProperties.SetAutomationId(card, line.Narration ? "dialogue-narrator-card" : "dialogue-tiara-card");
            var content = new StackPanel();
            card.Child = content;
            UtilityText(content, speaker);
            UtilityText(content, line.Text);
            _dialogueCards.Children.Add(card);
        }
    }
}
