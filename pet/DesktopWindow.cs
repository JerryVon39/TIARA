using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Threading;
using Screen = System.Windows.Forms.Screen;

namespace UkagakaBangumi
{
    public partial class PetWindow
    {
        public sealed class ScreenPosition
        {
            public double X { get; set; }
            public double Y { get; set; }
        }

        const int RecallHotkey = 0x51A;
        const uint RecallModifiers = 0x4007; // Ctrl + Alt + Shift + MOD_NOREPEAT
        const string RecallKeys = "Ctrl + Alt + Shift + T";
        const uint SWP_NOZORDER = 0x0004;
        const int WS_CAPTION = 0x00C00000;
        Dictionary<string, ScreenPosition> _screenPositions = new Dictionary<string, ScreenPosition>();
        string _lastScreen = "";
        bool _locationReady, _hideFullscreen, _autoHidden, _userHidden, _notesHiddenByFullscreen;
        bool _recallKeyEnabled, _recallKeyRegistered;
        IntPtr _fullscreenOverride;
        DispatcherTimer _recallLayerTimer;
        Window _desktopWindowSettings;

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint key);
        [DllImport("user32.dll")]
        static extern bool UnregisterHotKey(IntPtr window, int id);
        [DllImport("user32.dll")]
        static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")]
        static extern IntPtr GetShellWindow();
        [DllImport("user32.dll")]
        static extern IntPtr GetDesktopWindow();
        [DllImport("user32.dll")]
        static extern bool IsZoomed(IntPtr window);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
        static extern int GetWindowLong(IntPtr window, int index);

        double BubbleBand
        {
            get
            {
                return _bubbleHost != null && _bubbleHost.Visibility == Visibility.Visible
                    ? _uiRoot.RowDefinitions[_bubbleBelow ? 1 : 0].ActualHeight : 0;
            }
        }

        double RestingTop { get { return _bubbleBelow ? Top : Top + BubbleBand; } }

        int BubbleBandPixels(int windowHeight)
        {
            return ActualHeight <= 0 ? 0 : Math.Min(windowHeight, (int)Math.Round(BubbleBand * windowHeight / ActualHeight));
        }

        void LoadDesktopWindow(JavaScriptSerializer serializer, Dictionary<string, object> state)
        {
            _lastScreen = StateValue<string>(serializer, state, "last_screen") ?? "";
            var positions = StateValue<Dictionary<string, ScreenPosition>>(serializer, state, "screen_positions");
            if (positions != null)
                foreach (var item in positions.Take(16))
                {
                    var p = item.Value;
                    if (p != null && item.Key.Length <= 64 && p.X >= 0 && p.X <= 1 && p.Y >= 0 && p.Y <= 1)
                        _screenPositions[item.Key] = p;
                }
            _hideFullscreen = StateValue<bool>(serializer, state, "hide_fullscreen");
            _recallKeyEnabled = StateValue<bool>(serializer, state, "recall_hotkey");
        }

        static double RelativePosition(int offset, int space)
        {
            return space <= 0 ? 0 : Math.Max(0, Math.Min(1, (double)offset / space));
        }

        void RecordScreenPosition(bool acceptNewScreen = false)
        {
            if (!_locationReady || !IsVisible) return;
            IntPtr hwnd = new WindowInteropHelper(this).Handle;
            RECT bounds;
            if (hwnd == IntPtr.Zero || !GetWindowRect(hwnd, out bounds)) return;
            var screen = Screen.FromHandle(hwnd);
            // Windows may relocate the window while a screen is disconnected. Keep the saved position
            // on the receiving screen until the user drags the pet there or explicitly recalls it.
            if (!acceptNewScreen && _lastScreen.Length != 0 && screen.DeviceName != _lastScreen) return;
            var work = screen.WorkingArea;
            if (!_screenPositions.ContainsKey(screen.DeviceName) && _screenPositions.Count >= 16) return;
            int height = bounds.Bottom - bounds.Top;
            int band = BubbleBandPixels(height);
            int artTop = bounds.Top + (_bubbleBelow ? 0 : band);
            int artHeight = height - band;
            _screenPositions[screen.DeviceName] = new ScreenPosition
            {
                X = RelativePosition(bounds.Left - work.Left, work.Width - (bounds.Right - bounds.Left)),
                Y = RelativePosition(artTop - work.Top, work.Height - artHeight)
            };
            _lastScreen = screen.DeviceName;
        }

        void MoveToScreen(Screen screen, bool raise)
        {
            var hwnd = new WindowInteropHelper(this).Handle;
            RECT bounds;
            if (hwnd == IntPtr.Zero || screen == null || !GetWindowRect(hwnd, out bounds)) return;
            var work = screen.WorkingArea;
            ScreenPosition saved;
            _screenPositions.TryGetValue(screen.DeviceName, out saved);
            for (int pass = 0; pass < 2; pass++)
            {
                int width = bounds.Right - bounds.Left, height = bounds.Bottom - bounds.Top;
                var position = RecallPosition(work, width, height);
                if (saved != null)
                {
                    int band = BubbleBandPixels(height);
                    int artHeight = height - band;
                    int offset = _bubbleBelow ? 0 : band;
                    position.X = work.Left + (int)Math.Round(Math.Max(0, work.Width - width) * saved.X);
                    position.Y = work.Top + (int)Math.Round(Math.Max(0, work.Height - artHeight) * saved.Y) - offset;
                }
                SetWindowPos(hwnd, IntPtr.Zero, position.X, position.Y, 0, 0,
                    SWP_NOSIZE | SWP_NOACTIVATE | (raise && pass == 0 ? 0 : SWP_NOZORDER));
                // Moving between monitors can resize the window through WM_DPICHANGED.
                UpdateLayout();
                if (!GetWindowRect(hwnd, out bounds) || (width == bounds.Right - bounds.Left && height == bounds.Bottom - bounds.Top))
                    break;
            }
            SnapIntoWorkArea();
        }

        void RestoreScreenPosition()
        {
            if (_lastScreen.Length > 0)
                MoveToScreen(Screen.AllScreens.FirstOrDefault(screen => screen.DeviceName == _lastScreen) ?? Screen.PrimaryScreen, false);
            SnapIntoWorkArea();
            _locationReady = true;
            RecordScreenPosition(true);
        }

        IntPtr DesktopWindowHook(IntPtr hwnd, int message, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (message == 0x0312 && wParam.ToInt32() == RecallHotkey)
            {
                handled = true;
                Dispatcher.BeginInvoke(new Action(RecallFromTray));
            }
            return IntPtr.Zero;
        }

        void ApplyRecallHotkey(IntPtr window)
        {
            if (window == IntPtr.Zero) return;
            if (!_recallKeyEnabled && _recallKeyRegistered)
            {
                UnregisterHotKey(window, RecallHotkey);
                _recallKeyRegistered = false;
            }
            else if (_recallKeyEnabled && !_recallKeyRegistered)
            {
                _recallKeyRegistered = RegisterHotKey(window, RecallHotkey, RecallModifiers, 0x54);
                if (!_recallKeyRegistered) Log("recall hotkey unavailable " + Marshal.GetLastWin32Error());
            }
        }

        void OpenDesktopWindowSettings()
        {
            if (_desktopWindowSettings != null) { _desktopWindowSettings.Activate(); return; }
            StackPanel content;
            var win = UtilityWindow("TIARA · 显示与召回", out content);
            _desktopWindowSettings = win;
            win.Closed += delegate { _desktopWindowSettings = null; };
            UtilityText(content, "显示与召回", true);
            CompanionOption(content, "本屏有全屏窗口时暂时隐藏桌宠", "window-hide-fullscreen", _hideFullscreen, value =>
            {
                _hideFullscreen = value;
                TickDesktopVisibility();
                SaveState();
            });
            var status = ScheduleText("", 12, ScheduleMuted);
            Action update = delegate
            {
                status.Text = !_recallKeyEnabled ? "也可以从托盘选择「找回桌宠」。" : _recallKeyRegistered
                    ? "快捷键已启用。" : "该快捷键当前不可用，可能已被占用。也可以从托盘找回。";
            };
            CompanionOption(content, "启用召回快捷键 " + RecallKeys, "window-recall-hotkey", _recallKeyEnabled, value =>
            {
                _recallKeyEnabled = value;
                ApplyRecallHotkey(new WindowInteropHelper(this).Handle);
                SaveState();
                update();
            });
            content.Children.Add(status);
            update();
            win.Show();
        }

        void ResetManualVisibility(bool show)
        {
            _userHidden = !show;
            _autoHidden = false;
            if (!show) { _fullscreenOverride = IntPtr.Zero; _notesHiddenByFullscreen = false; return; }
            IntPtr hwnd = new WindowInteropHelper(this).Handle;
            IntPtr foreground = GetForegroundWindow();
            if (FullscreenOnPetScreen(foreground, hwnd)) _fullscreenOverride = foreground;
            Show();
            if (_notesHiddenByFullscreen && _notesWindow != null) _notesWindow.Show();
            _notesHiddenByFullscreen = false;
        }

        bool FullscreenOnPetScreen(IntPtr foreground, IntPtr pet)
        {
            RECT rect;
            if (foreground == IntPtr.Zero || foreground == pet || foreground == GetDesktopWindow() ||
                foreground == GetShellWindow() || !GetWindowRect(foreground, out rect)) return false;
            if (IsZoomed(foreground) && (GetWindowLong(foreground, -16) & WS_CAPTION) == WS_CAPTION) return false;
            var screen = Screen.FromHandle(pet);
            if (Screen.FromHandle(foreground).DeviceName != screen.DeviceName) return false;
            var b = screen.Bounds;
            return rect.Left <= b.Left + 2 && rect.Top <= b.Top + 2 &&
                rect.Right >= b.Right - 2 && rect.Bottom >= b.Bottom - 2;
        }

        void TickDesktopVisibility()
        {
            if (_closing || !_locationReady || _userHidden || (!_hideFullscreen && !_autoHidden)) return;
            IntPtr hwnd = new WindowInteropHelper(this).Handle;
            IntPtr foreground = GetForegroundWindow();
            if (foreground != _fullscreenOverride && foreground != hwnd) _fullscreenOverride = IntPtr.Zero;
            bool hide = _hideFullscreen && _fullscreenOverride == IntPtr.Zero && FullscreenOnPetScreen(foreground, hwnd);
            if (hide == _autoHidden) return;
            _autoHidden = hide;
            if (hide)
            {
                _notesHiddenByFullscreen = _notesWindow != null && _notesWindow.IsVisible;
                if (_notesHiddenByFullscreen) _notesWindow.Hide();
                Hide();
            }
            else
            {
                Show();
                SnapIntoWorkArea();
                ApplyLayer();
                if (_notesHiddenByFullscreen && _notesWindow != null) _notesWindow.Show();
                _notesHiddenByFullscreen = false;
            }
        }
    }
}
