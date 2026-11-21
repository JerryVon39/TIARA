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

        internal static Rect WorkAreaForWindow(System.Drawing.Rectangle area, int px, int py, double left, double top, double dpi)
        {
            return new Rect(left + (area.Left - px) / dpi, top + (area.Top - py) / dpi, area.Width / dpi, area.Height / dpi);
        }

        internal static System.Drawing.Point MonitorRecallPosition(System.Drawing.Rectangle area, int width, int height,
            int bubbleBand, bool bubbleBelow, ScreenPosition saved)
        {
            if (saved == null) return RecallPosition(area, width, height);
            return new System.Drawing.Point(
                area.Left + (int)Math.Round(Math.Max(0, area.Width - width) * saved.X),
                area.Top + (int)Math.Round(Math.Max(0, area.Height - (height - bubbleBand)) * saved.Y) -
                    (bubbleBelow ? 0 : bubbleBand));
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

        void MoveToScreen(Screen screen, bool raise, bool useSavedPosition = true)
        {
            var hwnd = new WindowInteropHelper(this).Handle;
            RECT bounds;
            if (hwnd == IntPtr.Zero || screen == null || !GetWindowRect(hwnd, out bounds)) return;
            var work = screen.WorkingArea;
            ScreenPosition saved = null;
            if (useSavedPosition) _screenPositions.TryGetValue(screen.DeviceName, out saved);
            for (int pass = 0; pass < 2; pass++)
            {
                int width = bounds.Right - bounds.Left, height = bounds.Bottom - bounds.Top;
                var position = MonitorRecallPosition(work, width, height, BubbleBandPixels(height), _bubbleBelow, saved);
                SetWindowPos(hwnd, IntPtr.Zero, position.X, position.Y, 0, 0,
                    SWP_NOSIZE | SWP_NOACTIVATE | (raise && pass == 0 ? 0 : SWP_NOZORDER));
                // Moving between monitors can resize the window through WM_DPICHANGED.
                UpdateLayout();
                if (pass == 0) FitDisplayScale();
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
            FitDisplayScale();
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
            if (message == 0x02E0 || message == 0x007E) // WM_DPICHANGED / WM_DISPLAYCHANGE
                Dispatcher.BeginInvoke(DispatcherPriority.Background, new Action(delegate
                {
                    if (!_locationReady || !IsVisible || _closing || _dragging) return;
                    FitDisplayScale();
                    if (BubbleReading) ApplyHeight(true);
                    SnapIntoWorkArea();
                }));
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

        void AddPositionReset(Panel panel, string id)
        {
            var result = ScheduleText("", 12, ScheduleMuted);
            UtilityButton(panel, "重置桌宠位置", id, () =>
            {
                result.Text = RecallDesktop(true) ? "桌宠已移到鼠标所在屏幕中央。"
                    : "已移动桌宠，暂时无法保存位置。";
            });
            panel.Children.Add(result);
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
