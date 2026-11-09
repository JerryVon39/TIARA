// TIARA · 桌面番组管家（纯本地 WPF 桌宠）
//
// 编译（.NET Framework 自带 csc，无需 SDK）：
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /target:winexe /out:pet\Pet.exe ^
//     /r:...\WPF\PresentationFramework.dll /r:...\WPF\PresentationCore.dll ^
//     /r:...\WindowsBase.dll /r:...\System.Xaml.dll pet\Pet.cs
// 直接跑 tools\build_pet.mjs 即可。
//
// 数据来源：ghost\master\today.txt（key=value，由 tools/build_today.mjs 生成）
// 立绘：  shell\master\surface{0..5}.png

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using System.Runtime.InteropServices;

namespace UkagakaBangumi
{
    internal struct Line
    {
        public string Text;
        public int Face;
        public Line(string t, int f) { Text = t; Face = f; }
    }

    public class PetApp
    {
        [STAThread]
        public static void Main(string[] args)
        {
            string instance = @"Local\TiaraPet." + PanelHost.Id(PetWindow.FindRoot());
            if (Array.IndexOf(args, "--quit") >= 0)
            {
                try { using (var signal = EventWaitHandle.OpenExisting(instance + ".quit")) signal.Set(); }
                catch (WaitHandleCannotBeOpenedException) { }
                return;
            }
            // 单实例：两个桌宠会各养一个托盘图标、各发一遍开播提醒，还会互相覆盖 data/state.json
            bool first = true;
            System.Threading.Mutex mtx = null;
            try
            {
                mtx = new System.Threading.Mutex(true, instance, out first);
            }
            catch (Exception ex) { PetWindow.Log("single instance check failed: " + ex.Message); first = true; }
            if (!first)
            {
                PetWindow.Log("another instance is running, exit");
                if (mtx != null) mtx.Dispose();
                return;
            }
            using (mtx)
            using (var signal = new EventWaitHandle(false, EventResetMode.AutoReset, instance + ".quit"))
            {
                var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
                var w = new PetWindow();
                var wait = ThreadPool.RegisterWaitForSingleObject(signal, delegate
                {
                    w.Dispatcher.BeginInvoke(new Action(w.Close));
                }, null, Timeout.Infinite, true);
                try { app.Run(w); }
                finally { wait.Unregister(null); }
            }
        }
    }

    public class PetWindow : Window
    {
        // ---------- 配色（与 panel/index.html 一致） ----------
        static readonly Brush Paper = new SolidColorBrush(Color.FromRgb(0xFA, 0xF6, 0xEE));
        static readonly Brush Ink = new SolidColorBrush(Color.FromRgb(0x24, 0x1F, 0x1C));
        static readonly Brush InkSoft = new SolidColorBrush(Color.FromRgb(0x7A, 0x70, 0x66));
        static readonly Brush Red = new SolidColorBrush(Color.FromRgb(0xB2, 0x3A, 0x34));
        /// <summary>行悬停底色（比 Paper 深一档，但别抢内容）</summary>
        static readonly Brush PaperWarm = new SolidColorBrush(Color.FromRgb(0xF1, 0xE9, 0xDB));
        // 气泡：比纸面更亮一点、带一点通透感，压在桌面背景上才不糊
        static readonly Brush BubbleFill = new SolidColorBrush(Color.FromArgb(0xF4, 0xFF, 0xFD, 0xF8));
        static readonly Brush BubbleLine = new SolidColorBrush(Color.FromRgb(0xDC, 0xCD, 0xB6));
        static readonly Brush BubbleAccent = new SolidColorBrush(Color.FromRgb(0x93, 0x3D, 0x38));
        static readonly Brush BubbleButtonFill = new SolidColorBrush(Color.FromRgb(0xF8, 0xED, 0xE1));
        static readonly Brush BubbleButtonHover = new SolidColorBrush(Color.FromRgb(0xF3, 0xDB, 0xD1));

        const double SpriteH = 560;
        const double WinW = 430;
        const double WinH = 664;   // 说话时的高度：立绘 560 + 气泡余量，气泡不会飘得太远

        string _root;
        PanelHost _panelHost;
        Dictionary<string, string> _vars = new Dictionary<string, string>();
        readonly string[] _surfaces = new string[6];
        readonly ImageSource[] _faceCache = new ImageSource[6];
        ImageSource _talkImg;
        Dictionary<string, object> _talks = new Dictionary<string, object>();
        Dictionary<string, string> _menuText = new Dictionary<string, string>();
        string _statePath;

        // ---------- 立绘组件（shell/master/faces.json）----------
        // 一张底图 + 口型层 + 任意覆盖层；缺件就降级，不空图。
        Dictionary<string, string> _faceBase = new Dictionary<string, string>();
        Dictionary<string, List<KeyValuePair<string, string>>> _faceOverlay =
            new Dictionary<string, List<KeyValuePair<string, string>>>();
        readonly Dictionary<string, Rect> _regions = new Dictionary<string, Rect>();
        string _mouthSrc;
        double _canvasW = 384, _canvasH = 576;

        // ---------- 事件总线：所有刺激统一入队，按 On* 名字派发 ----------
        // 传统伪春菜靠宿主派发 OnBoot/OnSecondChange/OnMouseClick…，这里补上同一层结构：
        // 逐帧渲染只做视觉，业务逻辑一律走事件，加功能不再往定时器里塞 if。
        sealed class Evt
        {
            public string Name;
            public string Arg;
            public Evt(string n, string a) { Name = n; Arg = a; }
        }
        readonly Queue<Evt> _evtq = new Queue<Evt>();
        bool _pumping;
        DateTime _lastTickAt = DateTime.Now;
        int _lastMinute = -1, _lastHour = -1, _lastDayOfYear = -1;
        DateTime _lastNade = DateTime.MinValue;
        string _lastSpoken = "";

        // ---------- 用户态变量（好感 / 心情 / 今日互动）----------
        // 对应传统伪春菜的 yaya_variable.cfg：跨启动保留，按日重置计数。
        Dictionary<string, string> _user = new Dictionary<string, string>();
        string _varsDate = "";

        // ---------- 三条人格变量线（妄想 / 慌张 / 鼻血）----------
        // 数值都在 _user 里（imagination / fluster），这里只放进程内的节流与派生状态。
        // 设计：imagination 涨得慢、跌得也慢（隔天还记得）；fluster 涨得快、跌得也快；
        //       两者都高 → 触发一次鼻血（说完把两个值各扣 30，避免每句话都喷）。
        readonly List<DateTime> _bumpTimes = new List<DateTime>();
        DateTime _lastPersonaDecay = DateTime.Now;
        DateTime _lastNosebleed = DateTime.MinValue;
        DateTime _lastIdleSay = DateTime.MinValue;
        string _mood = "calm";

        DispatcherTimer _midnightTimer;  // 跨日自动重算
        DispatcherTimer _seqTimer;       // 开场白序列
        bool _closing;                   // 正在走「说完再见再关」
        string _lastBootDate = "";
        double _savedLeft = double.MinValue, _savedTop = double.MinValue;
        readonly HashSet<string> _reminded = new HashSet<string>();
        public sealed class ReminderSnooze
        {
            public string Name { get; set; }
            public long At { get; set; }
        }
        readonly Dictionary<string, ReminderSnooze> _snoozed = new Dictionary<string, ReminderSnooze>();

        // 透明像素穿透：WM_NCHITTEST 需要一张 alpha 蒙版
        byte[] _alpha;
        int _alphaW, _alphaH, _alphaStride;
        int _hitLogLeft = 3;

        Image _sprite;
        Image _mouthImg;
        readonly List<Image> _overlayImgs = new List<Image>();
        Grid _art;
        Grid _uiRoot;            // 两行的根：气泡行 + 立绘行，气泡会按屏幕位置换到下面
        bool _bubbleBelow;
        TranslateTransform _offset;
        Grid _bubble;              // 气泡本体：一个 Path（圆角矩形 + 尾巴合成的一体轮廓）+ 文字/选择肢
        System.Windows.Shapes.Path _bubbleSkin;   // 一体轮廓：填充与描边都在这条路径上，不存在「箭头分家」
        Canvas _skinLayer;                        // 只负责承载轮廓，不影响布局
        double _padX = 18, _padY = 13, _tailH = 16;   // 内边距与尾巴高度（随尺寸重算）
        double _tailAt;            // 尾巴在气泡内的 x（由固定锚点反算）
        Grid _bubbleHost;          // 气泡的宿主：显示/隐藏/动画都作用在它上面
        TextBlock _bubbleText;
        TextBlock _bubbleMeasure;
        StackPanel _bubbleContent;
        ScrollViewer _bubbleScroll;
        WrapPanel _choices;
        Popup _popup;
        Border _popupCard;

        DispatcherTimer _ticker;     // 呼吸 / 跳（只管画面）
        DispatcherTimer _beat;       // 1 s：OnSecondChange / OnMinuteChange / OnHourChange
        DispatcherTimer _remindBeat; // 60 s：到点提醒 / 跨日
        DispatcherTimer _typer;      // 打字机
        DispatcherTimer _idleTalk;   // 随机说话

        string _full = "";
        int _typed;
        int[] _textElements = new int[0];
        double _hopT = -1;           // 0..1 期间为跳跃中

        bool _dragging;
        bool _moved;
        string _layer = "top";      // top=置顶 / normal=普通 / bottom=沉底贴桌面
        double _scale = 1.0;        // 桌宠尺寸倍率：0.5~2.0，立绘和窗口一起缩放
        bool _scaleFromEnv;         // PET_SCALE 指定时只临时生效，不写回 state.json
        double ScaledH { get { return Math.Round(SpriteH * _scale); } }
        double ScaledW { get { return Math.Round(WinW * _scale); } }
        double ScaledWinH { get { return Math.Round(WinH * _scale); } }
        /// <summary>气泡正文的换行宽度：跟着窗口走，缩到 0.5 倍也不会把字挤出框外。</summary>
        double BubbleTextMax { get { return Math.Max(70, BubbleMaxW - 2 * _padX); } }
        /// <summary>气泡连内边距在内的最大宽度：两个地方都要用同一个数，否则长句会撑到窗口边上</summary>
        double BubbleMaxW { get { return Math.Round(Math.Min(410, ScaledW * 0.86)); } }
        /// <summary>气泡字号：尺寸小的时候不许再小（读不清），大的时候跟着放大一点但不失控。</summary>
        double BubbleFontSize { get { return Math.Round(14.5 * Math.Min(1.6, Math.Max(0.9, _scale)) * 2) / 2; } }
        /// <summary>圆角、尖角这些形状也跟着缩放，否则 2 倍尺寸下尖角小得像根毛。</summary>
        double BubbleShapeScale { get { return Math.Min(1.6, Math.Max(0.9, _scale)); } }

        /// <summary>圆角 / 尾巴 / 内边距随尺寸重算（BuildUi 与 ApplyScale 都会调）。</summary>
        void ApplyBubbleShape()
        {
            if (_bubble == null) return;
            double s = BubbleShapeScale;
            _padX = Math.Round(15 * s);
            _padY = Math.Round(10 * s);
            _tailH = Math.Round(12 * s);
            _bubbleContent.Margin = new Thickness(_padX, _padY + (_bubbleBelow ? _tailH : 0),
                _padX, _padY + (_bubbleBelow ? 0 : _tailH));
            _bubbleText.MaxWidth = _bubbleMeasure.MaxWidth = BubbleTextMax;
            _bubbleMeasure.FontSize = _bubbleText.FontSize;
            _bubbleMeasure.LineHeight = _bubbleText.LineHeight;
            _bubbleScroll.MaxHeight = Math.Max(68, Math.Min(228, ScaledH * 0.45));
            RebuildBubbleSkin();
            PositionBubble();
        }

        /// <summary>
        /// 气泡整块形状：圆角矩形 + 下方小尾巴，用 Union 合成一条轮廓再描边。
        /// 尾巴是轮廓的一部分，所以不会出现「箭头和气泡分家」或者接缝横线。
        /// </summary>
        void RebuildBubbleSkin()
        {
            if (_bubbleSkin == null || _bubble == null) return;
            double W = _bubble.ActualWidth, H = _bubble.ActualHeight;
            if (W < 4 || H < 4) return;
            double s = BubbleShapeScale;
            double r = Math.Max(0, Math.Min(Math.Round(14 * s), Math.Min(W / 2, (H - _tailH) / 2)));
            double th = _tailH;
            double bodyH = Math.Max(r * 2 + 2, H - th);

            // 尾巴跟着锚点走（_tailAt 是气泡内坐标）；留出圆角宽度，别贴着角
            double half = Math.Min(Math.Round(10 * s), Math.Max(2, W / 2 - r - 2));
            double ax = Math.Max(r + half + 2, Math.Min(W - r - half - 2, _tailAt));

            var body = new RectangleGeometry(new Rect(0, 0, W, bodyH), r, r);
            var tail = new PathGeometry();
            var fig = new PathFigure
            {
                StartPoint = new Point(ax - half, bodyH - 1),
                IsClosed = true,
                IsFilled = true
            };
            // 两条二次曲线收成一个圆头的尖：风格跟圆角气泡是一套，不是硬邦邦的三角形
            fig.Segments.Add(new QuadraticBezierSegment(new Point(ax - half * 0.55, bodyH + th * 0.62), new Point(ax, bodyH + th), true));
            fig.Segments.Add(new QuadraticBezierSegment(new Point(ax + half * 0.55, bodyH + th * 0.62), new Point(ax + half, bodyH - 1), true));
            tail.Figures.Add(fig);

            var geo = new CombinedGeometry(GeometryCombineMode.Union, body, tail);
            // 气泡在立绘下方时整块轮廓上下翻个身：圆角矩形对称，尾巴就跑到上边去指着她了
            if (_bubbleBelow) geo.Transform = new ScaleTransform(1, -1, W / 2, H / 2);
            _bubbleSkin.Width = W;
            _bubbleSkin.Height = H;
            _bubbleSkin.Stretch = Stretch.Fill;
            _bubbleSkin.Data = geo;
            _bubbleSkin.StrokeThickness = Math.Round(1.1 * s, 1);
        }

        /// <summary>
        /// 气泡按「固定锚点」摆位：锚点 = 窗口宽度的 56%（头顶偏右一点），
        /// 气泡以锚点为中心向两边展开并夹在窗口内；尾巴始终戳在锚点上。
        /// </summary>
        void PositionBubble()
        {
            if (_bubble == null) return;
            double bw = _bubble.ActualWidth;
            if (bw <= 1) bw = _bubble.DesiredSize.Width;
            if (bw <= 1) bw = BubbleMaxW;

            double anchor = Math.Round(ScaledW * 0.56);                 // 固定锚点：头顶偏右
            double left = Math.Round(anchor - bw / 2);                  // 气泡围着锚点展开
            left = Math.Max(8, Math.Min(Math.Max(8, ScaledW - 8 - bw), left));

            _bubble.HorizontalAlignment = HorizontalAlignment.Left;
            if (Math.Abs(_bubble.Margin.Left - left) > 0.5) _bubble.Margin = new Thickness(left, 0, 0, 0);
            _tailAt = anchor - left;                                    // 尾巴在气泡内的位置
            RebuildBubbleSkin();
        }
        System.Windows.Forms.NotifyIcon _tray;
        Point _dragStart;
        Point _winStart;
        int _curFace;

        readonly Random _rnd = new Random();

        static readonly string LogPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "pet.log");

        public static void Log(string s)
        {
            try { File.AppendAllText(LogPath, DateTime.Now.ToString("HH:mm:ss.fff") + "  " + s + "\r\n", Encoding.UTF8); }
            catch { }
        }

        // ---------- 调试开关：v0.27 起统一走 PET_DEBUG=1 ----------
        // 旧的单选开关（PET_DEBUG_HIT / PET_HIT_LOG / PET_DEBUG_BG / PET_CHOICE_TEST）还能用，
        // 但只在第一次被读到的时候打一行 deprecation，下个版本直接删。
        static readonly HashSet<string> _deprecatedFlags = new HashSet<string>();

        static bool EnvOn(string name)
        {
            string v = Environment.GetEnvironmentVariable(name);
            return v == "1" || string.Equals(v, "true", StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>PET_DEBUG=1 打开全部调试输出；legacyName 为旧的独立开关（用了会提示一次）。</summary>
        static bool DebugFlag(string legacyName)
        {
            bool on = EnvOn("PET_DEBUG");
            if (!string.IsNullOrEmpty(legacyName) && EnvOn(legacyName))
            {
                on = true;
                if (_deprecatedFlags.Add(legacyName))
                    Log("deprecated: " + legacyName + "=1，改用 PET_DEBUG=1（下个版本移除）");
            }
            return on;
        }

        /// <summary>只认旧名字的开关（动作型，比如会写库的 CHOICE_TEST，不能跟着 PET_DEBUG 一起开）。</summary>
        static bool LegacyFlag(string name)
        {
            if (!EnvOn(name)) return false;
            if (_deprecatedFlags.Add(name))
                Log("deprecated: " + name + "=1，改用 PET_DEBUG=1（下个版本移除）");
            return true;
        }

        public PetWindow()
        {
            try { File.Delete(LogPath); } catch { }
            Log("start BaseDirectory=" + AppDomain.CurrentDomain.BaseDirectory);
            // 自检模式要在 LoadState 之前就置位：ResetDailyVars 会顺手 SaveState 一次，
            // 晚置位就会留下「今日互动被清零」这种副作用（2026-11-09 实测踩到）
            _selfTest = EnvOn("PET_SELFTEST");
            _root = FindRoot();
            Log("root=" + _root);

            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            // 注意：Background 不能为 null；全透明（alpha=0）在这台机器上会让整层不合成，
            // 所以用 alpha=1 的近透明白，肉眼看不见但能稳定出图（踩过两次）
            Background = DebugFlag("PET_DEBUG_BG")
                ? Brushes.Magenta
                : new SolidColorBrush(Color.FromArgb(1, 255, 255, 255));
            Topmost = true;
            ShowInTaskbar = false;
            ResizeMode = ResizeMode.NoResize;
            Width = ScaledW;
            Height = ScaledH + 12;
            Title = "TIARA · 番组管家";

            _statePath = Path.Combine(_root, "data", "state.json");
            LoadState();          // 先读尺寸，菜单勾选和窗口大小才能对
            var envScale = Environment.GetEnvironmentVariable("PET_SCALE");   // 脚本/调试用，优先于 state.json
            if (!string.IsNullOrEmpty(envScale))
            {
                double ev;
                if (double.TryParse(envScale, NumberStyles.Float, CultureInfo.InvariantCulture, out ev))
                {
                    _scale = ClampScale(ev);
                    _scaleFromEnv = true;
                }
            }
            // PET_POWER=1 强制省电档（测功耗 / 笔记本演示用）
            if (EnvOn("PET_POWER")) _powerSave = true;
            Width = ScaledW;
            Height = ScaledH + 12;
            BuildUi();
            LoadData();
            Log("ui built, sprite.Source=" + (_sprite.Source == null ? "NULL" : "ok") + " scale=" + _scale.ToString("0.##", CultureInfo.InvariantCulture));

            var wa = CurrentWorkAreaDip();
            Left = wa.Right - Width - 18;
            Top = wa.Bottom - Height;
            // 上次拖到哪儿就回哪儿（越界会在 Loaded 里被 SnapIntoWorkArea 兜回来）
            if (_savedLeft != double.MinValue)
            {
                Left = _savedLeft;
                Top = _savedTop;
            }

            Loaded += delegate
            {
                DpiScaleInfo();
                SnapIntoWorkArea();
                InstallHitTest();
                ApplyLayer();
                Log("Loaded actual=" + _sprite.ActualWidth + "x" + _sprite.ActualHeight +
                    " win=" + ActualWidth + "x" + ActualHeight + " visible=" + IsVisible +
                    " at " + Left + "," + Top +
                    " work=" + SystemParameters.WorkArea +
                    " primary=" + SystemParameters.PrimaryScreenWidth + "x" + SystemParameters.PrimaryScreenHeight +
                    " vw=" + SystemParameters.VirtualScreenWidth + "x" + SystemParameters.VirtualScreenHeight);
            };

            StartTick();
            StartBeat();
            StartReminderTimer();
            ScheduleMidnight();
            CreateTray();
            if (!_selfTest)
            {
                _panelHost = new PanelHost(_root, Log);
                UsePanel(null, false);
            }
            TryAutoSync();
            var boot = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(600) };
            boot.Tick += delegate
            {
                boot.Stop();
                try
                {
                    SayBoot();
                    Log("SayBoot ok bubble=" + _bubble.ActualWidth + "x" + _bubble.ActualHeight +
                        " win=" + ActualWidth + "x" + ActualHeight);
                    if (_loadError != null)
                    {
                        string le = _loadError;
                        _loadError = null;
                        var et = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2.6) };
                        et.Tick += delegate { et.Stop(); Say(new Line(le, 2)); };
                        et.Start();
                    }
                    if (DebugFlag("PET_SNAPSHOT"))
                    {
                        try { Snapshot(Path.Combine(_root, "cache", "pet_render.png")); Log("snapshot saved"); }
                        catch (Exception ex) { Log("snapshot failed " + ex.Message); }
                        var snap = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(2200) };
                        snap.Tick += delegate
                        {
                            snap.Stop();
                            try { Snapshot(Path.Combine(_root, "cache", "pet_render_text.png")); }
                            catch (Exception ex) { Log("snapshot2 failed " + ex.Message); }
                        };
                        snap.Start();
                    }
                    if (DebugFlag("PET_POPUP_SHOT"))
                    {
                        var ps = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(1200) };
                        ps.Tick += delegate
                        {
                            ps.Stop();
                            try
                            {
                                RefreshPopup();
                                _popupCard.Measure(new Size(320, double.PositiveInfinity));
                                _popupCard.Arrange(new Rect(new Point(0, 0), _popupCard.DesiredSize));
                                _popupCard.UpdateLayout();
                                SnapshotElement(_popupCard, Path.Combine(_root, "cache", "pet_popup.png"));
                            }
                            catch (Exception ex) { Log("popup shot failed " + ex.Message); }
                        };
                        ps.Start();
                    }
                }
                catch (Exception ex) { Log("SayBoot FAILED " + ex); }
                // 版式自检用：PET_SAY="随便一句话" 直接念这句，专门用来量短句/长句下气泡与尖角的位置
                string forced = Environment.GetEnvironmentVariable("PET_SAY");
                if (!string.IsNullOrEmpty(forced))
                {
                    Say(new Line(forced, 0));
                    Log("forced say len=" + forced.Length);
                }
                if (EnvOn("PET_SELFTEST")) StartSelfTest();
                if (LegacyFlag("PET_CHOICE_TEST"))
                {
                    var ct = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) };
                    ct.Tick += delegate
                    {
                        ct.Stop();
                        SayWithChoices(new Line("要不要现在记一话？", 0),
                            new Choice("记一话", delegate { Log("CHOICE FIRED bump (dry-run，不写库)"); }),
                            new Choice("算了", delegate { Log("CHOICE FIRED cancel"); Say(PickFrom("soft", null, 2, "嗯。")); }));
                        var cs = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(700) };
                        cs.Tick += delegate
                        {
                            cs.Stop();
                            try
                            {
                                var b0 = _choices.Children[0] as FrameworkElement;
                                var p0 = b0.PointToScreen(new Point(0, 0));
                                var p1 = b0.PointToScreen(new Point(b0.ActualWidth, b0.ActualHeight));
                                Log("CHOICE-RECT " + Math.Round((p0.X + p1.X) / 2) + "," +
                                    Math.Round((p0.Y + p1.Y) / 2) + " win=" + Math.Round(Left) + "," +
                                    Math.Round(Top) + " " + Math.Round(Width) + "x" + Math.Round(Height));
                            }
                            catch (Exception ex) { Log("choice rect err " + ex.Message); }
                        };
                        cs.Start();
                    };
                    ct.Start();
                }
                ScheduleIdleTalk();
            };
            boot.Start();
        }

        void DpiScaleInfo()
        {
            try
            {
                var src = PresentationSource.FromVisual(this);
                if (src != null && src.CompositionTarget != null)
                {
                    var m = src.CompositionTarget.TransformToDevice;
                    Log("dpiScale=" + m.M11 + "," + m.M22);
                }
            }
            catch (Exception ex) { Log("dpi probe failed " + ex.Message); }
        }

        /// <summary>当前窗口所在屏的缩放比（1.25 = 125%）；取不到就退回 1。</summary>
        double DpiScaleValue()
        {
            try
            {
                var src = PresentationSource.FromVisual(this);
                if (src != null && src.CompositionTarget != null)
                {
                    double s = src.CompositionTarget.TransformToDevice.M11;
                    if (s >= 0.5 && s <= 3.0) return s;
                }
            }
            catch { }
            return 1.0;
        }

        /// <summary>
        /// 窗口所在那块屏的工作区，单位 DIP。不能用 SystemParameters.WorkArea —— 那个永远只给主屏，
        /// 宠物被拖到副屏之后气泡的 roomAbove/roomBelow 就会按主屏算，直接飘到屏外。
        /// </summary>
        Rect CurrentWorkAreaDip()
        {
            try
            {
                IntPtr h = new WindowInteropHelper(this).Handle;
                if (h != IntPtr.Zero)
                {
                    var scr = System.Windows.Forms.Screen.FromHandle(h);   // 按窗口所在屏，不是主屏
                    var wa = scr.WorkingArea;                              // 物理像素
                    double k = DpiScaleValue();
                    if (k > 0.1) return new Rect(wa.Left / k, wa.Top / k, wa.Width / k, wa.Height / k);
                }
            }
            catch { }
            return SystemParameters.WorkArea;
        }

        /// <summary>按当前屏工作区高度夹紧尺寸：1080p@125% 最多 125%，避免选 200% 后有一截永远在屏外。</summary>
        double MaxScale()
        {
            try
            {
                double max = (CurrentWorkAreaDip().Height - 120) / SpriteH;   // 120 = 任务栏 + 一点余量
                if (max < 0.5) max = 0.5;
                if (max > 2.0) max = 2.0;
                return Math.Floor(max * 20) / 20;                             // 5% 步进，和菜单/面板对得上
            }
            catch { return 2.0; }
        }

        double ClampScale(double s)
        {
            return Math.Max(0.5, Math.Min(MaxScale(), s));
        }

        // 把当前界面按 WPF 自己的布局渲染成 PNG（不受 GDI 抓不到透明层的影响，用来验版式）
        void Snapshot(string path)
        {
            var el = Content as FrameworkElement;
            if (el == null) return;
            SnapshotElement(el, path);
        }

        // 单独渲染任意元素（气泡、面板卡片）——用来验版式
        void SnapshotElement(FrameworkElement el, string path)
        {
            if (el == null) return;
            int w = (int)Math.Ceiling(el.ActualWidth);
            int h = (int)Math.Ceiling(el.ActualHeight);
            if (w <= 0 || h <= 0) { Log("snapshot skipped, empty " + w + "x" + h + " → " + path); return; }
            var bmp = new RenderTargetBitmap(w, h, 96, 96, PixelFormats.Pbgra32);
            bmp.Render(el);
            var enc = new PngBitmapEncoder();
            enc.Frames.Add(BitmapFrame.Create(bmp));
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
            using (var fs = File.Create(path)) enc.Save(fs);
            Log("snapshot " + w + "x" + h + " → " + path);
        }

        // ---- 屏幕边界兜底 ----
        // SystemParameters.WorkArea 在这台机器上给的是物理像素，而 Left/Top 是 DIP，
        // 直接相减会把窗口放到屏幕外（踩过：只剩 44px 露在屏幕里）。
        // 所以落地后用 Win32 实测一次，超出就按实测比例折回 DIP 拉回来。
        [StructLayout(LayoutKind.Sequential)]
        struct RECT { public int Left, Top, Right, Bottom; }

        [DllImport("user32.dll")]
        static extern bool GetWindowRect(IntPtr hWnd, out RECT r);

        [DllImport("user32.dll")]
        static extern int GetSystemMetrics(int index);

        // ---- 拖动用：屏幕坐标（不随窗口移动，避免「窗口跟着鼠标却总被甩在后面」的反馈环）----
        [StructLayout(LayoutKind.Sequential)]
        struct POINT { public int X, Y; }

        [DllImport("user32.dll")]
        static extern bool GetCursorPos(out POINT p);

        // ---- 窗口层级 ----
        [DllImport("user32.dll")]
        static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);

        static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
        static readonly IntPtr HWND_BOTTOM = new IntPtr(1);
        const uint SWP_NOSIZE = 0x0001;
        const uint SWP_NOMOVE = 0x0002;
        const uint SWP_NOACTIVATE = 0x0010;

        /// <summary>鼠标在屏幕上的位置，换算成 DIP（= Left/Top 的单位）。</summary>
        Point CursorDip()
        {
            POINT p;
            if (GetCursorPos(out p))
            {
                double sx = 1, sy = 1;
                var src = PresentationSource.FromVisual(this);
                if (src != null && src.CompositionTarget != null)
                {
                    sx = src.CompositionTarget.TransformFromDevice.M11;
                    sy = src.CompositionTarget.TransformFromDevice.M22;
                }
                return new Point(p.X * sx, p.Y * sy);
            }
            // 取不到系统光标就退回老办法，至少能动
            Point rel = Mouse.GetPosition(this);
            return new Point(Left + rel.X, Top + rel.Y);
        }

        /// <summary>置顶 / 普通 / 沉底三档，走 Win32，避免反复改 Topmost 属性引起重排。</summary>
        void ApplyLayer()
        {
            try
            {
                Topmost = _layer == "top";
                IntPtr h = new WindowInteropHelper(this).Handle;
                if (h == IntPtr.Zero) return;
                IntPtr after = _layer == "bottom" ? HWND_BOTTOM : (_layer == "normal" ? HWND_NOTOPMOST : HWND_TOPMOST);
                SetWindowPos(h, after, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                Log("layer=" + _layer);
            }
            catch (Exception ex) { Log("layer failed " + ex.Message); }
        }

        void SetLayer(string v)
        {
            if (v != "top" && v != "normal" && v != "bottom") v = "top";
            _layer = v;
            ApplyLayer();
            SaveState();
        }

        /// <summary>
        /// 把窗口拽回屏幕里。这机器上「进程感知」和 WPF 的坐标不是一套：
        /// GetSystemMetrics 说 2560 宽、WinForms 的 Screen 说 2048（物理），WPF 的 Left 又是按 1.25 倍错开的。
        /// 所以统一走「物理矩形 + 实测缩放比」这条路：GetWindowRect 拿物理位置，除以 pw/ActualWidth 换算回 DIP。
        /// </summary>
        void SnapIntoWorkArea()
        {
            try
            {
                IntPtr h = new WindowInteropHelper(this).Handle;
                if (h == IntPtr.Zero) return;
                RECT r;
                if (!GetWindowRect(h, out r)) return;
                double pw = r.Right - r.Left, ph = r.Bottom - r.Top;
                if (pw <= 1 || ph <= 1 || ActualWidth <= 1) return;
                double scale = DpiScaleValue();
                if (scale < 0.5 || scale > 3) scale = 1;

                // 按「窗口现在所在的那块屏」夹，副屏也一样；之前一律 PrimaryScreen，拖到副屏一改尺寸就跳回主屏
                var wa = System.Windows.Forms.Screen.FromHandle(h).WorkingArea;   // 物理像素
                const int margin = 6;
                double dx = 0, dy = 0;
                if (r.Right > wa.Right - margin) dx = (wa.Right - margin) - r.Right;
                if (r.Left + dx < wa.Left + margin) dx = (wa.Left + margin) - r.Left;
                if (r.Bottom > wa.Bottom - margin) dy = (wa.Bottom - margin) - r.Bottom;
                if (r.Top + dy < wa.Top + margin) dy = (wa.Top + margin) - r.Top;
                Log("snap check physical=" + r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom +
                    " wa=" + wa.Left + "," + wa.Top + "," + wa.Right + "," + wa.Bottom +
                    " scale=" + scale.ToString("0.####") + " d=" + Math.Round(dx) + "," + Math.Round(dy));
                if (Math.Abs(dx) < 1 && Math.Abs(dy) < 1) return;
                Left += dx / scale;
                Top += dy / scale;
            }
            catch (Exception ex) { Log("snap failed " + ex.Message); }
        }

        // ================= 路径 =================
        internal static string FindRoot()
        {
            string dir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            // exe 可能在 <root>\pet\ 也可能在 <root>\
            if (Directory.Exists(Path.Combine(dir, "ghost")) && Directory.Exists(Path.Combine(dir, "shell"))) return dir;
            DirectoryInfo parent = Directory.GetParent(dir);
            if (parent != null) return parent.FullName;
            return dir;
        }

        // ================= 界面 =================
        void BuildUi()
        {
            // 用 Grid 而不是 StackPanel：Grid 一定撑满窗口宽度，
            // 气泡的 HorizontalAlignment=Center 才是「相对窗口居中」，不会被内容宽度带偏（踩过）
            var grid = new Grid { Background = null, VerticalAlignment = VerticalAlignment.Bottom };
            grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            // 行高固定成立绘高度：气泡变高时窗口只往上长，立绘的屏幕位置一动不动
            grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(ScaledH) });
            _uiRoot = grid;

            _bubbleText = new TextBlock
            {
                FontFamily = new FontFamily("Microsoft YaHei UI, Microsoft YaHei, Segoe UI"),
                FontSize = BubbleFontSize,
                Foreground = Ink,
                TextWrapping = TextWrapping.Wrap,
                LineHeight = Math.Round(BubbleFontSize * 1.58),   // 比字号宽一点，中文才不挤
                MaxWidth = BubbleTextMax  // 随窗口宽度走，见 ApplyScale
            };
            _bubbleMeasure = new TextBlock
            {
                FontFamily = _bubbleText.FontFamily,
                TextWrapping = TextWrapping.Wrap,
                Visibility = Visibility.Hidden,
                IsHitTestVisible = false
            };
            var textLayer = new Grid();
            textLayer.Children.Add(_bubbleMeasure);
            textLayer.Children.Add(_bubbleText);
            _bubbleScroll = new ScrollViewer
            {
                Content = textLayer,
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
                PanningMode = PanningMode.VerticalOnly
            };
            AutomationProperties.SetName(_bubbleScroll, "TIARA 台词");
            // 气泡是「一整块形状」：圆角矩形和下面的小尾巴用 CombinedGeometry 合并成一条轮廓，
            // 再一次性填充 + 描边——所以描边是连续的、没有接缝，也就不存在「箭头和气泡分家」。
            _bubbleSkin = new System.Windows.Shapes.Path
            {
                Fill = BubbleFill,
                Stroke = BubbleLine,
                StrokeThickness = 1.1,
                StrokeLineJoin = PenLineJoin.Round,
                IsHitTestVisible = false,
                SnapsToDevicePixels = true,
                Effect = new DropShadowEffect { Color = Colors.Black, BlurRadius = 15, ShadowDepth = 2, Direction = 270, Opacity = 0.19 }
            };
            _bubble = new Grid
            {
                HorizontalAlignment = HorizontalAlignment.Left,
                MaxWidth = BubbleMaxW,
                Background = Brushes.Transparent
            };
            // 放进 Canvas：Canvas 不参与度量，轮廓不会反过来把气泡撑大（曾经撑到 4791px）
            _skinLayer = new Canvas { IsHitTestVisible = false, ClipToBounds = false };
            _skinLayer.Children.Add(_bubbleSkin);
            _bubble.Children.Add(_skinLayer);

            // 立绘是「底图 + 覆盖层」，不再是单张图：口型、腮红这类零件各占一层，
            // 想加表情只要往 shell/master 丢张同尺寸 PNG 并在 faces.json 里登记。
            _sprite = new Image
            {
                Stretch = Stretch.Uniform,
                SnapsToDevicePixels = true,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Bottom,
                Height = ScaledH        // 一开始就得给尺寸，否则换过尺寸的机器启动时立绘是原始大小
            };
            _mouthImg = new Image
            {
                Stretch = Stretch.Uniform,
                SnapsToDevicePixels = true,
                IsHitTestVisible = false,
                Visibility = Visibility.Collapsed
            };
            _offset = new TranslateTransform();
            _art = new Grid
            {
                Width = ScaledW,        // 和窗口同宽：点击范围与窗口一致，缩放过也不会偏
                Height = ScaledH,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Bottom,
                Cursor = Cursors.Hand,
                ToolTip = "点头 = 摸头 · 点脸 = 搭话 · 拖动可移走",
                RenderTransform = _offset
            };
            _art.Children.Add(_sprite);
            _art.Children.Add(_mouthImg);

            _art.MouseLeftButtonDown += OnSpriteDown;
            _art.MouseMove += OnSpriteMove;
            _art.MouseLeftButtonUp += OnSpriteUp;
            _art.MouseWheel += OnSpriteWheel;                 // 滚轮缩放（wheel 池的触发点）
            _art.MouseRightButtonUp += (s, e) => { ShowMenu(); e.Handled = true; };

            // 气泡里的选择肢（等价于伪春菜的 OnChoiceSelect）：平时藏起来
            _choices = new WrapPanel
            {
                Orientation = Orientation.Horizontal,
                HorizontalAlignment = HorizontalAlignment.Right,
                Margin = new Thickness(0, 6, 0, 0),
                Visibility = Visibility.Collapsed
            };
            var header = new DockPanel { Margin = new Thickness(0, 0, 0, 4) };
            var close = BubbleButton("×", "收起对话", true);
            close.Click += delegate { DismissBubble(); };
            DockPanel.SetDock(close, Dock.Right);
            header.Children.Add(close);
            header.Children.Add(new TextBlock
            {
                Text = "TIARA", FontFamily = new FontFamily("Georgia"), FontSize = 11,
                FontWeight = FontWeights.Bold, Foreground = BubbleAccent, Margin = new Thickness(0, 0, 14, 0),
                VerticalAlignment = VerticalAlignment.Center
            });
            _bubbleContent = new StackPanel();
            _bubbleContent.Children.Add(header);
            _bubbleContent.Children.Add(_bubbleScroll);
            _bubbleContent.Children.Add(_choices);
            _bubble.Children.Add(_bubbleContent);
            _bubble.SizeChanged += delegate { PositionBubble(); };

            // 气泡装在一个铺满窗口宽度的宿主里：显示/隐藏、动画都挂在宿主上。
            // 气泡水平位置按「固定锚点」算（头顶偏右 56%），尾巴画在气泡自己的轮廓里。
            _bubbleHost = new Grid
            {
                Visibility = Visibility.Collapsed,
                Margin = new Thickness(0, 12, 0, 8),     // 和立绘拉开一点距离，别贴着头顶
                VerticalAlignment = VerticalAlignment.Bottom,
                Background = null
            };
            _bubbleHost.Children.Add(_bubble);
            // 点气泡＝把这句话立刻显示完（打字机太慢时的手感补偿）
            _bubbleText.MouseLeftButtonUp += delegate
            {
                if (_typer != null && _typer.IsEnabled) CompleteBubbleText();
            };
            _bubble.MouseEnter += delegate { if (_hideTimer != null) _hideTimer.Stop(); };
            _bubble.MouseLeave += delegate { ArmBubbleHide(); };
            _bubble.IsKeyboardFocusWithinChanged += delegate { ArmBubbleHide(); };
            _bubble.PreviewKeyDown += delegate(object sender, KeyEventArgs e)
            {
                if (e.Key == Key.Escape) { DismissBubble(); e.Handled = true; }
            };

            Grid.SetRow(_bubbleHost, 0);
            Grid.SetRow(_art, 1);
            grid.Children.Add(_bubbleHost);
            grid.Children.Add(_art);
            Content = grid;

            ApplyBubbleShape();
            BuildMenu();
            BuildPopup();
        }

        /// <summary>菜单文案：优先 talks.json 的 menu 池（可改、可翻译），没有就用兜底中文</summary>
        string M(string key, string dflt)
        {
            string v;
            string s = _menuText.TryGetValue(key, out v) && !string.IsNullOrEmpty(v) ? v : dflt;
            return Fill(s);
        }

        /// <summary>禁用状态的表头项（菜单最上面那两行）</summary>
        static MenuItem Head(string text, Brush fg, double size, bool bold)
        {
            return new MenuItem
            {
                Header = text,
                IsEnabled = false,
                FontSize = size,
                FontWeight = bold ? FontWeights.SemiBold : FontWeights.Normal,
                Foreground = fg
            };
        }

        static MenuItem Sub(string header, params object[] items)
        {
            var mi = new MenuItem { Header = header };
            foreach (var it in items)
            {
                var sep = it as Separator;
                if (sep != null) { mi.Items.Add(new Separator()); continue; }
                var m = it as MenuItem;
                if (m != null) mi.Items.Add(m);
            }
            return mi;
        }

        /// <summary>
        /// 右键菜单。
        ///
        /// 和以前那版平铺 11 项的区别：先给状态（今天几件、还没处理几件），
        /// 再给「案件」子菜单——每一项一部番，点一下就是 +1 话；
        /// 排障动作收进「上級」，不再和「说句话」并排。
        /// </summary>
        void BuildMenu()
        {
            var menu = new ContextMenu
            {
                Background = Paper,
                BorderBrush = Ink,
                BorderThickness = new Thickness(2),
                FontFamily = new FontFamily("Microsoft YaHei UI"),
                FontSize = 13,
                Placement = PlacementMode.Mouse
            };

            int todayCount = I("count");
            int pending = I("behind_count");

            // —— 表头：她是谁、现在什么状况 ——
            menu.Items.Add(Head(M("header", "{nickname} · 副会長室"), Ink, 12, true));
            menu.Items.Add(Head(
                todayCount > 0
                    ? M("header_count", "今日 {count} 件 · 未処理 {pending} 件").Replace("{pending}", pending.ToString())
                    : M("header_empty", "今日は静かです"),
                pending > 0 ? Brushes.Firebrick : Brushes.Gray, 11, false));
            menu.Items.Add(new Separator());

            // —— 案件：一部番一行，点一下就记一话 ——
            var cases = new MenuItem { Header = M("cases", "案件") };
            if (todayCount == 0)
            {
                cases.Items.Add(new MenuItem { Header = M("case_none", "今日は案件なし"), IsEnabled = false });
            }
            else
            {
                for (int i = 1; i <= todayCount; i++)
                {
                    string sid = V("show" + i + "_id", "");
                    string sname = V("show" + i + "_name", "第 " + i + " 部");
                    string stime = TimeCell(V("show" + i + "_time_disp", V("show" + i + "_time", "")));
                    var item = new MenuItem { Header = stime + "  " + sname };
                    if (sid.Length == 0) { item.IsEnabled = false; }
                    else
                    {
                        string cid = sid, cname = sname;
                        item.Click += delegate { BumpShow(cid, cname, 1); };
                    }
                    cases.Items.Add(item);
                }
            }
            menu.Items.Add(cases);

            // —— 番組表 ——
            menu.Items.Add(Sub(M("panel", "番組表"),
                Item(M("panel_bubble", "气泡番組表"), (s, e) => TogglePanel()),
                Item(M("panel_web", "網頁番組表"), (s, e) => OpenWebPanel()),
                new Separator(),
                Item(M("panel_refresh", "再計算"), (s, e) => RefreshData(true))));

            menu.Items.Add(Item(M("say", "説句話"), (s, e) => { Say(PickRandom(), true); ScheduleIdleTalk(); }));
            menu.Items.Add(Item(M("nade", "摸摸頭"), (s, e) => NadeSay()));
            menu.Items.Add(new Separator());

            // —— 業務：同步 + 上級（排障与开发动作） ——
            var adv = Sub(M("advanced", "上級"),
                Item(M("recalc", "重算今日数据"), (s, e) => RefreshData(true)),
                Item(M("openfolder", "打开数据文件夹"), (s, e) => OpenFolder("data")),
                Item(M("logs", "看服务日志"), (s, e) => OpenFolder("cache", "server.log")));

            menu.Items.Add(Sub(M("biz", "業務"),
                Item(M("sync", "同步 Bangumi"), (s, e) => SyncBangumi()),
            Item(M("undo", "撤销上一次记账"), (s, e) => UndoLast()),
                adv));

            // —— 表示：层级 / 尺寸 ——
            var layer = new MenuItem { Header = M("layer", "層級") };
            AddLayerItem(layer, "置顶显示", "top");
            AddLayerItem(layer, "普通（会被其他窗口盖住）", "normal");
            AddLayerItem(layer, "沉底（贴桌面）", "bottom");

            var size = new MenuItem { Header = M("size", "尺寸") };
            AddScaleItem(size, "小（70%）", 0.7);
            AddScaleItem(size, "偏小（85%）", 0.85);
            AddScaleItem(size, "标准（100%）", 1.0);
            AddScaleItem(size, "偏大（125%）", 1.25);
            AddScaleItem(size, "大（150%）", 1.5);

            menu.Items.Add(Sub(M("view", "表示"), layer, size));
            menu.Items.Add(new Separator());

            var power = new MenuItem { Header = "省电模式（不呼吸、4 帧）", IsCheckable = true, IsChecked = _powerSave };
            power.Click += delegate
            {
                _powerSave = power.IsChecked;
                Log("power_save=" + _powerSave);
                SaveState();
                SavePowerToSettings(_powerSave);
                Say(new Line(_powerSave ? "……電力、節約します。" : "……呼吸、再開します。", 0), true);
            };
            menu.Items.Add(power);

            var auto = new MenuItem { Header = "开机自启", IsCheckable = true, IsChecked = IsAutostartEnabled() };
            auto.Click += delegate
            {
                SetAutostart(auto.IsChecked);
                Log("autostart=" + auto.IsChecked);
                Say(new Line(auto.IsChecked ? "……毎朝、出席します。" : "……朝は、不在にします。", 0), true);
            };
            menu.Items.Add(auto);

            menu.Items.Add(Item(M("hide", "隱藏到托盤"), (s, e) => HideToTray()));
            menu.Items.Add(new Separator());
            menu.Items.Add(Item(M("quit", "退出"), (s, e) => BeginQuit()));
            ContextMenu = menu;
        }

        /// <summary>打开数据目录 / 某个日志文件（菜单「上級」用）</summary>
        void OpenFolder(string sub, string file = null)
        {
            try
            {
                string target = file == null ? Path.Combine(_root, sub) : Path.Combine(_root, sub, file);
                if (file != null && !File.Exists(target))
                {
                    Say(new Line("……ファイルがありません。", 2), true);
                    return;
                }
                System.Diagnostics.Process.Start("explorer.exe", file == null ? "\"" + target + "\"" : "/select,\"" + target + "\"");
            }
            catch (Exception ex) { Log("open folder failed: " + ex.Message); }
        }

        /// <summary>尺寸单选项：选中的打勾，改完立刻重排窗口并记住</summary>
        /// <summary>改尺寸：以窗口底部中点为中心缩放，别让立绘跑出屏幕。persist=true 时同时写回 settings.json。</summary>
        void ApplyScale(double scale, bool persist = true)
        {
            scale = ClampScale(scale);
            double cx = Left + Width / 2;
            double bottom = _bubbleBelow ? Top + ScaledH : Top + Height;
            _scale = scale;
            if (_sprite != null) _sprite.Height = ScaledH;
            if (_art != null) { _art.Width = ScaledW; _art.Height = ScaledH; }
            Width = ScaledW;
            Height = ScaledH + 12;
            if (_bubbleBelow) LayoutBubble(false);
            // 气泡宽度与字号也得跟着改，否则小尺寸下气泡比窗口还宽
            if (_bubbleText != null)
            {
                _bubbleText.MaxWidth = BubbleTextMax;
                _bubbleText.FontSize = BubbleFontSize;
                _bubbleText.LineHeight = Math.Round(BubbleFontSize * 1.58);
            }
            if (_bubble != null) _bubble.MaxWidth = BubbleMaxW;
            PositionBubble();
            ApplyBubbleShape();
            Left = cx - Width / 2;
            Top = bottom - Height;
            Log("geom top=" + Math.Round(Top) + " h=" + Math.Round(Height) + " artTop=" + Math.Round(Top + Height - ScaledH));
            if (_bubbleHost != null && _bubbleHost.Visibility == Visibility.Visible) ApplyHeight(true);
            SnapIntoWorkArea();
            SaveState();
            // settings.json 是尺寸的唯一真源（面板改的也是它）；只写 state.json 会被 60 s 后的检查掰回去
            if (persist) SaveScaleToSettings(_scale);
            Log("scale=" + _scale.ToString("0.##", CultureInfo.InvariantCulture) + " win=" + Width.ToString("0") + "x" + Height.ToString("0") + " bubbleMax=" + BubbleTextMax.ToString("0") + " max=" + MaxScale().ToString("0.##", CultureInfo.InvariantCulture));
        }

        void AddScaleItem(MenuItem parent, string head, double scale)
        {
            double max = MaxScale();
            bool tooBig = scale > max + 0.001;      // 本屏放不下的档位直接灰掉，别让人选了才发现看不全
            var mi = new MenuItem
            {
                Header = tooBig ? head + "（本屏放不下）" : head,
                IsCheckable = true,
                IsChecked = Math.Abs(_scale - scale) < 0.01,
                IsEnabled = !tooBig
            };
            mi.Click += delegate
            {
                foreach (object o in parent.Items)
                {
                    var m = o as MenuItem;
                    if (m != null) m.IsChecked = (m == mi);
                }
                ApplyScale(scale);
            };
            parent.Items.Add(mi);
        }

        void AddLayerItem(MenuItem parent, string head, string key)
        {
            var mi = new MenuItem { Header = head, IsCheckable = true, IsChecked = _layer == key };
            mi.Click += delegate
            {
                foreach (object o in parent.Items)
                {
                    var m = o as MenuItem;
                    if (m != null) m.IsChecked = (m == mi);
                }
                SetLayer(key);
            };
            parent.Items.Add(mi);
        }

        static MenuItem Item(string head, RoutedEventHandler h)
        {
            var mi = new MenuItem { Header = head };
            mi.Click += h;
            return mi;
        }

        void BuildPopup()
        {
            _popupCard = new Border
            {
                Background = Paper,
                BorderBrush = Ink,
                BorderThickness = new Thickness(2),
                Padding = new Thickness(0),
                Width = 322,
                MaxHeight = Math.Max(320, CurrentWorkAreaDip().Height * 0.78),
                Effect = null
            };
            _popup = new Popup
            {
                Child = _popupCard,
                Placement = PlacementMode.Left,
                PlacementTarget = this,
                StaysOpen = false,
                AllowsTransparency = true,
                HorizontalOffset = -12,
                VerticalOffset = 0
            };
        }

        void ShowMenu()
        {
            // 每次打开都重建：案件列表跟着 today.txt 走，记完一话再看就是新数
            BuildMenu();
            if (ContextMenu != null)
            {
                ContextMenu.PlacementTarget = _sprite;
                ContextMenu.IsOpen = true;
                Post("OnMenuOpen");
            }
        }

        // ================= 数据 =================
        /// <summary>today.txt 读失败时的提示，等窗口建好（boot 之后）再张嘴说</summary>
        string _loadError;

        void LoadData()
        {
            string p = Path.Combine(_root, "ghost", "master", "today.txt");
            // 读失败就沿用上一次的 _vars：宁可显示旧番单，也别把「文件读不到」伪装成「今天没番」
            var fresh = new Dictionary<string, string>();
            try
            {
                foreach (string raw in File.ReadAllLines(p, Encoding.UTF8))
                {
                    string line = raw.Trim();
                    if (line.Length == 0 || line.StartsWith("#")) continue;
                    int eq = line.IndexOf('=');
                    if (eq <= 0) continue;
                    string k = line.Substring(0, eq).Trim();     // "key = value" 以前会得到 "key "，静默读成 0
                    string v = line.Substring(eq + 1).Trim();
                    if (k.Length == 0) continue;
                    fresh[k] = v;
                    if (k != k.ToLowerInvariant()) fresh[k.ToLowerInvariant()] = v;   // 大小写归一
                }
                _vars = fresh;
                _loadError = null;
            }
            catch (Exception ex)
            {
                // 构造期 _bubble 还没建，不能直接 Say：记下来，boot 之后再说
                _loadError = "今天的番单读不出来……先照上一次的记。";
                Log("today.txt read failed: " + ex.Message + " path=" + p + " keep=" + _vars.Count);
                if (_vars.Count == 0)
                {
                    _vars["summary"] = "读不到 today.txt：" + ex.Message;
                    _vars["count"] = "0";
                }
            }
            Log("today.txt vars=" + _vars.Count + " summary=" + V("summary", "(none)"));
            Array.Clear(_faceCache, 0, _faceCache.Length);
            _talkImg = null;
            for (int i = 0; i < 6; i++)
            {
                string sp = Path.Combine(_root, "shell", "master", "surface" + i + ".png");
                _surfaces[i] = File.Exists(sp) ? sp : null;
                if (_surfaces[i] == null) Log("missing surface" + i + " at " + sp);
            }
            // 口型帧：打字时临时换成这张，打完再切回台词对应的表情（有就用，没有就算了）
            string tp = Path.Combine(_root, "shell", "master", "talk.png");
            if (File.Exists(tp))
            {
                try
                {
                    var b = new BitmapImage();
                    b.BeginInit();
                    b.CacheOption = BitmapCacheOption.OnLoad;
                    b.UriSource = new Uri(tp);
                    b.EndInit();
                    b.Freeze();
                    _talkImg = b;
                    Log("talk frame loaded");
                }
                catch (Exception ex) { Log("talk frame load failed: " + ex.Message); }
            }
            LoadFaces();
            LoadTalks();
            _linesReady = false;
            SetFace(0);
        }

        /// <summary>读 data/talks.json —— 台词唯一真源，面板和桌宠共用一份</summary>
        void LoadTalks()
        {
            _talks = new Dictionary<string, object>();
            string p = Path.Combine(_root, "data", "talks.json");
            try
            {
                string json = File.ReadAllText(p, Encoding.UTF8);
                var ser = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024 };
                _talks = ser.Deserialize<Dictionary<string, object>>(json) ?? new Dictionary<string, object>();
                _menuText = new Dictionary<string, string>();
                object mo;
                if (_talks.TryGetValue("menu", out mo))
                {
                    var md = mo as Dictionary<string, object>;
                    if (md != null)
                        foreach (var kv in md) _menuText[kv.Key] = Convert.ToString(kv.Value) ?? "";
                }
                Log("talks.json pools=" + _talks.Count + " menu=" + _menuText.Count);
                BuildMenu();
            }
            catch (Exception ex)
            {
                Log("talks.json load failed: " + ex.Message + " path=" + p);
            }
        }

        /// <summary>表情名 → shell 索引（与 panel/index.html 的 FACE_ALIAS 一致）</summary>
        static int FaceIndex(string name)
        {
            switch (name)
            {
                case "happy": return 1;
                case "sad": return 2;
                case "surprise": return 3;
                case "sleepy": return 4;
                case "think": return 5;
                default: return 0;
            }
        }

        string V(string k, string dflt)
        {
            string v;
            return _vars.TryGetValue(k, out v) && !string.IsNullOrEmpty(v) ? v : dflt;
        }

        int I(string k)
        {
            int n;
            return int.TryParse(V(k, "0"), out n) ? n : 0;
        }

        /// <summary>读 shell/master/faces.json：底图 / 覆盖层 / 口型 / 命中区域。没有就整套退回「4 张整图」。</summary>
        void LoadFaces()
        {
            _faceBase.Clear();
            _faceOverlay.Clear();
            _regions.Clear();
            _mouthSrc = null;
            string mp = Path.Combine(_root, "shell", "master", "faces.json");
            if (!File.Exists(mp)) { Log("faces.json 不存在，退回整图模式"); return; }
            try
            {
                var ser = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };
                var d = ser.Deserialize<Dictionary<string, object>>(File.ReadAllText(mp, Encoding.UTF8));
                if (d == null) return;
                object cv;
                if (d.TryGetValue("canvas", out cv))
                {
                    var arr = AsList(cv);
                    if (arr != null && arr.Count == 2)
                    {
                        _canvasW = Convert.ToDouble(arr[0], CultureInfo.InvariantCulture);
                        _canvasH = Convert.ToDouble(arr[1], CultureInfo.InvariantCulture);
                    }
                }
                object rg;
                if (d.TryGetValue("regions", out rg))
                {
                    var list = AsList(rg);
                    if (list == null) Log("regions 类型不对：" + (rg == null ? "null" : rg.GetType().Name));
                    else
                        foreach (var o in list)
                        {
                            var r = o as Dictionary<string, object>;
                            if (r == null) { Log("region 项不是对象：" + (o == null ? "null" : o.GetType().Name)); continue; }
                            object nm, rc;
                            if (!r.TryGetValue("name", out nm) || !r.TryGetValue("rect", out rc)) { Log("region 缺字段"); continue; }
                            var a = AsList(rc);
                            if (a == null || a.Count != 4) { Log("region.rect 不是 4 个数：" + (rc == null ? "null" : rc.GetType().Name)); continue; }
                            _regions[Str(nm)] = new Rect(
                                Convert.ToDouble(a[0], CultureInfo.InvariantCulture),
                                Convert.ToDouble(a[1], CultureInfo.InvariantCulture),
                                Convert.ToDouble(a[2], CultureInfo.InvariantCulture),
                                Convert.ToDouble(a[3], CultureInfo.InvariantCulture));
                        }
                }
                object mh;
                if (d.TryGetValue("mouth", out mh))
                {
                    var m = mh as Dictionary<string, object>;
                    object src;
                    if (m != null && m.TryGetValue("src", out src)) _mouthSrc = Str(src);
                }
                object fs;
                if (d.TryGetValue("faces", out fs))
                {
                    var faces = fs as Dictionary<string, object>;
                    if (faces != null)
                        foreach (var kv in faces)
                        {
                            var f = kv.Value as Dictionary<string, object>;
                            if (f == null) continue;
                            object b;
                            string baseName = f.TryGetValue("base", out b) ? Str(b) : null;
                            if (string.IsNullOrEmpty(baseName)) continue;
                            _faceBase[kv.Key] = baseName;
                            var ovs = new List<KeyValuePair<string, string>>();
                            object ov;
                            if (f.TryGetValue("overlay", out ov))
                            {
                                var arr = ov as object[];
                                if (arr != null)
                                    foreach (var o in arr)
                                    {
                                        var od = o as Dictionary<string, object>;
                                        object s2;
                                        if (od != null && od.TryGetValue("src", out s2) && !string.IsNullOrEmpty(Str(s2)))
                                            ovs.Add(new KeyValuePair<string, string>(Str(s2), ""));
                                    }
                            }
                            _faceOverlay[kv.Key] = ovs;
                        }
                }
                Log("faces.json ok: faces=" + _faceBase.Count + " regions=" + _regions.Count +
                    " mouth=" + (_mouthSrc ?? "-") + " canvas=" + _canvasW + "x" + _canvasH);
            }
            catch (Exception ex) { Log("faces.json 解析失败：" + ex.Message); }
        }

        static string FaceName(int i)
        {
            switch (i)
            {
                case 1: return "happy";
                case 2: return "sad";
                case 3: return "surprise";
                case 4: return "sleepy";
                case 5: return "think";
                default: return "normal";
            }
        }

        /// <summary>按 faces.json 拼层；缺图逐层跳过，最后兜底到 surface{i}.png</summary>
        void ApplyFaceLayers(int face)
        {
            // 先清掉上一次的覆盖层
            foreach (var img in _overlayImgs) _art.Children.Remove(img);
            _overlayImgs.Clear();

            string name = FaceName(face);
            string baseName;
            if (!_faceBase.TryGetValue(name, out baseName))
            {
                // manifest 没登记这个表情：退回整图模式
                ImageSource fb = FaceImage(face);
                if (fb != null && !ReferenceEquals(_sprite.Source, fb)) _sprite.Source = fb;
                return;
            }
            ImageSource bmp = LoadLayer(baseName);
            if (bmp == null)
            {
                ImageSource fb = FaceImage(face);
                if (fb != null) _sprite.Source = fb;
                return;
            }
            if (!ReferenceEquals(_sprite.Source, bmp)) _sprite.Source = bmp;

            List<KeyValuePair<string, string>> ovs;
            if (_faceOverlay.TryGetValue(name, out ovs))
                foreach (var kv in ovs)
                {
                    ImageSource o = LoadLayer(kv.Key);
                    if (o == null) continue;          // 掉了零件就少一层，不报错
                    var img = new Image
                    {
                        Source = o,
                        Stretch = Stretch.Uniform,
                        SnapsToDevicePixels = true,
                        IsHitTestVisible = false
                    };
                    _art.Children.Add(img);
                    _overlayImgs.Add(img);
                }

            // 口型层始终在最上面
            if (_mouthSrc != null)
            {
                ImageSource mi = LoadLayer(_mouthSrc);
                if (mi != null) _mouthImg.Source = mi;
            }
        }

        readonly Dictionary<string, ImageSource> _layerCache = new Dictionary<string, ImageSource>();

        ImageSource LoadLayer(string file)
        {
            if (string.IsNullOrEmpty(file)) return null;
            ImageSource hit;
            if (_layerCache.TryGetValue(file, out hit)) return hit;
            string p = Path.Combine(_root, "shell", "master", file);
            if (!File.Exists(p)) { Log("缺层：" + file); return null; }
            try
            {
                var bmp = new BitmapImage();
                bmp.BeginInit();
                bmp.CacheOption = BitmapCacheOption.OnLoad;
                bmp.UriSource = new Uri(p);
                bmp.EndInit();
                bmp.Freeze();
                _layerCache[file] = bmp;
                return bmp;
            }
            catch (Exception ex) { Log("层加载失败 " + file + "：" + ex.Message); return null; }
        }

        /// <summary>停/走口型层：以前是整张换成 talk.png，现在只是把覆盖层显隐藏</summary>
        void Mouth(bool talking)
        {
            if (_mouthImg == null) return;
            if (_mouthImg.Source == null) return;
            _mouthImg.Visibility = talking ? Visibility.Visible : Visibility.Collapsed;
        }


        void SetFace(int i)
        {
            if (i < 0 || i > 5) i = 0;
            _curFace = i;
            ApplyFaceLayers(i);
            BuildAlphaMask(i);      // 遮罩跟着当前差分走：一直拿 surface0 的轮廓，换脸后「能点的地方」和眼睛看到的就对不上
            if (_sprite.Source == null)
            {
                ImageSource img = FaceImage(i);
                if (img == null) { Log("SetFace(" + i + "): no surface path"); return; }
                _sprite.Source = img;
            }
        }

        /// <summary>缺的差分就近回退：困→不痛快，想→平静。总比全退成 normal 好。</summary>
        static int FallbackFace(int i)
        {
            if (i == 4) return 2;   // sleepy → sad
            if (i == 5) return 0;   // think  → normal
            return 0;
        }

        /// <summary>立绘解码一次就缓存：换表情不再反复读盘解码</summary>
        ImageSource FaceImage(int i)
        {
            if (i < 0 || i > 5) i = 0;
            if (_faceCache[i] != null) return _faceCache[i];
            int slot = i;
            string p = _surfaces[slot];
            if (p == null) { slot = FallbackFace(i); p = _surfaces[slot]; }   // 这套立绘缺这张
            if (p == null) { slot = 0; p = _surfaces[0]; }
            if (p == null) return null;
            if (_faceCache[slot] != null) { _faceCache[i] = _faceCache[slot]; return _faceCache[slot]; }
            try
            {
                var bmp = new BitmapImage();
                bmp.BeginInit();
                bmp.CacheOption = BitmapCacheOption.OnLoad;
                bmp.UriSource = new Uri(p);
                bmp.EndInit();
                bmp.Freeze();
                _faceCache[slot] = bmp;
                _faceCache[i] = bmp;
                return bmp;
            }
            catch (Exception ex)
            {
                Log("SetFace(" + i + ") load failed: " + ex.Message + " path=" + p);
                return null;
            }
        }

        // ================= 说话 =================
        Line[] _random;
        Line[] _click;
        Line[] _headpat;
        Line[] _dclick;
        Line[] _close;
        Line[] _lateNight;

        void BuildLines()
        {
            // 台词唯一真源是 data/talks.json（面板也读它），桌宠只是把 face 名字翻成下标
            _random = Pool("random");
            _click = Pool("click");
            _headpat = Pool("headpat");
            _dclick = Pool("doubleclick");
            _close = Pool("close");
            _lateNight = Pool("lateNight");

            if (_random == null || _random.Length == 0) _random = FallbackRandom();
            if (_click == null || _click.Length == 0)
                _click = new[]
                {
                    new Line("嗯？", 3),
                    new Line("我在。", 0),
                    new Line("要报番单吗？右键 → 番组表。", 1),
                    new Line("别戳脸。", 2)
                };
            if (_headpat == null || _headpat.Length == 0)
                _headpat = new[]
                {
                    new Line("唔……头发会乱的。", 2),
                    new Line("这样摸的话，我会记账的。", 1),
                    new Line("……再摸一下就工作。", 1),
                    new Line("好，好，我错了。", 3)
                };
            if (_dclick == null || _dclick.Length == 0)
                _dclick = new[]
                {
                    new Line("戳两下也不会多说一句的。", 2),
                    new Line("好啦好啦，我说：今天的番单在右边。", 1)
                };
        }

        /** talks.json 读不到时的兜底池（保证桌宠永远不会没话说） */
        Line[] FallbackRandom()
        {
            string nick = V("nickname", "会長");
            string wd = V("weekday_cn", "今天");
            int count = I("count");
            int behind = I("behind_count");
            var rnd = new List<Line>();
            rnd.Add(new Line("今天的番单我排好了，要不要看一眼？", 1));
            rnd.Add(new Line("追番不是任务，是给明天留个期待。", 1));
            rnd.Add(new Line(nick + "，喝水了吗？看番之前先喝水。", 1));
            rnd.Add(new Line("我把放送时间都换成北京时间了。", 0));
            rnd.Add(new Line("这一季的新番，你打算开几个坑？", 3));
            rnd.Add(new Line("要是忘了看到第几集，问我。", 0));
            rnd.Add(new Line("我不催你，我只提醒。", 0));
            if (behind > 0) rnd.Add(new Line("有 " + behind + " 部落后了。要现在补吗？", 3));
            if (count > 0) rnd.Add(new Line(wd + "有 " + count + " 部。到点了我会说。", 1));
            return rnd.ToArray();
        }

        /** 把 talks.json 的一池读成 Line[]；没有这一池返回 null */
        /// <summary>JavaScriptSerializer 把 JSON 数组解成 ArrayList，也偶尔是 object[]——统一成 List。</summary>
        static List<object> AsList(object v)
        {
            if (v == null) return null;
            var arr = v as object[];
            if (arr != null) return new List<object>(arr);
            var en = v as IEnumerable;
            if (en == null || v is string) return null;
            var list = new List<object>();
            foreach (object o in en) list.Add(o);
            return list;
        }

        Line[] Pool(string key)
        {
            object raw;
            if (!_talks.TryGetValue(key, out raw)) return null;
            IEnumerable arr = raw as IEnumerable;
            if (arr == null || raw is string) return null;
            var list = new List<Line>();
            foreach (object it in arr)
            {
                Dictionary<string, object> d = it as Dictionary<string, object>;
                if (d == null) continue;
                string text = FillStatic(Tpl(d, "text"));
                if (text.Length == 0) continue;
                list.Add(new Line(text, FaceIndex(Tpl(d, "face"))));
            }
            return list.Count > 0 ? list.ToArray() : null;
        }

        static string Tpl(Dictionary<string, object> d, string k)
        {
            object v;
            return d.TryGetValue(k, out v) && v != null ? Convert.ToString(v, CultureInfo.InvariantCulture) : "";
        }

        /** 文件级占位符：这些一天只变一次，BuildLines 时缓存没问题 */
        string FillStatic(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Replace("{nickname}", V("nickname", "会長"))
                    .Replace("{weekday}", V("weekday_cn", "今天"))
                    .Replace("{count}", V("count", "0"))
                    .Replace("{summary}", V("summary", ""))
                    .Replace("{quote}", V("quote", ""));
        }

        /** 通用占位符。用户态变量（好感/次数/心情）必须每次说话现取，否则「第 N 次」永远停在启动那一刻。 */
        string Fill(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            s = FillStatic(s);
            if (s.IndexOf('{') < 0) return s;
            // 用户态变量（{nade_today} / {affinity} / {behind_count} …）直接按 vars 替换
            s = s.Replace("{nade_today}", UI("nade_today").ToString())
                 .Replace("{nade_total}", UI("nade_total").ToString())
                 .Replace("{affinity}", UI("affinity").ToString())
                 .Replace("{poke_total}", UI("poke_total").ToString())
                 .Replace("{hour}", DateTime.Now.Hour.ToString())
                 .Replace("{imagination}", UI("imagination").ToString())
                 .Replace("{fluster}", UI("fluster").ToString())
                 .Replace("{nosebleed_total}", UI("nosebleed_total").ToString())
                 .Replace("{mood}", Mood())
                 .Replace("{hug_total}", UI("hug_total").ToString())
                 .Replace("{behind_count}", V("behind_count", "0"));
            return s;
        }

        static string FillCtx(string s, Dictionary<string, string> ctx)
        {
            if (string.IsNullOrEmpty(s)) return "";
            if (ctx != null)
            {
                foreach (KeyValuePair<string, string> kv in ctx)
                    s = s.Replace("{" + kv.Key + "}", kv.Value ?? "");
            }
            return s;
        }

        /** 从某池挑一句，池空就用兜底句；ctx 用来填 {name_cn}/{behind} 这类 */
        Line PickFrom(string key, Dictionary<string, string> ctx, int face, string fallback)
        {
            Line[] pool = Pool(key);
            if (pool != null && pool.Length > 0)
            {
                Line l = pool[_rnd.Next(pool.Length)];
                return new Line(FillCtx(l.Text, ctx), l.Face);
            }
            return new Line(FillCtx(fallback, ctx), face);
        }

        /// <summary>同一条台词别连着说两遍（深夜池只有两条，闲话 45-90s 一句时会非常明显）</summary>
        Line? PickNoRepeat(Line[] pool)
        {
            if (pool == null || pool.Length == 0) return null;
            Line pick = pool[_rnd.Next(pool.Length)];
            for (int i = 0; i < 4 && pool.Length > 1 && Fill(pick.Text ?? "") == _lastSpoken; i++)
                pick = pool[_rnd.Next(pool.Length)];
            return pick;
        }

        Line PickRandom()
        {
            BuildLinesIfNeeded();
            Line rule;
            if (TryPickRule(out rule)) return rule;
            int h = DateTime.Now.Hour;
            Line? picked = null;
            if (h >= 1 && h < 5 && _rnd.Next(2) == 0) picked = PickNoRepeat(_lateNight);
            if (!picked.HasValue) picked = PickNoRepeat(_random);
            return picked.HasValue ? picked.Value : new Line("……", 0);
        }

        // ================= 分区命中 / 摸头递进 =================
        /// <summary>屏幕点 → 立绘坐标 → 区域名（faces.json 的 regions；没配就退回「上部 26% = 头」）</summary>
        string RegionAt(Point p)
        {
            double w = _sprite.ActualWidth, h = _sprite.ActualHeight;
            if (w <= 0 || h <= 0) return "body";
            // 点在立绘之外（缩放后窗口比立绘宽的那些边角）：别按「身体」算，那是误判
            if (p.X < 0 || p.Y < 0 || p.X > w || p.Y > h) return "none";
            double cx = p.X / w * _canvasW;
            double cy = p.Y / h * _canvasH;
            // 脸在头里面，先判脸
            foreach (string key in new[] { "face", "head", "body" })
            {
                Rect r;
                if (!_regions.TryGetValue(key, out r)) continue;
                if (cx >= r.X && cx <= r.X + r.Width && cy >= r.Y && cy <= r.Y + r.Height) return key;
            }
            if (_regions.Count > 0) return "body";
            return cy < _canvasH * 0.26 ? "head" : "body";
        }

        /// <summary>
        /// 摸头：800 ms 冷却，按「今天第几次」递进念台词（对应 TalkSakuraHeadPat.%(count) 的写法），
        /// 池子念完了就随机；次数与好感写进 state.json 的 vars。
        /// </summary>
        /// <summary>随机挑一句，尽量别和刚说过的那句撞（撞了最多重掷三次）。</summary>
        Line Reroll(Line[] pool, string last)
        {
            if (pool == null || pool.Length == 0) return new Line("嗯。", 0);
            Line pick = pool[_rnd.Next(pool.Length)];
            for (int k = 0; k < 3 && pool.Length > 1 && pick.Text == last; k++)
                pick = pool[_rnd.Next(pool.Length)];
            return pick;
        }

        void NadeSay()
        {
            if ((DateTime.Now - _lastNade).TotalMilliseconds < 800) { Log("nade 冷却中，忽略"); return; }
            _lastNade = DateTime.Now;
            Touch();
            int today = UI("nade_today") + 1;
            SetU("nade_today", today.ToString());
            SetU("nade_total", (UI("nade_total") + 1).ToString());
            int aff = Math.Min(100, UI("affinity") + 1);
            SetU("affinity", aff.ToString());
            SaveState();

            Line[] pool = Pool("nade");
            bool has = false;
            Line pick = new Line("嗯。", 0);
            if (pool != null && pool.Length > 0)
            {
                int idx = today - 1;
                pick = idx < pool.Length ? pool[idx] : Reroll(pool, _lastSpoken);
                has = true;
                if (idx >= pool.Length) Log("摸头第 " + today + " 次，进入随机");
            }
            if (!has && _headpat != null && _headpat.Length > 0) { pick = _headpat[_rnd.Next(_headpat.Length)]; has = true; }
            Tickle("nade");
            if (CheckNosebleed()) { Hop(); Log("nade today=" + today + " → 鼻血"); return; }
            Say(pick, true);
            Hop();
            Log("nade today=" + today + " total=" + UI("nade_total") + " affinity=" + aff);
        }

        /// <summary>双击＝抱一下。亲密度涨得比摸头快，偶尔会早とちり（先想歪再自己纠正）。</summary>
        void HugSay()
        {
            Touch();
            Tickle("hug");
            SetU("affinity", Math.Min(100, UI("affinity") + 3).ToString());
            SetU("hug_total", (UI("hug_total") + 1).ToString());
            SaveState();
            if (CheckNosebleed()) { Hop(); return; }

            Line[] hug = Pool("hug");
            Line pick = new Line("……唔。", 1);
            if (hug != null && hug.Length > 0) pick = hug[_rnd.Next(hug.Length)];
            else if (_dclick != null && _dclick.Length > 0) pick = _dclick[_rnd.Next(_dclick.Length)];

            // 抱到第 3 次起，会先误会一句再自己纠正（早とちり）
            if (UI("hug_total") % 3 == 0) { MisreadSay(pick); return; }

            SayWithChoices(pick,
                new Choice("再抱一下", delegate { HideChoices(); HugSay(); }),
                new Choice("够了", delegate { HideChoices(); Say(PickFrom("soft", null, 1, "……嗯。我记着。"), true); }));
            Hop();
            Log("hug total=" + UI("hug_total") + " affinity=" + UI("affinity"));
        }

        /// <summary>早とちり：先把话说歪，过一会儿自己纠正回来。</summary>
        void MisreadSay(Line first)
        {
            Say(first, true);
            var t = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2.2) };
            t.Tick += delegate
            {
                t.Stop();
                Say(PickFrom("misreadFix", null, 2, "……不。是我误会了。……抱歉。"), true);
                Log("misread corrected");
            };
            t.Start();
        }

        /// <summary>只说一句 misreadGuess，用来演示「先想歪」——同步/记满后偶尔用。</summary>
        void MisreadHint()
        {
            Line[] g = Pool("misreadGuess");
            if (g == null || g.Length == 0) return;
            SayWithChoices(g[_rnd.Next(g.Length)],
                new Choice("不是那样", delegate
                {
                    HideChoices();
                    Say(PickFrom("misreadFix", null, 0, "……是我想多了。"), true);
                }),
                new Choice("……算是吧", delegate
                {
                    HideChoices();
                    Say(PickFrom("soft", null, 1, "……那，就这样。"), true);
                    Tickle("poke");
                }));
        }

        void PokeSay()
        {
            Touch();
            Tickle("poke");
            if (CheckNosebleed()) return;
            int nextPoke = UI("poke_total") + 1;
            // 每点到整十次换一句「被夸」的反应（praise 池）——借这个节点说话，不新增计数。
            // 30 分钟只换一次：连点穿过 100/110/120 时不该一句接一句地念。
            if (nextPoke >= 10 && nextPoke % 10 == 0 && Pool("praise") != null && Cooled("say_praise", 30))
            {
                MarkCool("say_praise");
                SetU("poke_total", nextPoke.ToString());
                Say(PickPool("praise", null, 1, "……被夸了。……再、再说一次？"), true);
                SaveState();
                return;
            }
            Line[] pool = Pool("poke");
            Line pick = new Line("嗯？", 3);
            if (pool != null && pool.Length > 0) pick = pool[_rnd.Next(pool.Length)];
            else if (_click != null && _click.Length > 0) pick = _click[_rnd.Next(_click.Length)];
            Say(pick, true);
            SetU("poke_total", nextPoke.ToString());
            SaveState();
        }

        // ================= 人格变量：妄想 / 慌张 / 鼻血 =================
        //
        // 这三条不是计数器，是「她什么时候绷不住」的阈值系统：
        //   imagination（妄想）摸头 +2、点脸 +2、深夜再加 1；每分钟 -1，跨日不清
        //   fluster（慌张）  点脸 +3、被摸头 +1、连点加重；每分钟 -4，掉得比妄想快
        //   两个都到线（60 / 40）→ 喷一次鼻血，各扣 30，10 分钟内不重复
        // mood 是派生值，规则引擎的 when.mood 直接读它。

        /// <summary>心情：给规则引擎与菜单文案用，不单独持久化</summary>
        string Mood()
        {
            if (UI("fluster") >= 40) return "flustered";
            if (UI("imagination") >= 60) return "dreamy";
            return "calm";
        }

        void Tickle(string kind)
        {
            int img = UI("imagination");
            int flu = UI("fluster");
            if (kind == "nade") { img += 2; flu += 1; }
            else if (kind == "poke") { img += 2; flu += 3; }
            else if (kind == "hug") { img += 3; flu += 2; }   // 抱一下比摸头更让她慌
            else { img += 1; }

            // 深夜加成：22 点以后同样一下，她想得更多
            int h = DateTime.Now.Hour;
            if (h >= 22 || h <= 3) img += 1;

            SetU("imagination", Math.Min(100, img).ToString());
            SetU("fluster", Math.Min(100, flu).ToString());
            _mood = Mood();
            Log("persona " + kind + " imagination=" + UI("imagination") + " fluster=" + UI("fluster") + " mood=" + _mood);
            SaveState();
            QueueHighSay();     // 越线就 2.6 秒后补一句（imaginationHigh / flusterHigh）
        }

        /// <summary>每分钟衰减一次（妄想慢、慌张快）</summary>
        void DecayPersona()
        {
            double sec = (DateTime.Now - _lastPersonaDecay).TotalSeconds;
            if (sec < 60) return;
            _lastPersonaDecay = DateTime.Now;
            int img = Math.Max(0, UI("imagination") - 1);
            int flu = Math.Max(0, UI("fluster") - 4);
            if (img != UI("imagination")) SetU("imagination", img.ToString());
            if (flu != UI("fluster")) SetU("fluster", flu.ToString());
            _mood = Mood();
        }

        /// <summary>到线就说一次鼻血（返回 true 表示这次说了，调用方别再叠别的话）</summary>
        bool CheckNosebleed()
        {
            if (UI("imagination") < 60 || UI("fluster") < 40) return false;
            if ((DateTime.Now - _lastNosebleed).TotalMinutes < 10) return false;
            _lastNosebleed = DateTime.Now;
            SetU("imagination", Math.Max(0, UI("imagination") - 30).ToString());
            SetU("fluster", Math.Max(0, UI("fluster") - 30).ToString());
            SetU("nosebleed_total", (UI("nosebleed_total") + 1).ToString());
            _mood = Mood();
            Say(PickFrom("nosebleed", null, 3, "……鼻、鼻血が。……ティッシュを。"), true);
            Log("nosebleed #" + UI("nosebleed_total") + " imagination=" + UI("imagination") + " fluster=" + UI("fluster"));
            SaveState();
            return true;
        }

        /// <summary>菜单打开：先说一句她对这个人的态度（不影响操作，说完菜单照样能点）</summary>
        void SayMenuOpen()
        {
            if (CheckNosebleed()) return;
            if ((DateTime.Now - _lastMenuSay).TotalSeconds < 20) return;
            _lastMenuSay = DateTime.Now;
            var ctx = new Dictionary<string, string>();
            ctx["count"] = V("count", "0");
            ctx["pending"] = V("behind_count", "0");
            Say(PickFrom("menuOpen", ctx, 0, "案件簿，在这里。"), true);
            // 待看数 > 0 时再补一句 pending：迟 2.6 秒说，免得跟上面那句互顶；10 分钟一次
            int pending = I("behind_count");
            if (pending > 0 && Cooled("say_pending", 10))
                DelaySay("pending", 0, "欠着 " + pending + " 部。", "say_pending", 10,
                    delegate { return I("behind_count") > 0; });
        }

        DateTime _lastMenuSay = DateTime.MinValue;
        DateTime _lastPanelSay = DateTime.MinValue;

        /// <summary>记完一话之后的反应：先看是否连点，再看是否清空积压</summary>
        void AfterBump(string name, int seen, int total)
        {
            DateTime now = DateTime.Now;
            _bumpTimes.Add(now);
            _bumpTimes.RemoveAll((t) => (now - t).TotalSeconds > 60);
            int recent = _bumpTimes.Count;

            if (total > 0 && seen >= total)
            {
                var c1 = new Dictionary<string, string>();
                c1["name_cn"] = name ?? "";
                Say(PickFrom("catchupFull", c1, 1, "这一部，看完了。……记录我改了。"), true);
                // 看完一部之后偶尔会想歪：以为你要走了
                if (_rnd.Next(2) == 0)
                {
                    var t = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2.4) };
                    t.Tick += delegate { t.Stop(); MisreadHint(); };
                    t.Start();
                }
                return;
            }
            if (recent >= 3)
            {
                // 连点 + 还有积压：这时候说 worry（「是不是太累了」）比催她更贴题；
                // 30 分钟内只换这一次，之后就回到 bumpRapid 的吐槽。
                if (I("behind_count") > 0 && Cooled("say_worry", 30))
                {
                    MarkCool("say_worry");
                    Say(PickPool("worry", null, 3, "……是不是太累了。今天到此为止，我批准。"), true);
                    Tickle("bump");
                    return;
                }
                var c2 = new Dictionary<string, string>();
                c2["bump_recent"] = recent.ToString();
                Say(PickFrom("bumpRapid", c2, 3, "……一口气 " + recent + " 件？手速倒是很快。"), true);
                Tickle("bump");
                return;
            }
            var ctx = new Dictionary<string, string>();
            ctx["name_cn"] = name ?? "";
            ctx["seen"] = seen.ToString();
            ctx["total"] = total.ToString();
            Line l = PickFrom("bump", ctx, 0, (name ?? "这部") + "记到 " + seen + "/" + total + " 了。");
            Say(new Line(FillCtx(l.Text, ctx), l.Face), true);
        }

        /// <summary>静置太久：她自己找话说一句（20 分钟一次）</summary>
        void MaybeIdleSay()
        {
            // 5 分钟没被碰过就说一句 idleLong；同一句话至少要隔 15 分钟
            // （原来是 20/20，配上「说话也算活动」的老逻辑等于永远不会触发）
            if ((DateTime.Now - _lastTouch).TotalMinutes < 5) return;
            if ((DateTime.Now - _lastIdleSay).TotalMinutes < 15) return;
            _lastIdleSay = DateTime.Now;
            if (TryGoodnight()) return;       // 23 点后的那句闲话让给「晚安」（一天只一次）
            if (CheckNosebleed()) return;
            Say(PickFrom("idleLong", null, 0, "……还在吗。记录簿，我放着。"), true);
        }

        // ================= 池子接线：冷却 / 一天一次 / 迟一拍补话 =================
        //
        // talks.json 里有九个池写好了却没人调（praise / worry / goodnight / selfIntro / wheel /
        // catchup / imaginationHigh / flusterHigh / pending）。这里统一给它们找落点：
        //   · 所有状态都写进 vars（idle_/say_ 前缀），靠已有的 SaveState 落盘，不新增文件；
        //   · 台词一律走 PickFrom + Fill，不另写替换逻辑；
        //   · 每次放话都记一行 "say pool=<名字>"，真机验收直接 grep pet.log。

        static string TodayTag() { return DateTime.Now.ToString("yyyy-MM-dd"); }

        /// <summary>「一天一次」：今天还没记过 → true（真正说过再调用 MarkDay 落账）</summary>
        bool DayFree(string key) { return UV(key, "") != TodayTag(); }
        void MarkDay(string key) { SetU(key, TodayTag()); }

        /// <summary>分钟级冷却：没记过 / 记过但已超时 → true</summary>
        bool Cooled(string key, double minutes)
        {
            string s = UV(key, "");
            if (string.IsNullOrEmpty(s)) return true;
            DateTime t;
            if (!DateTime.TryParseExact(s, "yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture,
                    DateTimeStyles.None, out t)) return true;
            return (DateTime.Now - t).TotalMinutes >= minutes;
        }
        void MarkCool(string key) { SetU(key, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss")); }

        /// <summary>取一句池子台词并记日志；池子为空就记 MISSING 并退回兜底句</summary>
        Line PickPool(string pool, Dictionary<string, string> ctx, int face, string fallback)
        {
            Line[] p = Pool(pool);
            Log((p != null && p.Length > 0 ? "say pool=" : "say pool=MISSING ") + pool);
            return PickFrom(pool, ctx, face, fallback);
        }

        /// <summary>
        /// 迟一拍补一句：交互台词正在逐字打，立刻再说一句会把它顶掉，
        /// 所以等 2.6 秒（打完）再补；时间到了再复核一次阈值/冷却，免得状况已经过去了还在说。
        /// </summary>
        void DelaySay(string pool, int face, string fallback, string cdKey, double cdMinutes,
            Func<bool> stillWanted)
        {
            var t = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(2600) };
            t.Tick += delegate
            {
                t.Stop();
                if (stillWanted != null && !stillWanted()) return;
                if (!string.IsNullOrEmpty(cdKey))
                {
                    if (!Cooled(cdKey, cdMinutes)) return;
                    MarkCool(cdKey);
                }
                Say(PickPool(pool, null, face, fallback), true);
                SaveState();
            };
            t.Start();
        }

        /// <summary>妄想/慌张越过高位线（口径同 Mood 与 CheckNosebleed：60 / 40）时补一句</summary>
        void QueueHighSay()
        {
            if (UI("imagination") >= 60)
                DelaySay("imaginationHigh", 4, "……咳。刚才那个画面，是业务需要才想的。",
                    "say_img_high", 30, delegate { return UI("imagination") >= 60; });
            else if (UI("fluster") >= 40)
                DelaySay("flusterHigh", 4, "……别、别一直点。我记不住。",
                    "say_flus_high", 30, delegate { return UI("fluster") >= 40; });
        }

        /// <summary>
        /// 23 点后的「晚安」：只给安静的时间点（收尾/静置），不抢点击反馈——
        /// 点她本来就有摸头/点脸那几句，硬塞会变成一句话顶一句话。
        /// 返回 true 表示这次已经说了，调用方别再说自己的台词。
        /// </summary>
        bool TryGoodnight()
        {
            if (DateTime.Now.Hour < 23) return false;
            if (!DayFree("say_goodnight")) return false;
            if (Pool("goodnight") == null) return false;
            MarkDay("say_goodnight");
            Say(PickPool("goodnight", null, 0, "晚安。……明天也，一起。"), true);
            SaveState();
            return true;
        }

        // ================= 整点 / 生日 =================
        string SettingValue(string key)
        {
            try
            {
                string sp = Path.Combine(_root, "data", "settings.json");
                if (!File.Exists(sp)) return "";
                var ser = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };
                var d = ser.Deserialize<Dictionary<string, object>>(File.ReadAllText(sp, Encoding.UTF8));
                object v;
                if (d != null && d.TryGetValue(key, out v)) return Str(v);
            }
            catch { }
            return "";
        }

        /// <summary>整点：凌晨 0–7 点不吵人（生日例外）。台词在 talks.hourly。</summary>
        void HourlySay()
        {
            int h = DateTime.Now.Hour;
            bool bday = IsBirthdayToday();
            if (h >= 1 && h <= 7 && !bday) { Log("整点 " + h + " 点：免打扰"); return; }
            if (bday && !_birthdaySaid)
            {
                _birthdaySaid = true;
                Line b = PickFrom("birthday", null, 1, "今天我生日。你能记得，我很高兴。");
                Say(b, true);
                return;
            }

            // 分时段：早上 / 午后 / 傍晚 / 深夜各有自己的语气，其余整点走 hourly
            string slot = null;
            if (h >= 6 && h <= 9) slot = "morning";
            else if (h >= 12 && h <= 14) slot = "noon";
            else if (h >= 17 && h <= 19) slot = "evening";
            else if (h >= 22 || h <= 3) slot = "night";
            if (slot != null)
            {
                Line[] sp = Pool(slot);
                if (sp != null && sp.Length > 0)
                {
                    var sc = new Dictionary<string, string>();
                    sc["hour"] = h.ToString();
                    Line sl = sp[_rnd.Next(sp.Length)];
                    Say(new Line(FillCtx(sl.Text, sc), sl.Face), true);
                    Log("整点问候 slot=" + slot + " hour=" + h);
                    return;
                }
            }

            Line[] pool = Pool("hourly");
            if (pool == null || pool.Length == 0) return;
            var ctx = new Dictionary<string, string>();
            ctx["hour"] = h.ToString();
            Line l = pool[_rnd.Next(pool.Length)];
            Say(new Line(FillCtx(l.Text, ctx), l.Face), true);
        }

        bool _birthdaySaid;

        bool IsBirthdayToday()
        {
            string b = SettingValue("birthday");
            if (string.IsNullOrEmpty(b)) return false;
            string today = DateTime.Now.ToString("MM-dd");
            return b == today || b == DateTime.Now.ToString("yyyy-MM-dd");
        }

        // ================= 轻量规则引擎 =================
        // talks.rules: [{ "when": {"hour_min":22,"hour_max":1,"weekday":[5],"behind_min":1,"nade_min":3}, "text":"…", "face":"sad" }]
        // 命中即优先于随机池；同一条 15 分钟内不重复。
        readonly Dictionary<string, DateTime> _ruleAt = new Dictionary<string, DateTime>();

        bool TryPickRule(out Line result)
        {
            result = new Line("", 0);
            object raw;
            if (!_talks.TryGetValue("rules", out raw)) return false;
            var arr = raw as object[];
            if (arr == null) return false;
            DateTime now = DateTime.Now;
            for (int i = 0; i < arr.Length; i++)
            {
                var r = arr[i] as Dictionary<string, object>;
                if (r == null) continue;
                object txt;
                if (!r.TryGetValue("text", out txt) || string.IsNullOrEmpty(Str(txt))) continue;
                object wh;
                r.TryGetValue("when", out wh);
                var when = wh as Dictionary<string, object>;
                if (!WhenMatches(when)) continue;
                string key = i + "|" + Str(txt);
                DateTime last;
                if (_ruleAt.TryGetValue(key, out last) && (now - last).TotalMinutes < 15) continue;
                _ruleAt[key] = now;
                object fc;
                string face = r.TryGetValue("face", out fc) ? Str(fc) : "normal";
                Log("命中规则 #" + i + " " + Str(txt));
                result = new Line(Fill(Str(txt)), FaceIndex(face));
                return true;
            }
            return false;
        }

        bool WhenMatches(Dictionary<string, object> w)
        {
            if (w == null) return true;
            int h = DateTime.Now.Hour;
            int dow = (int)DateTime.Now.DayOfWeek;          // 0=周日
            int wd = dow == 0 ? 7 : dow;                     // 1=周一 … 7=周日
            object v;
            if (w.TryGetValue("hour_min", out v)) { int lo; if (int.TryParse(Str(v), out lo) && h < lo) return false; }
            if (w.TryGetValue("hour_max", out v)) { int hi; if (int.TryParse(Str(v), out hi) && h > hi) return false; }
            if (w.TryGetValue("weekday", out v))
            {
                var arr = v as object[];
                if (arr != null && arr.Length > 0)
                {
                    bool hit = false;
                    foreach (var o in arr) { int d; if (int.TryParse(Str(o), out d) && d == wd) hit = true; }
                    if (!hit) return false;
                }
            }
            if (w.TryGetValue("behind_min", out v)) { int n; if (int.TryParse(Str(v), out n) && I("behind_count") < n) return false; }
            if (w.TryGetValue("count_min", out v)) { int n; if (int.TryParse(Str(v), out n) && I("count") < n) return false; }
            if (w.TryGetValue("nade_min", out v)) { int n; if (int.TryParse(Str(v), out n) && UI("nade_total") < n) return false; }
            if (w.TryGetValue("affinity_min", out v)) { int n; if (int.TryParse(Str(v), out n) && UI("affinity") < n) return false; }
            if (w.TryGetValue("imagination_min", out v)) { int n; if (int.TryParse(Str(v), out n) && UI("imagination") < n) return false; }
            if (w.TryGetValue("fluster_min", out v)) { int n; if (int.TryParse(Str(v), out n) && UI("fluster") < n) return false; }
            if (w.TryGetValue("mood", out v))
            {
                // mood 是派生值（Mood() 现算），不从 _user 里读——早先那版读了一个永远空着的键
                string want = Str(v);
                if (!string.IsNullOrEmpty(want) && want != Mood()) return false;
            }
            return true;
        }

        // ================= 用户态变量（state.json 的 vars）=================
        string UV(string k, string dflt)
        {
            string v;
            return _user.TryGetValue(k, out v) && !string.IsNullOrEmpty(v) ? v : dflt;
        }

        int UI(string k)
        {
            int n;
            return int.TryParse(UV(k, "0"), out n) ? n : 0;
        }

        void SetU(string k, string v) { _user[k] = v; }

        /// <summary>跨日：今日计数清零（总量与好感留着）</summary>
        void ResetDailyVars()
        {
            string today = DateTime.Now.ToString("yyyy-MM-dd");
            string had = UV("v_date", "");
            if (had == today) return;
            SetU("v_date", today);
            SetU("nade_today", "0");
            SetU("poke_today", "0");
            Log("跨日重置今日互动（上次 " + had + "）");
        }

        void SayBoot()
        {
            string nick = V("nickname", "会長");
            string wd = V("weekday_cn", "今天");
            int count = I("count");
            string summary = V("summary", "");
            string date = V("date", "");

            var ctx = new Dictionary<string, string>();
            ctx["nickname"] = nick;
            ctx["weekday"] = wd;
            ctx["date"] = date;
            ctx["count"] = count.ToString();
            ctx["summary"] = summary;
            ctx["weekday_cn"] = wd;

            var seq = new List<Line>();
            bool everBefore = _lastBootDate.Length > 0;
            seq.Add(PickFrom(everBefore ? "boot" : "firstBoot", ctx, 0,
                everBefore ? "番组管家，TIARA。今天也把该看的番排好队了。" : "初次见面。我是TIARA，替你记住每一部番什么时候播。"));

            // 第一次运行补一句自介（selfIntro 池）。用 _lastBootDate 判「从没启动过」，
            // 而不是 first_seen：后者是 CheckMilestone 在开机时才补写的，判首次会晚一步。
            if (!everBefore && Pool("selfIntro") != null)
                seq.Add(PickPool("selfIntro", ctx, 0, "副会长，TIARA。你的观看记录，我保管着。"));

            if (count > 0)
            {
                var names = new List<string>();
                for (int i = 1; i <= count; i++)
                {
                    string n = V("show" + i + "_name", "");
                    if (n.Length > 0) names.Add(n);
                }
                ctx["names"] = string.Join("、", names.ToArray());
                seq.Add(PickFrom("todayHas", ctx, 1, wd + "有 " + count + " 部：" + ctx["names"] + "。"));
            }
            else
            {
                seq.Add(PickFrom("todayEmpty", ctx, 4, summary.Length > 0 ? summary : wd + "没有要追的番。"));
            }

            int behind = I("behind_count");
            if (behind > 0)
            {
                string bn = V("behind1_name", "");
                ctx["behind"] = behind.ToString();
                ctx["name_cn"] = bn;
                seq.Add(PickFrom("todayBehind", ctx, 3,
                    "落后 " + behind + " 部没补" + (bn.Length > 0 ? "，" + bn + " 差得最多" : "") + "。"));
            }

            // 积压 ≥2 部、今天还没念过 → 补一句 catchup（「未处理 N 部」那种正餐）。
            // 跟 catchupFull 是两个端点：那个是「正好全部补完」，这个是「堆着还没动」。
            if (behind >= 2 && DayFree("say_catchup") && Pool("catchup") != null)
            {
                MarkDay("say_catchup");
                seq.Add(PickPool("catchup", ctx, 3, "未处理 " + behind + " 部。……移开视线也不会消失。"));
            }

            string nextName = V("next_name", "");
            if (nextName.Length > 0)
            {
                ctx["name_cn"] = nextName;
                ctx["time_cst"] = V("next_time", "--:--");
                seq.Add(PickFrom("todayNext", ctx, 1,
                    "接下来是 " + nextName + "，" + V("next_time", "--:--") + "。"));
            }

            _lastBootDate = date;
            SaveState();
            RunSequence(seq, 0);
        }

        // ---------- 开口序列：可被用户点击打断 ----------
        List<Line> _seq;
        int _seqAt;

        void RunSequence(List<Line> seq, int i)
        {
            _seq = seq;
            _seqAt = i;
            StepSequence();
        }

        void StepSequence()
        {
            if (_seq == null || _seqAt >= _seq.Count) { _seq = null; return; }
            Say(_seq[_seqAt], false);
            _seqAt++;
            if (_seq != null && _seqAt < _seq.Count)
            {
                if (_seqTimer == null)
                {
                    _seqTimer = new DispatcherTimer();
                    _seqTimer.Tick += delegate { _seqTimer.Stop(); StepSequence(); };
                }
                _seqTimer.Interval = TimeSpan.FromMilliseconds(Math.Max(2600, 1400 + _seq[_seqAt - 1].Text.Length * 90));
                _seqTimer.Stop();
                _seqTimer.Start();
            }
        }

        void CancelSequence()
        {
            _seq = null;
            if (_seqTimer != null) _seqTimer.Stop();
        }

        void SayRandom()
        {
            Say(PickRandom(), true);
        }

        /// <summary>气泡里的一颗按钮（= 伪春菜的 OnChoiceSelect 选项）</summary>
        sealed class Choice
        {
            public string Label;
            public Action Fn;
            public Choice(string label, Action fn) { Label = label; Fn = fn; }
        }

        Button BubbleButton(string label, string accessibleName, bool compact)
        {
            var border = new FrameworkElementFactory(typeof(Border));
            border.SetValue(Border.CornerRadiusProperty, new CornerRadius(compact ? 6 : 8));
            border.SetValue(Border.BackgroundProperty, new TemplateBindingExtension(Control.BackgroundProperty));
            border.SetValue(Border.BorderBrushProperty, new TemplateBindingExtension(Control.BorderBrushProperty));
            border.SetValue(Border.BorderThicknessProperty, new TemplateBindingExtension(Control.BorderThicknessProperty));
            border.SetValue(Border.PaddingProperty, new TemplateBindingExtension(Control.PaddingProperty));
            var presenter = new FrameworkElementFactory(typeof(ContentPresenter));
            presenter.SetValue(FrameworkElement.HorizontalAlignmentProperty, HorizontalAlignment.Center);
            presenter.SetValue(FrameworkElement.VerticalAlignmentProperty, VerticalAlignment.Center);
            border.AppendChild(presenter);
            var button = new Button
            {
                Content = label, Cursor = Cursors.Hand, Foreground = BubbleAccent,
                FontFamily = new FontFamily("Microsoft YaHei UI, Segoe UI"), FontSize = compact ? 14 : 12,
                MinWidth = compact ? 26 : 40, MinHeight = compact ? 25 : 29,
                Background = compact ? Brushes.Transparent : BubbleButtonFill,
                BorderBrush = compact ? Brushes.Transparent : BubbleLine,
                BorderThickness = new Thickness(1), Padding = new Thickness(compact ? 4 : 8, 2, compact ? 4 : 8, 2),
                Template = new ControlTemplate(typeof(Button)) { VisualTree = border }
            };
            var normal = button.Background;
            var line = button.BorderBrush;
            button.MouseEnter += delegate { button.Background = BubbleButtonHover; };
            button.MouseLeave += delegate { button.Background = normal; };
            button.IsKeyboardFocusedChanged += delegate { button.BorderBrush = button.IsKeyboardFocused ? BubbleAccent : line; };
            AutomationProperties.SetName(button, accessibleName);
            return button;
        }

        /// <summary>带选择肢的说法：正文和可换行的按钮各占一行。</summary>
        void SayWithChoices(Line l, params Choice[] choices)
        {
            Say(l, true);
            if (choices == null || choices.Length == 0) return;
            _choices.Children.Clear();
            foreach (var c in choices)
            {
                var pill = BubbleButton(c.Label, c.Label, false);
                pill.Margin = new Thickness(0, 3, 5, 0);
                Choice cap = c;
                pill.Click += delegate
                {
                    Log("choice picked: " + cap.Label);
                    DismissBubble();
                    if (cap.Fn != null) cap.Fn();
                };
                _choices.Children.Add(pill);
            }
            _choices.Visibility = Visibility.Visible;
            // 选择肢是挂上去之后才有高度的：重新量一次窗口，否则按钮落在窗口外，点了没反应（「卡住」就是这个）
            _bubbleHost.UpdateLayout();
            ApplyHeight(true);
            ArmBubbleHide();
            Log("choices: " + choices.Length + " 个选项 h=" + Math.Round(_bubbleHost.DesiredSize.Height));
            if (_selfTest || EnvOn("PET_SELFTEST"))
            {
                try
                {
                    var b0 = _choices.Children[0] as FrameworkElement;
                    if (b0 != null)
                    {
                        var p0 = b0.PointToScreen(new Point(0, 0));
                        var p1 = b0.PointToScreen(new Point(b0.ActualWidth, b0.ActualHeight));
                        Log("choice rect=(" + Math.Round(p0.X) + "," + Math.Round(p0.Y) + ")-(" +
                            Math.Round(p1.X) + "," + Math.Round(p1.Y) + ") win=" + Math.Round(Left) + "," +
                            Math.Round(Top) + " " + Math.Round(Width) + "x" + Math.Round(Height));
                    }
                }
                catch (Exception ex) { Log("choice rect failed " + ex.Message); }
            }
            if (DebugFlag("PET_CHOICE_SHOT"))
            {
                var shot = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(900) };
                shot.Tick += delegate
                {
                    shot.Stop();
                    try { Snapshot(Path.Combine(_root, "cache", "choice_shot.png")); }
                    catch (Exception ex) { Log("choice shot failed " + ex.Message); }
                };
                shot.Start();
            }
        }

        void HideChoices()
        {
            if (_choices == null) return;
            _choices.Children.Clear();
            _choices.Visibility = Visibility.Collapsed;
        }

        /// <summary>气泡上浮 + 淡入，八十毫秒的差别，但看着像「她开口了」而不是「字突然刷出来」。</summary>
        void ShowBubble()
        {
            if (_bubbleHost == null) return;
            _bubbleHost.Visibility = Visibility.Visible;
            _bubbleHost.BeginAnimation(OpacityProperty, null);
            _bubbleHost.Opacity = 1;
            var tt = _bubbleHost.RenderTransform as TranslateTransform;
            if (tt == null)
            {
                tt = new TranslateTransform();
                _bubbleHost.RenderTransform = tt;
            }
            tt.BeginAnimation(TranslateTransform.YProperty, null);
            tt.Y = 0;
            if (!SystemParameters.ClientAreaAnimation) return;
            var ease = new CubicEase { EasingMode = EasingMode.EaseOut };
            _bubbleHost.BeginAnimation(OpacityProperty,
                new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(150)) { EasingFunction = ease, FillBehavior = FillBehavior.Stop });
            tt.BeginAnimation(TranslateTransform.YProperty,
                new DoubleAnimation(_bubbleBelow ? -5 : 5, 0, TimeSpan.FromMilliseconds(180)) { EasingFunction = ease, FillBehavior = FillBehavior.Stop });
            Log("bubble shown rect=" + _bubbleHost.PointToScreen(new Point(0, 0)) + " size=" +
                Math.Round(_bubbleHost.ActualWidth) + "x" + Math.Round(_bubbleHost.ActualHeight) +
                " win=" + Math.Round(Left) + "," + Math.Round(Top) + " " + Math.Round(Width) + "x" + Math.Round(Height));
        }

        void HideBubble()
        {
            if (_bubbleHost == null) return;
            _bubbleHost.BeginAnimation(OpacityProperty, null);
            _bubbleHost.Visibility = Visibility.Collapsed;
            if (_bubble != null) _bubble.MinWidth = 0;      // 收起时释放钉住的宽度
            _bubbleHost.Opacity = 1;
            var tt = _bubbleHost.RenderTransform as TranslateTransform;
            if (tt != null) { tt.BeginAnimation(TranslateTransform.YProperty, null); tt.Y = 0; }
        }

        void DismissBubble()
        {
            if (_hideTimer != null) _hideTimer.Stop();
            if (_typer != null) _typer.Stop();
            HideChoices();
            HideBubble();
            Mouth(false);
            SetFace(_curFace);
            ApplyHeight(false);
        }

        void CompleteBubbleText()
        {
            if (_typer != null) _typer.Stop();
            _bubbleText.Text = _full;
            Mouth(false);
            SetFace(_curFace);
            ArmBubbleHide();
        }

        void ArmBubbleHide()
        {
            if (_hideTimer != null) _hideTimer.Stop();
            if (_bubbleHost.Visibility != Visibility.Visible || (_typer != null && _typer.IsEnabled)
                || _bubble.IsMouseOver || _bubble.IsKeyboardFocusWithin) return;
            if (_hideTimer == null)
            {
                _hideTimer = new DispatcherTimer();
                _hideTimer.Tick += delegate { DismissBubble(); };
            }
            double seconds = _choices.Visibility == Visibility.Visible ? 25 : Math.Max(6, Math.Min(20, 3 + _textElements.Length / 8.0));
            _hideTimer.Interval = TimeSpan.FromSeconds(seconds);
            _hideTimer.Start();
        }

        void Say(Line l) { Say(l, false); }

        void Say(Line l, bool userCall)
        {
            // 台词里的 {nade_today}/{affinity} 这类，池子在 BuildLines 时已经缓存过静态占位符了；
            // 用户态变量留到这一刻才填，不然「今天是第 N 次」会一直说启动时的数字。
            l.Text = Fill(l.Text ?? "");
            if (l.Text.Length == 0) l.Text = "……";
            // 这里故意不 Touch()：说话不再算「用户活动」，否则每隔 45-90 s 一句空闲台词
            // 会把 _lastTouch 一直刷新，5 分钟静置档/省电档永远进不去，idleLong 池也永远轮不到。
            if (userCall) CancelSequence();   // 被点就被点，不再按剧本念
            if (_hideTimer != null) _hideTimer.Stop();
            if (_typer != null) _typer.Stop();
            HideChoices();
            BuildLinesIfNeeded();
            SetFace(l.Face);
            Mouth(true);                                       // 打字期间显口型层
            Log("say face=" + l.Face + " " + (l.Text ?? ""));
            _lastSpoken = l.Text ?? "";
            _full = l.Text ?? "";
            _textElements = StringInfo.ParseCombiningCharacters(_full);
            _bubbleMeasure.Text = _full;
            _bubbleText.Text = "";
            _bubbleScroll.ScrollToTop();
            _bubbleHost.Visibility = Visibility.Visible;
            ApplyHeight(true);
            ShowBubble();
            if (!SystemParameters.ClientAreaAnimation) { CompleteBubbleText(); return; }
            _typed = 1;
            _bubbleText.Text = _full.Substring(0, _textElements.Length > 1 ? _textElements[1] : _full.Length);
            if (_typer == null)
            {
                _typer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(28) };
                _typer.Tick += (s, e) =>
                {
                    _typed += Math.Max(1, (int)Math.Ceiling(_textElements.Length / 120.0));
                    if (_typed >= _textElements.Length) CompleteBubbleText();
                    else _bubbleText.Text = _full.Substring(0, _textElements[_typed]);
                };
            }
            _typer.Stop();
            _typer.Start();

        }

        /// <summary>
        /// 屏幕放不下气泡时用：气泡和立绘挤在同一行里，气泡贴在行顶、压在头发上方，
        /// 窗口不再长高——立绘位置完全不动，气泡也不会跑出屏幕。
        /// </summary>
        void LayoutBubbleOverlay()
        {
            if (_uiRoot == null || _bubbleHost == null || _art == null) return;
            _bubbleBelow = false;
            _uiRoot.VerticalAlignment = VerticalAlignment.Bottom;
            _uiRoot.RowDefinitions[0].Height = new GridLength(0);
            _uiRoot.RowDefinitions[1].Height = new GridLength(ScaledH);
            Grid.SetRow(_bubbleHost, 1);
            Grid.SetRow(_art, 1);
            _bubbleHost.VerticalAlignment = VerticalAlignment.Top;
            _bubbleHost.Margin = new Thickness(0, 2, 0, 0);
            Panel.SetZIndex(_bubbleHost, 20);
            Panel.SetZIndex(_art, 10);
            ApplyBubbleShape();
            _art.Height = ScaledH;
        }

        /// <summary>气泡放在立绘上方还是下方：靠屏幕顶边时放下方，否则说话会顶出屏幕。</summary>
        void LayoutBubble(bool below)
        {
            if (_uiRoot == null || _bubbleHost == null || _art == null) return;
            _bubbleBelow = below;
            _uiRoot.RowDefinitions[0].Height = below ? new GridLength(ScaledH) : GridLength.Auto;
            _uiRoot.RowDefinitions[1].Height = below ? GridLength.Auto : new GridLength(ScaledH);
            Grid.SetRow(below ? _art : _bubbleHost, 0);
            Grid.SetRow(below ? _bubbleHost : _art, 1);
            // 立绘钉在窗口底边（气泡在上）或顶边（气泡在下）——
            // 这样窗口长高时只有气泡那一侧往外长，立绘在屏幕上纹丝不动。
            _uiRoot.VerticalAlignment = below ? VerticalAlignment.Top : VerticalAlignment.Bottom;
            _bubbleHost.VerticalAlignment = below ? VerticalAlignment.Top : VerticalAlignment.Bottom;
            _bubbleHost.Margin = below ? new Thickness(0, 8, 0, 12) : new Thickness(0, 12, 0, 8);
            Panel.SetZIndex(_bubbleHost, 20);
            Panel.SetZIndex(_art, 10);
            _bubbleBelow = below;
            ApplyBubbleShape();          // 尾巴方向/尺寸在这里统一算
            _art.Height = ScaledH;
            Log("bubble below=" + below);
        }

        /// <summary>
        /// 说话时向上长高，说完缩回。高度优先用「把气泡实测一遍」拿（含选择肢的真实高度），
        /// 正文与选择肢一起度量，长句由正文滚动区限制高度。
        /// </summary>
        void ApplyHeight(bool tall)
        {
            var wa = CurrentWorkAreaDip();
            double artTop = _bubbleBelow ? Top : Top + Height - ScaledH;
            double bottom = artTop + ScaledH;
            double h = ScaledH + 12;
            if (tall && _bubbleHost != null)
            {
                double band = 0;
                try
                {
                    _bubbleHost.Measure(new Size(Width, double.PositiveInfinity));
                    band = _bubbleHost.DesiredSize.Height;
                }
                catch { band = 0; }
                if (band < 30)
                {
                    band = Math.Min(_bubbleScroll.MaxHeight, 48) + 2 * _padY + _tailH + 44;
                }
                band = Math.Ceiling(band) + 12;
                PositionBubble();                    // 实测宽度到手，重新摆一次气泡与尾巴

                double roomAbove = artTop - wa.Top - 2;
                double roomBelow = wa.Bottom - bottom - 2;
                if (band > roomAbove && band > roomBelow)
                {
                    // 屏幕上根本没有空位（比如 200% 下立绘就占掉大半屏）：
                    // 让气泡叠在立绘上方那片空间里——宁可盖住一点头发，也不许顶走立绘、更不许出屏。
                    LayoutBubbleOverlay();
                    Height = ScaledH + 12;
                    Top = bottom - Height;
                    Log("bubble overlay band=" + Math.Round(band) + " roomAbove=" + Math.Round(roomAbove));
                    return;
                }
                if (band <= roomAbove)
                {
                    // 上方放得下：窗口往上长，立绘屏幕位置一点不动
                    LayoutBubble(false);
                    Height = ScaledH + band;
                    Top = bottom - Height;
                    return;
                }
                // 上方放不下但下方放得下：气泡翻到下方，窗口顶边不动 —— 立绘照样不动
                LayoutBubble(true);
                Height = ScaledH + band;
                Top = artTop;
                Log("bubble below (roomAbove=" + Math.Round(roomAbove) + " band=" + Math.Round(band) + ")");
                return;
            }
            if (_bubbleBelow) LayoutBubble(false);
            if (Math.Abs(h - Height) < 0.5) return;
            Height = h;
            Top = bottom - Height;
        }

        DispatcherTimer _hideTimer;

        bool _linesReady;
        void BuildLinesIfNeeded()
        {
            if (_linesReady) return;
            BuildLines();
            _linesReady = true;
        }

        void ScheduleIdleTalk()
        {
            if (_idleTalk == null)
            {
                _idleTalk = new DispatcherTimer();
                _idleTalk.Tick += (s, e) =>
                {
                    _idleTalk.Stop();
                    // 只在「真的没人动」的时候自言自语：鼠标刚碰过、正在拖、窗口在托盘里都跳过，
                    // 免得一边打字一边弹气泡（那会让静置档永远进不去）。
                    if (!_dragging && IsVisible && (DateTime.Now - _lastTouch).TotalSeconds >= 90)
                        SayRandom();
                    ScheduleIdleTalk();
                };
            }
            _idleTalk.Stop();
            _idleTalk.Interval = TimeSpan.FromMilliseconds(_rnd.Next(45000, 90000));
            _idleTalk.Start();
        }

        // ================= 番组表 =================
        void TogglePanel()
        {
            if (_popup.IsOpen) { _popup.IsOpen = false; return; }
            // 内容多了要能滚：屏幕小的时候番组表会顶出屏幕外
            _popupCard.Child = new ScrollViewer
            {
                Content = BuildPanel(),
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
                MaxHeight = Math.Max(320, CurrentWorkAreaDip().Height * 0.78),
                Background = Paper
            };
            _popup.IsOpen = true;
            Post("OnOpenPanel");
        }

        UIElement BuildPanel()
        {
            var root = new StackPanel { Background = Paper };
            var head = new Border
            {
                Background = Paper,
                BorderBrush = Ink,
                BorderThickness = new Thickness(0, 0, 0, 2),
                Padding = new Thickness(14, 10, 14, 9)
            };
            var hg = new Grid();
            hg.Children.Add(new TextBlock
            {
                Text = M("panel_title", "今日案件"),
                FontFamily = new FontFamily("Microsoft YaHei UI"),
                FontSize = 15,
                FontWeight = FontWeights.Bold,
                Foreground = Ink,
                VerticalAlignment = VerticalAlignment.Center
            });
            hg.Children.Add(new TextBlock
            {
                Text = V("weekday_cn", "") + " · " + V("date", ""),
                FontFamily = new FontFamily("Microsoft YaHei UI"),
                FontSize = 11.5,
                Foreground = InkSoft,
                HorizontalAlignment = HorizontalAlignment.Right,
                VerticalAlignment = VerticalAlignment.Center
            });
            head.Child = hg;
            root.Children.Add(head);

            int count = I("count");
            root.Children.Add(SectionLabel("今天 " + count + " 部"));
            if (count > 0)
            {
                for (int i = 1; i <= count; i++)
                {
                    string name = V("show" + i + "_name", "");
                    if (name.Length == 0) continue;
                    string eps = V("show" + i + "_eps", "");
                    int behind = 0;
                    int.TryParse(V("show" + i + "_behind", "0"), out behind);
                    root.Children.Add(Row(TimeCell(V("show" + i + "_time_disp", V("show" + i + "_time", ""))), name, eps, behind > 0 ? "落后 " + behind : "在追", V("show" + i + "_id", "")));
                }
            }
            else
            {
                root.Children.Add(Note(M("panel_empty", "今天没有案件。要不要先清一点积压？")));
            }

            // 欠着的：昨天以前该看没看的，放在「今天」和「接下来」之间——这才是每天真要做的事
            int pending = I("behind_count");
            if (pending > 0)
            {
                root.Children.Add(SectionLabel(M("panel_pending", "欠着的 " + pending + " 部")));
                for (int i = 1; i <= Math.Min(pending, 5); i++)
                {
                    string pid = V("behind" + i + "_id", "");
                    string pname = V("behind" + i + "_name", "");
                    if (pname.Length == 0) continue;
                    string pe = V("behind" + i + "_eps", "0");
                    root.Children.Add(Row("+" + pe, pname, V("behind" + i + "_watched", "") + "/" + V("behind" + i + "_expected", ""), "欠 " + pe, pid));
                }
                if (pending > 5) root.Children.Add(Note("还有 " + (pending - 5) + " 部，在网页面板里看全表。"));
            }

            // 接下来三天：只列「自己真的在追」的番（放送表里没在追的别在这儿刷屏）
            string[] cn = { "", "一", "二", "三", "四", "五", "六", "日" };
            int today = I("weekday");
            bool anyUpcoming = false;
            for (int step = 1; step <= 3; step++)
            {
                int d = ((today - 1 + step) % 7) + 1;
                int n = I("w" + d + "_count");
                if (n <= 0) continue;

                var rows = new List<UIElement>();
                int mine = 0;
                int shown = 0;
                for (int i = 1; i <= n; i++)
                {
                    if (V("w" + d + "_" + i + "_mine", "0") != "1") continue;
                    mine++;
                    if (shown >= 5) continue;
                    string name = V("w" + d + "_" + i + "_name", "");
                    if (name.Length == 0) continue;
                    string t = TimeCell(V("w" + d + "_" + i + "_time_disp", V("w" + d + "_" + i + "_time", "")));
                    rows.Add(Row(t, name, "", "在追", V("w" + d + "_" + i + "_id", "")));
                    shown++;
                }
                if (rows.Count == 0) continue;

                if (!anyUpcoming)
                {
                    root.Children.Add(SectionLabel(M("panel_next", "接下来")));
                    anyUpcoming = true;
                }
                root.Children.Add(DayBar(step == 1 ? "明天" : "周" + cn[d], mine));
                foreach (var r in rows) root.Children.Add(r);
                if (mine > shown)
                    root.Children.Add(Note("还有 " + (mine - shown) + " 部，在网页面板里看全表。"));
            }
            if (!anyUpcoming)
                root.Children.Add(Note(M("panel_empty_next", "接下来三天没有你在追的番。")));

            int ch = I("catchup_count");
            if (ch > 0)
            {
                root.Children.Add(SectionLabel("待补完 " + ch + " 部"));
                for (int i = 1; i <= ch; i++)
                {
                    string name = V("catchup" + i + "_name", "");
                    if (name.Length == 0) continue;
                    root.Children.Add(Row("补", name, "差 " + V("catchup" + i + "_eps", "?" ) + " 话", ""));
                }
            }

            string quote = V("quote", "");
            if (quote.Length > 0)
            {
                root.Children.Add(SectionLabel(M("panel_quote", "今日一句")));
                root.Children.Add(Note(quote));
            }

            var foot = new Border
            {
                Background = new SolidColorBrush(Color.FromRgb(0xF2, 0xEC, 0xE0)),
                BorderBrush = Ink,
                BorderThickness = new Thickness(0, 2, 0, 0),
                Padding = new Thickness(14, 7, 14, 8)
            };
            foot.Child = new TextBlock
            {
                Text = "纯本地 · today.txt",
                FontFamily = new FontFamily("Microsoft YaHei UI"),
                FontSize = 10.5,
                Foreground = InkSoft
            };
            root.Children.Add(foot);
            return root;
        }

        /// <summary>没写开播时刻的番给个「—」，别摆一串 --:-- 占位置。</summary>
        string TimeCell(string t)
        {
            if (string.IsNullOrEmpty(t)) return "—";
            t = t.Trim();
            return t.Length == 0 ? "—" : t;
        }

        /// <summary>自检（PET_SELFTEST=1）：把事件排队跑一遍，日志里看分区/摸头递进/选择肢/整点。</summary>
        void StartSelfTest()
        {
            _selfTest = true;      // 只读：SaveState 直接跳过，BumpShow/UndoLast/SyncBangumi 走 dry-run
            Log("selftest: READ-ONLY（不写 state.json、不调 /api/progress、/api/undo、不跑 node）");
            var t = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) };
            int step = 0;
            t.Tick += delegate
            {
                try
                {
                    step++;
                    switch (step)
                    {
                        case 1:
                            Log("selftest: 摸头第 1 次");
                            Log("selftest: 区域命中 头=" + RegionAt(new Point(_sprite.ActualWidth * 0.5, _sprite.ActualHeight * 0.15))
                                + " 脸=" + RegionAt(new Point(_sprite.ActualWidth * 0.5, _sprite.ActualHeight * 0.25))
                                + " 身=" + RegionAt(new Point(_sprite.ActualWidth * 0.5, _sprite.ActualHeight * 0.75)));
                            Post("OnMouseClickHead", null); break;
                        case 2:
                            Log("selftest: 摸头第 2 次"); Post("OnMouseClickHead", null); break;
                        case 3:
                            Log("selftest: 摸头第 3 次"); Post("OnMouseClickHead", null); break;
                        case 4:
                            Log("selftest: 点脸"); Post("OnMouseClickFace", null); break;
                        case 5:
                            Log("selftest: 提醒"); Post("OnReminderTick", null); break;
                        case 6:
                            Log("selftest: 整点"); Post("OnHourChange", null); break;
                        case 7:
                            Log("selftest: 选择肢");
                            SayWithChoices(new Line("要不要现在记一话？", 0),
                                new Choice("记一话", delegate { Log("selftest: 选了记一话"); HideChoices(); }),
                                new Choice("算了", delegate { Log("selftest: 选了算了"); HideChoices(); }));
                            break;
                        case 8:
                            object rawRules;
                            int rn = _talks.TryGetValue("rules", out rawRules) && AsList(rawRules) != null ? AsList(rawRules).Count : 0;
                            Log("selftest: 规则池 " + rn + " 条");
                            // 把人设变量顶到临界点，下一步点一下就该流鼻血（img>=60 && flu>=40）
                            SetU("imagination", "58");
                            SetU("fluster", "39");
                            Log("selftest: 变量基线 imagination=" + UI("imagination") + " fluster=" + UI("fluster") + " mood=" + Mood());
                            break;
                        case 9:
                            Log("selftest: 点脸（刚出过血的话 10 分钟冷却内不会再出）");
                            Post("OnMouseClickFace", null);
                            break;
                        case 10:
                            Log("selftest: 连点 3 次（该触发 bumpRapid）");
                            AfterBump("测试番", 5, 12);
                            AfterBump("测试番", 6, 12);
                            AfterBump("测试番", 7, 12);
                            break;
                        case 11:
                            Log("selftest: 双击抱一下（该出选择肢）");
                            HugSay();
                            break;
                        case 12:
                            Log("selftest: 早とちり（先想歪一再纠正）");
                            MisreadHint();
                            break;
                        case 13:
                            Log("selftest: 撤销一次（走 /api/undo）");
                            UndoLast();
                            break;
                        case 14:
                            Log("selftest: 同步前先问（该出选择肢）");
                            SyncBangumi();
                            break;
                        case 15:
                            Log("selftest: 纪念日（把首次见面设成 99 天前，该说第 100 天）");
                            SetU("first_seen", DateTime.Now.AddDays(-99).ToString("yyyy-MM-dd"));
                            SetU("milestone_100", "0");
                            CheckMilestone();
                            break;
                        case 16:
                            Log("selftest: 收尾 imagination=" + UI("imagination") + " fluster=" + UI("fluster")
                                + " mood=" + Mood() + " bump_recent=" + _bumpTimes.Count
                                + " hug_total=" + UI("hug_total"));
                            HideChoices();
                            t.Stop();
                            break;
                    }
                }
                catch (Exception ex) { Log("selftest step " + step + " failed: " + ex.Message); }
            };
            t.Start();
        }

        TextBlock SectionLabel(string s)
        {
            return new TextBlock
            {
                Text = s,
                FontFamily = new FontFamily("Microsoft YaHei UI"),
                FontSize = 11,
                Foreground = InkSoft,
                Margin = new Thickness(14, 12, 14, 6)
            };
        }

        /// <summary>天分隔条：左边「明天 / 周三」，右边「N 部」，下面一条细虚线。</summary>
        UIElement DayBar(string label, int n)
        {
            var g = new Grid { Margin = new Thickness(14, 8, 14, 3) };
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

            var l = new TextBlock
            {
                Text = label,
                FontFamily = new FontFamily("Microsoft YaHei UI"),
                FontSize = 11,
                FontWeight = FontWeights.Bold,
                Foreground = Ink,
                Margin = new Thickness(0, 0, 0, 3)
            };
            Grid.SetColumn(l, 0);
            g.Children.Add(l);

            var r = new TextBlock
            {
                Text = n + " 部",
                FontFamily = new FontFamily("Microsoft YaHei UI"),
                FontSize = 10.5,
                Foreground = InkSoft,
                HorizontalAlignment = HorizontalAlignment.Right,
                Margin = new Thickness(0, 0, 0, 3)
            };
            Grid.SetColumn(r, 1);
            g.Children.Add(r);

            var box = new StackPanel();
            box.Children.Add(g);
            box.Children.Add(new Border
            {
                BorderBrush = new SolidColorBrush(Color.FromRgb(0xD8, 0xCB, 0xB6)),
                BorderThickness = new Thickness(0, 0, 0, 1),
                Margin = new Thickness(14, 0, 14, 2),
                Height = 1
            });
            return box;
        }

        TextBlock Note(string s)
        {
            return new TextBlock
            {
                Text = s,
                FontFamily = new FontFamily("Microsoft YaHei UI"),
                FontSize = 12.5,
                Foreground = InkSoft,
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(14, 2, 14, 4),
                LineHeight = 20
            };
        }

        /// <summary>
        /// 一行番。给了 id 就是「可点」的：点一下记一话。
        /// 桌宠这边以前是纯展示，记账必须跑去网页——可桌宠才是每天开着的东西，
        /// 所以这里把行本身做成按钮（悬停变色 + 手型光标 + 右侧＋）。
        /// </summary>
        UIElement Row(string left, string name, string eps, string badge, string id = null)
        {
            var g = new Grid { Margin = new Thickness(14, 3, 14, 3) };
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(44) });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

            var l = new TextBlock
            {
                Text = left,
                FontFamily = new FontFamily("Consolas, Microsoft YaHei UI"),
                FontSize = 11.5,
                Foreground = InkSoft,
                VerticalAlignment = VerticalAlignment.Center
            };
            Grid.SetColumn(l, 0);
            g.Children.Add(l);

            var stack = new StackPanel();
            stack.Children.Add(new TextBlock
            {
                Text = name,
                FontFamily = new FontFamily("Microsoft YaHei UI"),
                FontSize = 13,
                Foreground = Ink,
                TextWrapping = TextWrapping.Wrap
            });
            if (eps.Length > 0)
                stack.Children.Add(new TextBlock
                {
                    Text = eps,
                    FontFamily = new FontFamily("Microsoft YaHei UI"),
                    FontSize = 10.5,
                    Foreground = InkSoft
                });
            Grid.SetColumn(stack, 1);
            g.Children.Add(stack);

            if (badge.Length > 0)
            {
                var b = new Border
                {
                    BorderBrush = Ink,
                    BorderThickness = new Thickness(1.4),
                    Padding = new Thickness(6, 1, 6, 2),
                    VerticalAlignment = VerticalAlignment.Center,
                    Margin = new Thickness(6, 0, 0, 0)
                };
                b.Child = new TextBlock
                {
                    Text = badge,
                    FontFamily = new FontFamily("Microsoft YaHei UI"),
                    FontSize = 10,
                    Foreground = badge.StartsWith("落后") ? Red : InkSoft
                };
                Grid.SetColumn(b, 2);
                g.Children.Add(b);
            }

            if (string.IsNullOrEmpty(id)) return g;

            // 可点：右侧补一个「＋」，整行都能点
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var plus = new TextBlock
            {
                Text = "＋",
                FontFamily = new FontFamily("Microsoft YaHei UI"),
                FontSize = 13,
                Foreground = InkSoft,
                Margin = new Thickness(8, 0, 0, 0),
                VerticalAlignment = VerticalAlignment.Center
            };
            Grid.SetColumn(plus, g.ColumnDefinitions.Count - 1);
            g.Children.Add(plus);

            var box = new Border { Child = g, Background = Brushes.Transparent, Cursor = Cursors.Hand };
            string showName = name;
            string showId = id;
            box.MouseEnter += delegate { box.Background = PaperWarm; plus.Foreground = Red; };
            box.MouseLeave += delegate { box.Background = Brushes.Transparent; plus.Foreground = InkSoft; };
            box.MouseLeftButtonUp += delegate
            {
                box.Background = Brushes.Transparent;
                BumpShow(showId, showName, 1);
            };
            return box;
        }

        // ================= 交互 =================
        // 单击动作延后执行：WPF 会先把双击的第一下 MouseUp 派给我们，如果当场就摸头，
        // 紧接着的第二下又抱一次，好感一次 +2/+3 +4，两句话还互相顶。等 DoubleClickTime 的大半再动手。
        DispatcherTimer _clickDelay;
        string _pendingHit;

        void QueueClick(string hit)
        {
            _pendingHit = hit;
            if (_clickDelay == null)
            {
                _clickDelay = new DispatcherTimer
                {
                    Interval = TimeSpan.FromMilliseconds(Math.Max(220, System.Windows.Forms.SystemInformation.DoubleClickTime * 0.75))
                };
                _clickDelay.Tick += delegate
                {
                    _clickDelay.Stop();
                    string h = _pendingHit;
                    _pendingHit = null;
                    if (h == null) return;
                    if (h == "head" || h == "face") Post("OnMouseClick" + (h == "head" ? "Head" : "Face"));
                    else Post("OnMouseClickBody");
                };
            }
            _clickDelay.Stop();
            _clickDelay.Start();
        }

        void CancelClick()
        {
            if (_clickDelay != null) _clickDelay.Stop();
            _pendingHit = null;
        }

        /// <summary>
        /// 滚轮缩放立绘：向上 5%、向下 5%，走和菜单「尺寸」同一条 ApplyScale 路径（会写回 settings.json）。
        /// 台词 10 分钟只放一次——连滚十几格不该刷出十几句话；缩放本身仍然每一格都生效。
        /// </summary>
        void OnSpriteWheel(object s, MouseWheelEventArgs e)
        {
            e.Handled = true;
            Touch();
            double next = ClampScale(_scale + (e.Delta > 0 ? 0.05 : -0.05));
            if (Math.Abs(next - _scale) < 0.001)
            {
                Log("wheel: at limit scale=" + Math.Round(_scale, 2));
                return;
            }
            ApplyScale(next);
            Log("wheel: scale=" + Math.Round(_scale, 2));
            if (Cooled("say_wheel", 10))
            {
                MarkCool("say_wheel");
                Say(PickPool("wheel", null, 2, "……放大是要干什么。"), true);
            }
        }

        void OnSpriteDown(object s, MouseButtonEventArgs e)
        {
            Touch();
            if (e.ClickCount == 2)
            {
                CancelClick();          // 第二下已到：把第一下的「摸头/戳」撤掉，只留「抱」，别把好感算两遍
                BuildLinesIfNeeded();
                // 双击＝抱一下：比摸头更亲，涨好感也更快
                HugSay();
                e.Handled = true;
                return;
            }
            _dragging = true;
            _moved = false;
            _dragStart = CursorDip();          // 屏幕坐标：窗口移动不会改变它
            _winStart = new Point(Left, Top);
            _sprite.CaptureMouse();
            if (_ticker != null) _ticker.Stop();   // 拖动期间别和呼吸动画抢帧
            e.Handled = true;
        }

        void OnSpriteMove(object s, MouseEventArgs e)
        {
            if (!_dragging) return;
            Point cur = CursorDip();
            double dx = cur.X - _dragStart.X;
            double dy = cur.Y - _dragStart.Y;
            if (!_moved && (Math.Abs(dx) > 3 || Math.Abs(dy) > 3)) _moved = true;
            if (!_moved) return;
            Left = _winStart.X + dx;
            Top = _winStart.Y + dy;
        }

        void OnSpriteUp(object s, MouseButtonEventArgs e)
        {
            if (!_dragging) return;
            _dragging = false;
            _sprite.ReleaseMouseCapture();
            if (_ticker != null && !_ticker.IsEnabled) _ticker.Start();
            if (!_moved)
            {
                BuildLinesIfNeeded();
                string hit = RegionAt(e.GetPosition(_sprite));
                // "none" = 点在立绘外（缩放后窗口比立绘宽的边角），当成没点着，别乱说话
                if (hit == "none") { e.Handled = true; SaveState(); return; }
                QueueClick(hit);     // 延后一点执行：双击的第一下也会到这里，等第二次 down 来取消
            }
            e.Handled = true;
            SaveState();
        }

        void Hop() { _hopT = 0; }

        // ================= 定时器：呼吸 + 跳 =================
        // 省电档（settings.json 的 power_save，或托盘菜单切换）：
        //   常驻 20fps → 只有「窗口可见 + 前台 + 不在拖动 + 最近 60 秒有过交互」时全速，
        //   其余时间降到 4fps；省电档下再砍到 2fps 且暂停呼吸。
        bool _powerSave = false;
        DateTime _lastTouch = DateTime.Now;

        /// <summary>摸头、拖动、说话、弹菜单都算「用户在看着」，重新计时。</summary>
        void Touch() { _lastTouch = DateTime.Now; }

        // ================= 事件总线 =================
        // 三个定时器职责分开：33 ms 只管画面、1 s 派发秒/分/刻、60 s 轮到点提醒与跨日。
        // 所有「发生了一件事」都走 Post()，业务逻辑挂在 Dispatch() 里 —— 与传统伪春菜的 On* 同构。

        void Post(string name, string arg = null)
        {
            _evtq.Enqueue(new Evt(name, arg));
            if (!_pumping && Dispatcher.CheckAccess()) PumpEvents();
            else if (!Dispatcher.CheckAccess()) Dispatcher.BeginInvoke(new Action(PumpEvents));
        }

        void PumpEvents()
        {
            if (_pumping) return;
            _pumping = true;
            try
            {
                int guard = 0;
                while (_evtq.Count > 0 && guard++ < 16) Dispatch(_evtq.Dequeue());
            }
            finally { _pumping = false; }
        }

        void Dispatch(Evt e)
        {
            switch (e.Name)
            {
                case "OnSecondChange":
                    if (_lastHour < 0) break;
                    break;
                case "OnMinuteChange":
                    CheckSettingsFile();               // 面板改了尺寸/省电，1 分钟内跟上
                    break;
                case "OnHourChange":
                    HourlySay();
                    break;
                case "OnReminderTick":
                    CheckTodayFile();
                    CheckReminders();
                    CheckNewDay();
                    break;
                case "OnMouseClickHead":
                    NadeSay();
                    break;
                case "OnMouseClickFace":
                    PokeSay();
                    break;
                case "OnMouseClickBody":
                    if (_click != null && _click.Length > 0) Say(_click[_rnd.Next(_click.Length)], true);
                    else Say(PickRandom(), true);
                    break;
                case "OnTrayBump":
                    BumpShow(e.Arg, null, 1);
                    break;
                case "OnMenuOpen":
                    SayMenuOpen();
                    break;
                case "OnBumpRapid":
                    Tickle("bump");
                    break;
                case "OnCatchupFull":
                    Tickle("bump");
                    break;
                case "OnIdleLong":
                    MaybeIdleSay();
                    break;
                case "OnOpenPanel":
                    if ((DateTime.Now - _lastPanelSay).TotalSeconds > 90)
                    {
                        _lastPanelSay = DateTime.Now;
                        Say(PickFrom("openPanel", null, 0, "番组表，打开着。"), true);
                    }
                    break;
                case "OnSyncDone":
                case "OnSyncFail":
                    Log("同步回执 " + e.Name + (e.Arg == null ? "" : " " + e.Arg));
                    break;
                case "OnBackToFront":
                    Touch();
                    break;
                default:
                    Log("未处理事件 " + e.Name);
                    break;
            }
        }

        /// <summary>秒表：每 1 s 推一个 OnSecondChange，顺带在跨分/跨刻时补发事件。</summary>
        void StartBeat()
        {
            if (_beat == null)
            {
                _beat = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
                _beat.Tick += delegate
                {
                    var n = DateTime.Now;
                    _lastTickAt = n;
                    if (_lastMinute != n.Minute)
                    {
                        bool first = _lastMinute < 0;
                        _lastMinute = n.Minute;
                        if (!first) { Post("OnMinuteChange"); Post("OnSecondChange"); }
                        // 每分钟：妄想/慌张衰减 + 看看是不是静置太久
                        DecayPersona();
                        MaybeIdleSay();
                    }
                    if (_lastHour != n.Hour)
                    {
                        bool first = _lastHour < 0;
                        _lastHour = n.Hour;
                        if (!first) Post("OnHourChange");
                    }
                    _lastDayOfYear = n.DayOfYear;
                };
            }
            _beat.Start();
        }

        void StartTick()
        {
            double el = 0;
            _ticker = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(50) };
            _ticker.Tick += (s, e) =>
            {
                bool hidden = !IsVisible || WindowState == WindowState.Minimized;
                double quietFor = (DateTime.Now - _lastTouch).TotalSeconds;
                // 三档：刚交互过 20fps / 静了 1 分钟 2fps（保个呼吸感）/ 静了 5 分钟彻底不动
                //      省电档直接 0。只有真人动作（摸头、拖动、点菜单、点脸）才 Touch()；
                //      说话本身不算活动，否则 45-90s 一句的闲话会把这里永远钉在 20fps。
                int want = _powerSave || quietFor > 300 ? 0 : (quietFor < 60 && !hidden ? 20 : 2);
                if (want != _lastWant) { _lastWant = want; Log("fps tier=" + want + " quiet=" + Math.Round(quietFor)); }

                if (want <= 0)
                {
                    if (_offset.Y != 0 && _hopT < 0) _offset.Y = 0;   // 归位一次就够
                    return;
                }

                // 帧率靠「隔几帧真的动一次」实现：定时器始终 50ms，省电时只是大部分帧直接 return
                int every = Math.Max(1, 20 / want);
                if (++_tickSkip < every) return;
                _tickSkip = 0;

                el += 1.0 / want;
                double breathe = _powerSave ? 0 : Math.Sin(el * 2 * Math.PI / 3.6) * 2.0;
                double hop = 0;
                if (_hopT >= 0)
                {
                    _hopT += (1.0 / want) / 0.42;
                    if (_hopT >= 1) { _hopT = -1; }
                    else hop = -20 * Math.Sin(Math.PI * _hopT);
                }
                _offset.Y = breathe + hop;
            };
            _ticker.Start();
        }

        int _tickSkip;
        int _lastWant = -1;     // 只为日志：档位切换时记一行，方便事后确认「静置后会掉到 2fps / 0」

        // ================= 状态：位置 / 跨日 / 开播提醒 =================
        readonly DateTime _born = DateTime.Now;

        void LoadState()
        {
            try
            {
                if (!File.Exists(_statePath)) return;
                var ser = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };
                var d = ser.Deserialize<Dictionary<string, object>>(File.ReadAllText(_statePath, Encoding.UTF8));
                if (d == null) return;
                object v;
                if (d.TryGetValue("left", out v)) { double l; if (double.TryParse(Str(v), NumberStyles.Float, CultureInfo.InvariantCulture, out l)) _savedLeft = l; }
                if (d.TryGetValue("top", out v)) { double t; if (double.TryParse(Str(v), NumberStyles.Float, CultureInfo.InvariantCulture, out t)) _savedTop = t; }
                if (d.TryGetValue("last_boot_date", out v)) _lastBootDate = Str(v);
                if (d.TryGetValue("layer", out v))
                {
                    string s0 = Str(v);
                    if (s0 == "top" || s0 == "normal" || s0 == "bottom") _layer = s0;
                }
                object rv;
                if (d.TryGetValue("reminded", out rv))
                {
                    var arr = rv as object[];
                    if (arr != null) { _reminded.Clear(); foreach (var o in arr) { string s1 = Str(o); if (!string.IsNullOrEmpty(s1)) _reminded.Add(s1); } }
                }
                if (d.TryGetValue("snoozed", out rv) && rv != null)
                {
                    var snoozes = ser.ConvertToType<Dictionary<string, ReminderSnooze>>(rv);
                    foreach (var entry in snoozes) if (entry.Value != null) _snoozed[entry.Key] = entry.Value;
                }
                if (d.TryGetValue("pet_scale", out v))
                {
                    double sc;
                    if (double.TryParse(Str(v), NumberStyles.Float, CultureInfo.InvariantCulture, out sc))
                        _scale = Math.Max(0.5, Math.Min(2.0, sc));
                }
                object vv;
                if (d.TryGetValue("vars", out vv))
                {
                    var vd = vv as Dictionary<string, object>;
                    if (vd != null) foreach (var kv in vd) _user[kv.Key] = Str(kv.Value);
                    Log("vars=" + _user.Count + " affinity=" + UV("affinity", "0") + " nade_total=" + UV("nade_total", "0"));
                }
                ResetDailyVars();
                Log("state left=" + _savedLeft + " top=" + _savedTop + " lastBoot=" + _lastBootDate + " layer=" + _layer);
            }
            catch (Exception ex) { Log("state load failed " + ex.Message); }
            // settings.json 是"用户偏好"的唯一入口（面板改的就是它），状态文件只兜底
            try
            {
                string sp = Path.Combine(_root, "data", "settings.json");
                if (File.Exists(sp))
                {
                    var ser2 = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };
                    var sd = ser2.Deserialize<Dictionary<string, object>>(File.ReadAllText(sp, Encoding.UTF8));
                    object v2; double sc2;
                    if (sd != null && sd.TryGetValue("pet_scale", out v2) &&
                        double.TryParse(Str(v2), NumberStyles.Float, CultureInfo.InvariantCulture, out sc2))
                    {
                        _scale = Math.Max(0.5, Math.Min(2.0, sc2));
                        Log("scale from settings=" + _scale.ToString("0.##", CultureInfo.InvariantCulture));
                    }
                    object ps;
                    if (sd != null && sd.TryGetValue("power_save", out ps))
                    {
                        _powerSave = Str(ps) == "1" || Str(ps).ToLowerInvariant() == "true";
                        Log("power_save=" + _powerSave);
                    }
                }
            }
            catch (Exception ex) { Log("settings load failed " + ex.Message); }
        }

        static string Str(object o)
        {
            return o == null ? "" : Convert.ToString(o, CultureInfo.InvariantCulture);
        }

        /// <summary>JSON 字符串转义（不想为此引一个序列化器）</summary>
        static string Esc(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n");
        }

        /// <summary>PET_SELFTEST=1 时置位：只读自检——不写 state.json、不打写接口、不跑会改库的 node</summary>
        bool _selfTest;

        void SaveState()
        {
            if (string.IsNullOrEmpty(_statePath)) return;
            if (_selfTest) return;          // 自检不许留下副作用（好感/次数/位置都只在内存里变）
            try
            {
                var sb = new StringBuilder();
                sb.Append("{\"left\":").Append(Left.ToString("0.##", CultureInfo.InvariantCulture));
                // Top 要按「收起气泡时的窗口」记：气泡展开时窗口是向上长高的，Top 已经被减掉 band，
                // 直接存会让宠物每启动/退出一次往上漂一个气泡的高度（100% ≈ 108~120 DIP）。
                double restTop = Top + Height - (ScaledH + 12);
                sb.Append(",\"top\":").Append(restTop.ToString("0.##", CultureInfo.InvariantCulture));
                sb.Append(",\"last_boot_date\":\"").Append((_lastBootDate ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"")).Append("\"");
                sb.Append(",\"layer\":\"").Append(_layer).Append("\"");
                if (!_scaleFromEnv)
                    sb.Append(",\"pet_scale\":").Append(_scale.ToString("0.##", CultureInfo.InvariantCulture));
                sb.Append(",\"power_save\":").Append(_powerSave ? "true" : "false");
                sb.Append(",\"reminded\":[");
                bool firstR = true;
                foreach (var k in _reminded)
                {
                    if (!firstR) sb.Append(",");
                    firstR = false;
                    sb.Append("\"").Append((k ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"")).Append("\"");
                }
                sb.Append("]");
                sb.Append(",\"snoozed\":").Append(new JavaScriptSerializer().Serialize(_snoozed));
                // 用户态变量（好感/心情/今日互动次数）——对应传统伪春菜的 yaya_variable.cfg
                sb.Append(",\"vars\":{");
                bool firstU = true;
                foreach (var kv in _user)
                {
                    if (!firstU) sb.Append(",");
                    firstU = false;
                    sb.Append("\"").Append(Esc(kv.Key)).Append("\":\"").Append(Esc(kv.Value)).Append("\"");
                }
                sb.Append("}}");
                File.WriteAllText(_statePath, sb.ToString(), new UTF8Encoding(false));
            }
            catch (Exception ex) { Log("state save failed " + ex.Message); }
        }

        protected override void OnClosing(System.ComponentModel.CancelEventArgs e)
        {
            SaveState();
            if (_tray != null) { try { _tray.Visible = false; _tray.Dispose(); } catch { } _tray = null; }
            base.OnClosing(e);
            if (!e.Cancel)
            {
                _closing = true;
                if (_panelHost != null) _panelHost.Dispose();
            }
        }

        static long UnixNow()
        {
            return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalSeconds;
        }

        /// <summary>
        /// 提醒与设置原来各挂一个定时器（20 s / 4 s），现在合并成 4 s 的调度器：
        /// 每 4 s 看一次 settings.json 与 today.txt，每第 5 次（20 s）顺带扫开播提醒。
        /// 少一个常驻定时器，功耗和唤醒次数都下来一点。
        /// </summary>
        void StartReminderTimer()
        {
            // 60 s 一跳：到点提醒 + 跨日。面板改设置由 OnMinuteChange 管，不再挤在这条链上。
            if (_remindBeat == null)
            {
                _remindBeat = new DispatcherTimer { Interval = TimeSpan.FromSeconds(60) };
                _remindBeat.Tick += delegate { Post("OnReminderTick"); };
            }
            _remindBeat.Start();
            CheckSettingsFile();
        }

        DateTime _settingsStamp;

        void CheckSettingsFile()
        {
            CheckTodayFile();
            try
            {
                string sp = Path.Combine(_root, "data", "settings.json");
                if (!File.Exists(sp)) return;
                DateTime st = File.GetLastWriteTimeUtc(sp);
                if (st == _settingsStamp) return;
                _settingsStamp = st;
                var ser = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };
                var d = ser.Deserialize<Dictionary<string, object>>(File.ReadAllText(sp, Encoding.UTF8));
                object v;
                double sc;
                if (d == null) return;
                object ps;
                if (d.TryGetValue("power_save", out ps))
                {
                    bool want = Str(ps) == "1" || Str(ps).ToLowerInvariant() == "true";
                    if (want != _powerSave) { _powerSave = want; Log("power_save from settings=" + want); }
                }
                if (!d.TryGetValue("pet_scale", out v)) return;
                if (!double.TryParse(Str(v), NumberStyles.Float, CultureInfo.InvariantCulture, out sc)) return;
                sc = ClampScale(sc);
                if (Math.Abs(sc - _scale) < 0.01) return;
                if (_scaleFromEnv) { Log("settings scale ignored (PET_SCALE 优先)"); return; }
                ApplyScale(sc, false);
                Say(new Line { Text = "大小换成 " + Math.Round(sc * 100) + "% 了。", Face = FaceIndex("happy") });
            }
            catch (Exception ex) { Log("settings watch failed " + ex.Message); }
        }

        /// <summary>尺寸写回 settings.json（和 SavePowerToSettings 是同一份文件、同一套读-改-写）。</summary>
        void SaveScaleToSettings(double scale)
        {
            if (_selfTest) return;      // 自检只读：连 settings.json 也不动
            try
            {
                string sp = Path.Combine(_root, "data", "settings.json");
                Dictionary<string, object> d = null;
                if (File.Exists(sp))
                {
                    var ser = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };
                    d = ser.Deserialize<Dictionary<string, object>>(File.ReadAllText(sp, Encoding.UTF8));
                }
                if (d == null) d = new Dictionary<string, object>();
                d["pet_scale"] = Math.Round(scale, 2);
                File.WriteAllText(sp, new JavaScriptSerializer().Serialize(d), new UTF8Encoding(false));
                // 自己写的时间戳记下来，否则下一次 CheckSettingsFile 会当成「面板改了」再 ApplyScale 一次
                _settingsStamp = File.GetLastWriteTimeUtc(sp);
                Log("settings pet_scale=" + scale.ToString("0.##", CultureInfo.InvariantCulture));
            }
            catch (Exception ex) { Log("settings save scale failed: " + ex.Message); }
        }

        /// <summary>省电档写回 settings.json（面板与 doctor 都能看到），失败就算了。</summary>
        void SavePowerToSettings(bool on)
        {
            try
            {
                string sp = Path.Combine(_root, "data", "settings.json");
                Dictionary<string, object> d = null;
                if (File.Exists(sp))
                {
                    var ser = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };
                    d = ser.Deserialize<Dictionary<string, object>>(File.ReadAllText(sp, Encoding.UTF8));
                }
                if (d == null) d = new Dictionary<string, object>();
                d["power_save"] = on ? "1" : "0";
                File.WriteAllText(sp, new JavaScriptSerializer().Serialize(d), new UTF8Encoding(false));
            }
            catch (Exception ex) { Log("settings save power failed " + ex.Message); }
        }

        DateTime _todayStamp;

        /// <summary>面板点了 +/− 或同步后 today.txt 会重算，桌宠这边跟着换数据，不用手动「重算今日数据」</summary>
        void CheckTodayFile()
        {
            try
            {
                string tp = Path.Combine(_root, "ghost", "master", "today.txt");
                if (!File.Exists(tp)) return;
                DateTime st = File.GetLastWriteTimeUtc(tp);
                if (st == _todayStamp) return;
                bool first = _todayStamp == default(DateTime);
                _todayStamp = st;
                if (first) return;                 // 启动时的第一次读取由构造函数负责
                if ((DateTime.Now - _born).TotalSeconds < 10) return;   // 启动静默期，别和构造时的 LoadData 撞车
                LoadData();
                Log("today.txt changed -> reloaded, count=" + I("count"));
                if (I("count") > 0 && V("next_name", "").Length > 0)
                    Say(new Line { Text = "数据更新了。" + V("summary", ""), Face = FaceIndex("normal") });
            }
            catch (Exception ex) { Log("today watch failed " + ex.Message); }
        }

        HashSet<string> ReadActiveWatchIds()
        {
            try
            {
                string file = Path.Combine(_root, "data", "library.json");
                using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    string expected = V("library_sha256", "");
                    if (expected.Length > 0)
                    {
                        using (var sha = System.Security.Cryptography.SHA256.Create())
                        {
                            string actual = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
                            if (expected != actual) return null;
                            stream.Position = 0;
                        }
                    }
                    using (var reader = new StreamReader(stream, Encoding.UTF8))
                    {
                    var library = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                    var ids = new HashSet<string>(StringComparer.Ordinal);
                    object value;
                    var rows = library != null && library.TryGetValue("watching", out value) ? AsList(value) : null;
                    if (rows == null) return null;
                    foreach (object item in rows)
                    {
                        var row = item as Dictionary<string, object>;
                        object muted, ended;
                        if (row != null && (!row.TryGetValue("reminder_muted", out muted) || !object.Equals(muted, true)) &&
                            (!row.TryGetValue("schedule_ended", out ended) || !object.Equals(ended, true)) &&
                            row.TryGetValue("id", out value)) ids.Add(Str(value));
                    }
                    return ids;
                    }
                }
            }
            catch (Exception e) { Log("watching check failed: " + e.Message); return null; }
        }

        Dictionary<string, object> ReadReminderSettings()
        {
            try
            {
                string file = Path.Combine(_root, "data", "settings.json");
                using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                using (var reader = new StreamReader(stream, Encoding.UTF8))
                    return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
            }
            catch { return null; }
        }

        static bool ReminderQuiet(Dictionary<string, object> settings, long at)
        {
            object startText, endText;
            TimeSpan start, end;
            if (settings == null || !settings.TryGetValue("quiet_start", out startText) || !settings.TryGetValue("quiet_end", out endText) ||
                !TimeSpan.TryParseExact(Str(startText), @"hh\:mm", CultureInfo.InvariantCulture, out start) ||
                !TimeSpan.TryParseExact(Str(endText), @"hh\:mm", CultureInfo.InvariantCulture, out end) || start == end) return false;
            TimeSpan time = new DateTime(1970, 1, 1).AddSeconds(at).AddHours(8).TimeOfDay;
            return start < end ? time >= start && time < end : time >= start || time < end;
        }

        bool CheckSnoozes(long now)
        {
            foreach (var entry in new List<KeyValuePair<string, ReminderSnooze>>(_snoozed))
            {
                if (entry.Value.At > now) continue;
                var active = ReadActiveWatchIds();
                if (active == null) return false;
                _snoozed.Remove(entry.Key);
                SaveState();
                var settings = ReadReminderSettings();
                if (!active.Contains(entry.Key) || now - entry.Value.At > 90 ||
                    ReminderQuiet(settings, now) || ReminderQuiet(settings, entry.Value.At)) continue;
                string message = entry.Value.Name + " 已经开播了。";
                SayWithChoices(new Line(message, 1),
                    new Choice("记一话", delegate { BumpShow(entry.Key, entry.Value.Name, 1); }),
                    new Choice("知道了", delegate { }));
                Notify("TIARA · " + entry.Value.Name, message);
                Hop();
                return true;
            }
            return false;
        }

        /// <summary>到点提醒：开播后 90 秒内说一次；刚启动的两分钟里放宽到 6 小时（关机期间错过的也能补上）</summary>
        void CheckReminders()
        {
            string date = V("date", "");
            int count = I("count");
            long now = UnixNow();
            if (CheckSnoozes(now)) return;
            long grace = (DateTime.Now - _born).TotalSeconds < 120 ? 6 * 3600 : 90;
            HashSet<string> active = null;
            for (int i = 1; i <= count; i++)
            {
                long at;
                if (!long.TryParse(V("show" + i + "_unix", ""), out at) || at <= 0) continue;
                if (now < at || now > at + grace) continue;
                string sid = V("show" + i + "_id", "");
                string key = date + "|" + sid + "|" + at;
                if (_reminded.Contains(key) || _reminded.Contains(date + "|" + V("show" + i + "_name", ""))) continue;
                // The library write can precede snapshot regeneration. Confirm before notifying.
                if (active == null) active = ReadActiveWatchIds();
                if (active == null) return;
                if (string.IsNullOrEmpty(sid) || !active.Contains(sid)) continue;
                var settings = ReadReminderSettings();
                if (ReminderQuiet(settings, now) || ReminderQuiet(settings, at)) continue;
                _reminded.Add(key);
                SaveState();
                var ctx = new Dictionary<string, string>();
                ctx["name_cn"] = V("show" + i + "_name", "这一部");
                ctx["time_cst"] = V("show" + i + "_time_disp", V("show" + i + "_time", "--:--"));
                ctx["eps"] = V("show" + i + "_eps", "");
                bool late = now > at + 90;
                string fb = late
                    ? ctx["name_cn"] + " 已经开播了。第 " + ctx["eps"] + " 话。"
                    : ctx["name_cn"] + " 开播了。第 " + ctx["eps"] + " 话。";
                // 到点提醒给两颗按钮：记一话 / 待会儿（等价于 OnChoiceSelect）
                string sname = ctx["name_cn"];
                Line l = PickFrom("remind", ctx, 3, fb);
                SayWithChoices(l,
                    new Choice("记一话", delegate { BumpShow(sid, sname, 1); }),
                    new Choice("15 分钟后提醒", delegate
                    {
                        _snoozed[sid] = new ReminderSnooze { Name = sname, At = UnixNow() + 15 * 60 };
                        SaveState();
                    }),
                    new Choice("在看", delegate { Say(new Line("好，那我不催了。", 1), true); }));
                Notify("TIARA · " + ctx["name_cn"], fb);
                Hop();
                break;   // 一次只说一部，别连环弹
            }
            Log("reminded " + _reminded.Count + " (grace " + grace + "s)");
        }

        void ScheduleMidnight()
        {
            if (_midnightTimer == null)
            {
                _midnightTimer = new DispatcherTimer { Interval = TimeSpan.FromMinutes(1) };
                _midnightTimer.Tick += delegate { CheckNewDay(); };
            }
            _midnightTimer.Start();
        }

        int _dayChecked = -1;

        /// <summary>跨日自动重算：数据日期和今天不一致就 rebuild，不再等人手动点</summary>
        void CheckNewDay()
        {
            DateTime now = DateTime.Now;
            if (_dayChecked == now.DayOfYear) return;
            if (now.ToString("yyyy-MM-dd") == V("date", "")) { _dayChecked = now.DayOfYear; return; }
            Log("new day detected, rebuilding");
            ResetDailyVars();
            // 重算成功之后才置 _dayChecked：以前是先置再重算，node 挂了/没网就一整天不再试
            RefreshDataAsync(false, delegate (bool ok)
            {
                if (!ok) { Log("new day rebuild failed, retry next minute"); return; }
                _dayChecked = DateTime.Now.DayOfYear;
                _reminded.Clear();
                CheckMilestone();
                if ((DateTime.Now - _born).TotalSeconds > 120)
                    Say(PickFrom("midnight", null, 4, "跨日了。今天的番单我重新排了一遍。"));
            });
        }

        /// <summary>纪念日：一起待满 7 / 30 / 100 / 200 / 365 天各说一次，跨日时检查。</summary>
        void CheckMilestone()
        {
            string first = UV("first_seen", "");
            if (string.IsNullOrEmpty(first))
            {
                SetU("first_seen", DateTime.Now.ToString("yyyy-MM-dd"));
                SaveState();
                return;
            }
            DateTime d0;
            if (!DateTime.TryParse(first, out d0)) return;
            int days = (int)(DateTime.Now.Date - d0.Date).TotalDays + 1;
            int[] marks = { 7, 30, 100, 200, 365 };
            // 跳着来的（比如隔了 100 天才开一次）：只报最大的那个，小的直接标记为已过，免得补报一串
            int hit = 0;
            foreach (int m in marks)
            {
                if (days < m) break;
                if (UV("milestone_" + m, "0") == "1") continue;
                hit = m;
            }
            if (hit == 0) return;
            foreach (int m in marks)
            {
                if (m > hit) break;
                if (UV("milestone_" + m, "0") != "1") SetU("milestone_" + m, "1");
            }
            SaveState();
            var ctx = new Dictionary<string, string>();
            ctx["days"] = days.ToString();
            ctx["mark"] = hit.ToString();
            Say(PickFrom("anniversary", ctx, 1, "第 " + days + " 天了。……我记着呢。"), true);
            Log("milestone " + hit + " days=" + days);
        }

        /// <summary>手动拉一次 Bangumi（拿不到网就照旧用本地数据）</summary>
        /// <summary>撤销上一次写库（走 /api/undo，和面板同一个撤销栈）。</summary>
        void UndoLast()
        {
            if (_selfTest) { Log("selftest: UndoLast dry-run（只读，不打 /api/undo）"); return; }
            UsePanel(UndoOnPanel, true);
        }

        void UndoOnPanel(int port)
        {
            Say(PickFrom("undoWait", null, 1, "……刚才是记错了吗。我退回一步。"));
            PostJsonAsync("http://127.0.0.1:" + port + "/api/undo", "{}", delegate (string resp)
            {
                string depth = JsonField(resp, "depth");
                bool ok = resp != null && resp.IndexOf("\"error\"") < 0 && resp.IndexOf("\"ok\":true") >= 0;
                if (ok)
                {
                    RefreshData(false);
                    Say(PickFrom("undoOk", null, 1, "退回一步了。……下次小心点。"), true);
                    Log("undo ok depth=" + (depth ?? "?"));
                }
                else
                {
                    Say(PickFrom("undoFail", null, 2, "没有可以退回的了。"), true);
                    Log("undo failed: " + (resp == null ? "(null)" : resp.Substring(0, Math.Min(120, resp.Length))));
                }
            });
        }

        void SyncBangumi()
        {
            // 有副作用的动作先问一句，别点错就动库
            SayWithChoices(
                PickFrom("askSync", null, 0, "要现在去 Bangumi 拿最新资料吗？"),
                new Choice(M("choice_yes", "同步吧"), delegate { HideChoices(); SyncBangumi(true); }),
                new Choice(M("choice_no", "等会儿"), delegate { HideChoices(); Say(PickFrom("soft", null, 1, "……嗯。我记着。"), true); }));
        }

        void SyncBangumi(bool confirmed)
        {
            if (_selfTest) { Log("selftest: SyncBangumi dry-run"); return; }
            OpenWebPanel("?sync=1");
        }

        /// <summary>开机顺手同步一次：缓存超过 12 小时才真的去问网络，失败就不吭声</summary>
        void TryAutoSync()
        {
            if (_selfTest) { Log("selftest: autosync skipped"); return; }
            string cstDate = DateTime.UtcNow.AddHours(8).ToString("yyyy-MM-dd");
            bool staleDate = V("date", "") != cstDate;
            try
            {
                var th = new System.Threading.Thread(delegate ()
                {
                    try
                    {
                        string today = Path.Combine(_root, "ghost", "master", "today.txt");
                        var todayStamp = File.GetLastWriteTimeUtc(today);
                        if (staleDate || todayStamp < File.GetLastWriteTimeUtc(Path.Combine(_root, "data", "library.json")) ||
                            todayStamp < File.GetLastWriteTimeUtc(Path.Combine(_root, "data", "settings.json")))
                        {
                            if (RunNodeOnce("tools/build_today.mjs", 15000) == 0)
                                Dispatcher.BeginInvoke(new Action(CheckTodayFile));
                        }
                        string stamp = Path.Combine(_root, "cache", "bgm", "sync-success.json");
                        if (File.Exists(stamp) && (DateTime.Now - File.GetLastWriteTime(stamp)).TotalHours < 12)
                        {
                            Log("autosync skipped: cache fresh");
                            return;
                        }
                        if (RunNodeOnce("tools/sync_bangumi.mjs", 30000) != 0)
                        {
                            Log("autosync skipped: no network or node missing");
                            return;
                        }
                        if (RunNodeOnce("tools/build_today.mjs", 15000) != 0) return;
                        Dispatcher.Invoke(new Action(delegate
                        {
                            LoadData();
                            BuildLines();
                            _linesReady = true;
                            if (PanelOpen) RefreshPopup();
                            Say(PickFrom("syncOk", null, 1, "顺手把番组表更新了。"));
                            Log("autosync done count=" + V("count", "0"));
                        }));
                    }
                    catch (Exception ex) { Log("autosync failed " + ex.Message); }
                });
                th.IsBackground = true;
                th.Start();
            }
            catch (Exception ex) { Log("autosync thread failed " + ex.Message); }
        }

        /// <summary>找 node：优先仓库自带的 runtime\node.exe（.bat 也是这么找的），没有才退回 PATH。</summary>
        string ResolveNode()
        {
            return PanelHost.Runtime(_root);
        }

        /// <summary>
        /// 跑一次 node 脚本，返回退出码（-1 = 没跑起来 / 超时被杀）。
        /// 输出必须用 BeginOutputReadLine 异步收：先 ReadToEnd(stdout) 再 ReadToEnd(stderr)
        /// 会在 stderr 写满管道缓冲（4 KB）时和子进程互相等死，最后只能等 WaitForExit 超时。
        /// </summary>
        int RunNode(string script, int timeoutMs, string tag)
        {
            var sbOut = new StringBuilder();
            var sbErr = new StringBuilder();
            try
            {
                var psi = new ProcessStartInfo(ResolveNode(), script)
                {
                    WorkingDirectory = _root,
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8
                };
                using (var p = new Process())
                {
                    p.StartInfo = psi;
                    p.OutputDataReceived += delegate (object s, DataReceivedEventArgs e)
                    { if (e.Data != null) { lock (sbOut) sbOut.AppendLine(e.Data); } };
                    p.ErrorDataReceived += delegate (object s, DataReceivedEventArgs e)
                    { if (e.Data != null) { lock (sbErr) sbErr.AppendLine(e.Data); } };
                    p.Start();
                    p.BeginOutputReadLine();
                    p.BeginErrorReadLine();
                    bool exited = p.WaitForExit(timeoutMs);
                    if (!exited)
                    {
                        // 超时：连 node 拉起来的子进程一起收，否则孤儿进程会接着写 library.json / today.txt
                        try
                        {
                            // .NET 4.5+ 才有 Kill(bool)；用反射调，免得编译机是 4.0 参考程序集
                            var killTree = typeof(Process).GetMethod("Kill", new Type[] { typeof(bool) });
                            if (killTree != null) killTree.Invoke(p, new object[] { true });
                            else p.Kill();
                        }
                        catch { try { p.Kill(); } catch { } }
                        Log("node " + script + " timeout " + timeoutMs + "ms → killed");
                    }
                    else
                    {
                        p.WaitForExit();       // 让异步收流把最后几行吐完
                    }
                    int code = p.HasExited ? p.ExitCode : -1;
                    string o, er;
                    lock (sbOut) o = sbOut.ToString().Trim();
                    lock (sbErr) er = sbErr.ToString().Trim();
                    Log("node " + script + " (" + tag + ") exit=" + code +
                        " out=" + (o.Length > 200 ? o.Substring(0, 200) : o).Replace("\n", " | ") +
                        " err=" + (er.Length > 300 ? er.Substring(0, 300) : er).Replace("\n", " | "));
                    return code;
                }
            }
            catch (Exception ex)
            {
                Log("node " + script + " (" + tag + ") failed（node 不在 PATH？）: " + ex.Message);
                return -1;
            }
        }

        /// <summary>后台线程跑 node，成功/失败回到 UI 线程再回调。</summary>
        void RunNodeAsync(string script, int timeoutMs, string tag, Action<bool> done)
        {
            var th = new System.Threading.Thread(delegate ()
            {
                bool ok = RunNode(script, timeoutMs, tag) == 0;
                if (done == null) return;
                try { Dispatcher.BeginInvoke(new Action(delegate { done(ok); })); } catch { }
            });
            th.IsBackground = true;
            th.Start();
        }

        /// <summary>跑一次 node 脚本，返回退出码（-1 表示没跑起来）</summary>
        int RunNodeOnce(string script, int timeoutMs)
        {
            return RunNode(script, timeoutMs, "auto");
        }

        /// <summary>重算 today.txt（node 在后台跑）→ 回 UI 线程重新加载 → 刷新说话池</summary>
        void RefreshData(bool speak)
        {
            RefreshDataAsync(speak, null);
        }

        void RefreshDataAsync(bool speak, Action<bool> done)
        {
            RunNodeAsync("tools/build_today.mjs", 15000, "rebuild", delegate (bool ok)
            {
                LoadData();
                BuildLines();
                _linesReady = true;
                if (PanelOpen) RefreshPopup();
                if (speak)
                    Say(PickFrom(ok ? "refresh" : "refreshFail", null, ok ? 1 : 2,
                        ok ? "重算好了，今天 " + V("count", "0") + " 部。" : "重算失败了，看 pet.log。"));
                if (done != null) done(ok);
            });
        }

        // ================= 透明像素穿透 =================
        void InstallHitTest()
        {
            if (LegacyFlag("PET_DEBUG_HIT")) return;   // 旧名：跳过命中钩子（整窗都能点）
            try
            {
                BuildAlphaMask();
                IntPtr h = new WindowInteropHelper(this).Handle;
                HwndSource.FromHwnd(h).AddHook(HitTestHook);
                Log("hit test installed mask=" + (_alpha == null ? "none" : _alphaW + "x" + _alphaH));
            }
            catch (Exception ex) { Log("hit test install failed " + ex.Message); }
        }

        IntPtr HitTestHook(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (msg != 0x84) return IntPtr.Zero;   // WM_NCHITTEST
            try
            {
                int packed = lParam.ToInt32();
                int sx = (short)(packed & 0xFFFF);
                int sy = (short)((packed >> 16) & 0xFFFF);
                // 气泡是窗口顶上那条纸：鼠标落在上面就该是可点的，别因为立绘 alpha=0 把它打成透明。
                // 气泡区域：按气泡在窗口里的真实矩形判（上下都能放，靠 TranslatePoint 算，别写死贴顶）
                if (_bubbleHost != null && _bubbleHost.Visibility == Visibility.Visible && _bubbleSkin.Data != null)
                {
                    Point bp = _bubbleSkin.PointFromScreen(new Point(sx, sy));
                    if (_bubbleSkin.RenderedGeometry.FillContains(bp)) return IntPtr.Zero;
                }
                Point sp = _sprite.PointFromScreen(new Point(sx, sy));
                bool solid = IsOpaque(sp.X, sp.Y);
                if (!solid)
                {
                    handled = true;
                    return (IntPtr)(-1);   // HTTRANSPARENT：点到立绘外面的地方，穿过去给下面的窗口
                }
            }
            catch (Exception ex)
            {
                if (_hitLogLeft-- > 0) Log("hittest failed " + ex.Message);
            }
            return IntPtr.Zero;
        }

        class AlphaMask
        {
            public byte[] Data;
            public int W, H, Stride;
        }

        readonly Dictionary<int, AlphaMask> _alphaCache = new Dictionary<int, AlphaMask>();
        AlphaMask _alphaMask;

        void BuildAlphaMask()
        {
            BuildAlphaMask(_curFace);
        }

        /// <summary>按表情建透明遮罩（每种脸缓存一份，最多 6 份）；缺差分就退回 surface0。</summary>
        void BuildAlphaMask(int face)
        {
            AlphaMask m;
            if (_alphaCache.TryGetValue(face, out m)) { ApplyMask(m); return; }
            string p = face >= 0 && face < _surfaces.Length ? _surfaces[face] : null;
            if (p == null) p = _surfaces[0];
            if (p == null) return;
            try
            {
                var dec = new PngBitmapDecoder(new Uri(p), BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad);
                BitmapSource src = dec.Frames[0];
                if (src.Format != PixelFormats.Bgra32)
                    src = new FormatConvertedBitmap(src, PixelFormats.Bgra32, null, 0);
                m = new AlphaMask { W = src.PixelWidth, H = src.PixelHeight };
                m.Stride = m.W * 4;
                m.Data = new byte[m.Stride * m.H];
                src.CopyPixels(m.Data, m.Stride, 0);
                _alphaCache[face] = m;
                ApplyMask(m);
            }
            catch (Exception ex) { Log("alpha mask failed face=" + face + ": " + ex.Message); }
        }

        void ApplyMask(AlphaMask m)
        {
            _alphaMask = m;
            _alpha = m != null ? m.Data : null;
            _alphaW = m != null ? m.W : 0;
            _alphaH = m != null ? m.H : 0;
            _alphaStride = m != null ? m.Stride : 0;
        }

        bool IsOpaque(double x, double y)
        {
            if (_alpha == null) return true;
            double w = _sprite.ActualWidth, h = _sprite.ActualHeight;
            if (w <= 0 || h <= 0) return true;
            int px = (int)(x / w * _alphaW);
            int py = (int)(y / h * _alphaH);
            if (px < 0 || py < 0 || px >= _alphaW || py >= _alphaH) return false;
            int off = py * _alphaStride + px * 4;
            return _alpha[off + 3] > 24;    // alpha 阈值：24/255≈9%，挡住发丝级的半透明
        }

        // ================= 网页番组表 / 退出 =================
        bool PanelOpen { get { return _popup != null && _popup.IsOpen; } }

        void RefreshPopup()
        {
            if (_popupCard == null) return;
            _popupCard.Child = new ScrollViewer
            {
                Content = BuildPanel(),
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
                MaxHeight = Math.Max(320, CurrentWorkAreaDip().Height * 0.78),
                Background = Paper
            };
        }

        void UsePanel(Action<int> ready, bool showError)
        {
            if (_panelHost == null || _closing) return;
            _panelHost.EnsureStarted().ContinueWith(task =>
            {
                if (task.IsFaulted)
                {
                    string message = task.Exception.GetBaseException().Message;
                    Log("panel unavailable: " + message);
                    if (showError) Dispatcher.BeginInvoke(new Action(delegate { if (!_closing) Say(new Line(message, 2), true); }));
                    return;
                }
                if (ready != null) Dispatcher.BeginInvoke(new Action(delegate { if (!_closing) ready(task.Result); }));
            });
        }

        void OpenWebPanel()
        {
            OpenWebPanel("");
        }

        void OpenWebPanel(string query)
        {
            UsePanel(delegate (int port)
            {
                string url = "http://127.0.0.1:" + port + "/" + query;
                try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
                catch (Exception ex) { Log("open panel failed " + ex.Message); Say(new Line("浏览器没能打开。地址是 " + url, 2), true); }
            }, true);
        }

        /// <summary>
        /// 记一话：走本地服务的 /api/progress（它负责写库 + 备份 + 重建 today.txt），
        /// 桌宠自己不碰 data/library.json —— 两边同时写会把数据写丢。
        /// </summary>
        void BumpShow(string id, string name, int delta)
        {
            if (string.IsNullOrEmpty(id)) return;
            if (_selfTest) { Log("selftest: BumpShow dry-run id=" + id + " delta=" + delta); return; }
            UsePanel(delegate (int port) { BumpOnPanel(port, id, name, delta); }, true);
        }

        void BumpOnPanel(int port, string id, string name, int delta)
        {
            string body = "{\"id\":" + JsonEncode(id) + ",\"delta\":" + delta + "}";
            // 后台发请求：本地服务卡住时也不能把 UI 线程一起拖住（原来能冻 5 分钟）
            PostJsonAsync("http://127.0.0.1:" + port + "/api/progress", body, delegate (string resp)
            {
                if (resp == null)
                {
                    Say(new Line("没记上……网页服务可能退出了。", 1));
                    return;
                }
                // 服务端回来的 ep_status 最准，用它说话
                int seen = 0, total = 0;
                try
                {
                    int.TryParse(JsonField(resp, "ep_status"), out seen);
                    int.TryParse(JsonField(resp, "eps"), out total);
                }
                catch { }
                string who = string.IsNullOrEmpty(name) ? "这" : name;
                if (delta > 0)
                {
                    // 说话交给 AfterBump：它要先判断「是不是连点」「是不是看完了」
                    AfterBump(who, seen, total > 0 ? total : 0);
                }
                else
                {
                    Say(new Line(who + "退回一话，现在 " + (total > 0 ? seen + "/" + total : seen + "") + "。", 1));
                }

                // 立刻重算 + 重画弹层（不然点完还是旧数字）；回调已经在 UI 线程上
                LoadData();
                if (PanelOpen) RefreshPopup();
            });
        }

        /// <summary>极简 POST：只用来打自己的本地服务，不带重试</summary>
        string PostJson(string url, string body)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Method = "POST";
                req.ContentType = "application/json; charset=utf-8";
                req.Timeout = 6000;
                req.ReadWriteTimeout = 3000;   // Timeout 只管「连上/拿到响应头」，回包慢时它不生效（默认 300 s）
                req.KeepAlive = false;
                req.Proxy = null;
                byte[] buf = Encoding.UTF8.GetBytes(body ?? "{}");
                req.ContentLength = buf.Length;
                using (var s = req.GetRequestStream()) s.Write(buf, 0, buf.Length);
                using (var r = (HttpWebResponse)req.GetResponse())
                using (var sr = new StreamReader(r.GetResponseStream(), Encoding.UTF8))
                    return sr.ReadToEnd();
            }
            catch (Exception ex)
            {
                Log("post " + url + " failed " + ex.Message);
                return null;
            }
        }

        /// <summary>
        /// PostJson 的后台版，回调在 UI 线程执行。UI 线程直接 PostJson 时，只要本地服务「接了连接但不回包」，
        /// 整个桌宠连同托盘菜单会一起冻住（ReadWriteTimeout 走满就是 5 分钟，只能杀进程）。
        /// </summary>
        void PostJsonAsync(string url, string body, Action<string> done)
        {
            var th = new System.Threading.Thread(delegate ()
            {
                string r = PostJson(url, body);
                if (done == null) return;
                try { Dispatcher.BeginInvoke(new Action(delegate { done(r); })); } catch { }
            });
            th.IsBackground = true;
            th.Start();
        }

        /// <summary>JSON 字符串字面量（含控制字符）。之前只转 \ 和 "，番名里混一个 TAB 就能把请求体写坏。</summary>
        static string JsonEncode(string s)
        {
            if (s == null) return "\"\"";
            var sb = new StringBuilder(s.Length + 8);
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        /// <summary>从 JSON 里抠一个数字字段（不想为一行值引入反序列化）</summary>
        static string JsonField(string json, string key)
        {
            if (string.IsNullOrEmpty(json)) return null;
            int i = json.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
            if (i < 0) return null;
            int c = json.IndexOf(':', i);
            if (c < 0) return null;
            int p = c + 1;
            while (p < json.Length && (json[p] == ' ' || json[p] == '\t')) p++;
            int q = p;
            while (q < json.Length && (char.IsDigit(json[q]) || json[q] == '-' || json[q] == '.')) q++;
            return q > p ? json.Substring(p, q - p) : null;
        }

        /// <summary>托盘图标：右下角留个入口，隐藏了也能叫回来</summary>
        void CreateTray()
        {
            try
            {
                var menu = new System.Windows.Forms.ContextMenuStrip();
                menu.Items.Add("显示 / 隐藏", null, delegate { ToggleVisibleFromTray(); });
                menu.Items.Add("番组表", null, delegate { ShowFromTray(); TogglePanel(); });

                // 记一话：托盘里直接记，不用先开弹层（今天没番时不显示这项）
                var bumpMenu = new System.Windows.Forms.ToolStripMenuItem("记一话");
                int todayCount = I("count");
                if (todayCount > 0)
                {
                    for (int i = 1; i <= todayCount && i <= 8; i++)
                    {
                        string sid = V("show" + i + "_id", "");
                        string snm = V("show" + i + "_name", "");
                        if (sid.Length == 0 || snm.Length == 0) continue;
                        string caption = snm.Length > 18 ? snm.Substring(0, 18) + "…" : snm;
                        bumpMenu.DropDownItems.Add(caption + "  ＋1", null,
                            delegate { BumpShow(sid, snm, 1); });
                    }
                }
                if (bumpMenu.DropDownItems.Count == 0)
                {
                    bumpMenu.DropDownItems.Add("今天没有番");
                    bumpMenu.Enabled = false;
                }
                menu.Items.Add(bumpMenu);

                menu.Items.Add("打开网页番组表", null, delegate { OpenWebPanel(); });
                menu.Items.Add(new System.Windows.Forms.ToolStripSeparator());
                menu.Items.Add("退出", null, delegate { ShowFromTray(); BeginQuit(); });

                _tray = new System.Windows.Forms.NotifyIcon
                {
                    Text = "TIARA · 番组管家",
                    Visible = true,
                    ContextMenuStrip = menu,
                    Icon = BuildTrayIcon()
                };
                _tray.DoubleClick += delegate { ToggleVisibleFromTray(); };
                Log("tray created");
            }
            catch (Exception ex) { Log("tray failed " + ex.Message); }
        }

        /// <summary>系统通知：后台时不至于错过，点一下就回到她旁边</summary>
        void Notify(string title, string text)
        {
            try
            {
                if (_tray == null) return;
                _tray.BalloonTipTitle = title;
                _tray.BalloonTipText = text;
                _tray.BalloonTipIcon = System.Windows.Forms.ToolTipIcon.Info;
                _tray.ShowBalloonTip(8000);
                Log("notify " + title + " / " + text);
            }
            catch (Exception ex) { Log("notify failed " + ex.Message); }
        }

        System.Drawing.Icon BuildTrayIcon()        {
            try
            {
                string p = Path.Combine(_root, "shell", "master", "surface0.png");
                if (File.Exists(p))
                {
                    using (var bmp = new System.Drawing.Bitmap(p))
                    {
                        using (var small = new System.Drawing.Bitmap(bmp, new System.Drawing.Size(32, 32)))
                        {
                            IntPtr h = small.GetHicon();
                            return System.Drawing.Icon.FromHandle(h);
                        }
                    }
                }
            }
            catch (Exception ex) { Log("tray icon failed " + ex.Message); }
            return System.Drawing.SystemIcons.Application;
        }

        void ToggleVisibleFromTray()
        {
            if (IsVisible) HideToTray(); else ShowFromTray();
        }

        void HideToTray()
        {
            Hide();
            Log("hidden to tray");
        }

        void ShowFromTray()
        {
            Show();
            SnapIntoWorkArea();
            ApplyLayer();
            Log("shown from tray visible=" + IsVisible);
        }

        // ---------- 开机自启（走 HKCU 的 Run 键，不需要管理员）----------
        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        const string RunName = "TiaraPet";

        static string ExePath()
        {
            try { return Process.GetCurrentProcess().MainModule.FileName; }
            catch { return null; }
        }

        static bool IsAutostartEnabled()
        {
            try
            {
                using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RunKey))
                {
                    if (k == null) return false;
                    string v = k.GetValue(RunName) as string;
                    return !string.IsNullOrEmpty(v);
                }
            }
            catch { return false; }
        }

        static void SetAutostart(bool on)
        {
            try
            {
                using (var k = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(RunKey))
                {
                    if (k == null) return;
                    if (on)
                    {
                        string exe = ExePath();
                        if (!string.IsNullOrEmpty(exe)) k.SetValue(RunName, "\"" + exe + "\"");
                    }
                    else
                    {
                        if (k.GetValue(RunName) != null) k.DeleteValue(RunName, false);
                    }
                }
            }
            catch (Exception ex) { Log("autostart failed " + ex.Message); }
        }

        /// <summary>说完再见再关：先念一句，3 秒后退出并记住位置</summary>
        void BeginQuit()
        {
            if (_closing) return;
            _closing = true;
            CancelSequence();
            // 收尾时如果已经过了 23 点、今天还没道过晚安，就先说 goodnight（一天一次）；否则说常规告别句
            if (!TryGoodnight()) Say(PickFrom("close", null, 0, "记好了。明天见。"));
            var t = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(2800) };
            t.Tick += delegate { t.Stop(); SaveState(); Close(); };
            t.Start();
        }
    }
}
