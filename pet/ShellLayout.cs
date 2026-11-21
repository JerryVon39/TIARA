using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace UkagakaBangumi
{
    public partial class PetWindow
    {
        static readonly string[] ShellFaces = { "normal", "happy", "sad", "surprise", "sleepy", "think", "bashful" };
        static readonly string[] ShellFaceLabels = { "平静", "微笑", "不悦", "惊讶", "困倦", "思考", "害羞" };
        static readonly string[] ShellRegions = { "face", "head", "body" };
        const byte HitAlpha = 24;

        Canvas _spriteLayout;
        ShellSkin _activeSkin;
        ShellImage _activeArt;
        Rect _spriteBounds = Rect.Empty;

        static int FaceIndex(string name)
        {
            return Math.Max(0, Array.IndexOf(ShellFaces, name));
        }

        static int FallbackFace(int index)
        {
            if (index == 4) return 2;
            if (index == 6) return 1;
            return 0;
        }

        sealed class ShellImage
        {
            public BitmapImage Base;
            public BitmapImage[] Overlays;
            public int Slot;
            public AlphaMask Mask;
        }

        sealed class ShellSkin
        {
            readonly string _directory;
            readonly Dictionary<string, object> _faces;
            readonly Dictionary<string, BitmapImage> _files = new Dictionary<string, BitmapImage>(StringComparer.OrdinalIgnoreCase);
            readonly Dictionary<int, ShellImage> _art = new Dictionary<int, ShellImage>();
            public readonly Dictionary<string, Rect> Regions = new Dictionary<string, Rect>();
            public readonly Size Canvas = Size.Empty;
            public readonly string MouthFile;
            public readonly Rect MouthRect = Rect.Empty;

            public ShellSkin(string directory)
            {
                _directory = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
                var file = Path.Combine(_directory, "faces.json");
                if (!File.Exists(file)) return;
                try
                {
                    var manifest = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 }
                        .Deserialize<Dictionary<string, object>>(File.ReadAllText(file, Encoding.UTF8));
                    var canvas = AsList(Value(manifest, "canvas"));
                    double width, height;
                    if (canvas != null && canvas.Count == 2 && Number(canvas[0], out width) && Number(canvas[1], out height) &&
                        width > 0 && height > 0) Canvas = new Size(width, height);
                    var rows = AsList(Value(manifest, "regions"));
                    if (rows != null) foreach (var row in rows)
                    {
                        var region = row as Dictionary<string, object>;
                        string name = Str(Value(region, "name"));
                        Rect rect;
                        if (name.Length > 0 && ReadRect(Value(region, "rect"), out rect)) Regions[name] = rect;
                    }
                    var mouth = Value(manifest, "mouth") as Dictionary<string, object>;
                    MouthFile = Str(Value(mouth, "src"));
                    Rect clip;
                    if (ReadRect(Value(mouth, "rect"), out clip)) MouthRect = clip;
                    _faces = Value(manifest, "faces") as Dictionary<string, object>;
                }
                catch (Exception ex) { Log("shell manifest: " + ex.Message); }
            }

            static object Value(Dictionary<string, object> obj, string key)
            {
                object value;
                return obj != null && obj.TryGetValue(key, out value) ? value : null;
            }

            static bool Number(object value, out double number)
            {
                return double.TryParse(Str(value), NumberStyles.Float, CultureInfo.InvariantCulture, out number) &&
                    !double.IsNaN(number) && !double.IsInfinity(number);
            }

            static bool ReadRect(object value, out Rect rect)
            {
                rect = Rect.Empty;
                var list = AsList(value);
                double x, y, w, h;
                if (list == null || list.Count != 4 || !Number(list[0], out x) || !Number(list[1], out y) ||
                    !Number(list[2], out w) || !Number(list[3], out h) || x < 0 || y < 0 || w <= 0 || h <= 0) return false;
                rect = new Rect(x, y, w, h);
                return true;
            }

            public BitmapImage Image(string file)
            {
                if (string.IsNullOrEmpty(file)) return null;
                BitmapImage loaded;
                if (_files.TryGetValue(file, out loaded)) return loaded;
                try
                {
                    var path = Path.GetFullPath(Path.Combine(_directory, file));
                    if (path.StartsWith(_directory, StringComparison.OrdinalIgnoreCase) && File.Exists(path))
                    {
                        loaded = LocalBitmap(path);
                        if (loaded.PixelWidth > 4096 || loaded.PixelHeight > 4096) loaded = null;
                    }
                }
                catch (Exception ex) { Log("shell image: " + ex.Message); }
                _files[file] = loaded;
                return loaded;
            }

            ShellImage ReadArt(int slot)
            {
                ShellImage art;
                if (_art.TryGetValue(slot, out art)) return art;
                var face = Value(_faces, ShellFaces[slot]) as Dictionary<string, object>;
                var image = Image(Str(Value(face, "base")));
                var overlays = image == null ? null : AsList(Value(face, "overlay"));
                var layers = new List<BitmapImage>();
                if (overlays != null) foreach (var layer in overlays)
                {
                    var bitmap = Image(Str(Value(layer as Dictionary<string, object>, "src")));
                    if (bitmap != null) layers.Add(bitmap);
                }
                if (image == null) image = Image("surface" + slot + ".png");
                int shown = object.Equals(Value(face, "fallback"), true) ? FallbackFace(slot) : slot;
                art = image == null ? null : new ShellImage { Base = image, Overlays = layers.ToArray(), Slot = shown };
                _art[slot] = art;
                return art;
            }

            public ShellImage Resolve(int slot)
            {
                return ReadArt(slot) ?? ReadArt(FallbackFace(slot)) ?? ReadArt(0);
            }

            public Size CanvasFor(ShellImage art)
            {
                return Canvas.IsEmpty ? new Size(art.Base.PixelWidth, art.Base.PixelHeight) : Canvas;
            }
        }

        ShellSkin OpenShellSkin(string name)
        {
            return new ShellSkin(Path.Combine(_root, "shell", name));
        }

        void LoadShell()
        {
            var skin = OpenShellSkin(_shellName);
            if (_shellName != "master" && skin.Resolve(0) == null)
            {
                _shellName = "master";
                skin = OpenShellSkin(_shellName);
            }
            UseShellSkin(skin);
        }

        void UseShellSkin(ShellSkin skin)
        {
            _activeSkin = skin;
            _mouthImg.Source = skin.Image(string.IsNullOrEmpty(skin.MouthFile) ? "talk.png" : skin.MouthFile);
            SetFace(_curFace);
            Log("shell=" + _shellName);
        }

        void SetFace(int slot)
        {
            _curFace = slot >= 0 && slot < ShellFaces.Length ? slot : 0;
            if (_activeSkin == null) return;
            _activeArt = _activeSkin.Resolve(_curFace);
            foreach (var overlay in _overlayImgs) _spriteLayout.Children.Remove(overlay);
            _overlayImgs.Clear();
            _sprite.Source = _activeArt == null ? null : _activeArt.Base;
            if (_activeArt != null) foreach (var layer in _activeArt.Overlays)
            {
                var image = new Image { Source = layer, Stretch = Stretch.Fill, SnapsToDevicePixels = true, IsHitTestVisible = false };
                _spriteLayout.Children.Add(image);
                _overlayImgs.Add(image);
            }
            ApplySpriteLayout();
            Mouth(_typer != null && _typer.IsEnabled);
        }

        void Mouth(bool talking)
        {
            // 未声明口型的旧套装可能用了整张 talk.png，只在平静表情时覆盖。
            bool safeLayer = _activeSkin != null && (_curFace == 0 || !string.IsNullOrEmpty(_activeSkin.MouthFile));
            if (_mouthImg != null)
                _mouthImg.Visibility = talking && safeLayer && _mouthImg.Source != null ? Visibility.Visible : Visibility.Collapsed;
        }

        sealed class AlphaMask
        {
            public int Width, Height;
            public byte[] Pixels;
            public double FootX, Bottom, HalfWidth;

            public AlphaMask(ShellImage art)
            {
                Width = art.Base.PixelWidth;
                Height = art.Base.PixelHeight;
                Pixels = new byte[Width * Height];
                foreach (var layer in new[] { art.Base }.Concat(art.Overlays))
                {
                    if (layer.PixelWidth != Width || layer.PixelHeight != Height) continue;
                    var bitmap = new FormatConvertedBitmap(layer, PixelFormats.Bgra32, null, 0);
                    var bgra = new byte[Pixels.Length * 4];
                    bitmap.CopyPixels(bgra, Width * 4, 0);
                    for (int i = 0; i < Pixels.Length; i++)
                        Pixels[i] += (byte)((255 - Pixels[i]) * bgra[i * 4 + 3] / 255);
                }

                int top = Height, bottom = 0, left = Width, right = 0;
                for (int y = 0; y < Height; y++)
                    for (int x = 0; x < Width; x++)
                        if (Pixels[y * Width + x] > HitAlpha)
                        {
                            top = Math.Min(top, y);
                            bottom = Math.Max(bottom, y + 1);
                            left = Math.Min(left, x);
                            right = Math.Max(right, x + 1);
                        }
                if (bottom == 0) { Bottom = Height; FootX = HalfWidth = Width / 2.0; return; }
                int footLeft = Width, footRight = 0;
                int firstFootRow = bottom - Math.Max(1, (bottom - top) / 20);
                for (int y = firstFootRow; y < bottom; y++)
                    for (int x = left; x < right; x++)
                        if (Pixels[y * Width + x] > HitAlpha)
                        {
                            footLeft = Math.Min(footLeft, x);
                            footRight = Math.Max(footRight, x + 1);
                        }
                FootX = (footLeft + footRight) / 2.0;
                Bottom = bottom;
                HalfWidth = Math.Max(FootX - left, right - FootX);
            }
        }

        static void PlaceSpriteLayer(Image image, Rect bounds)
        {
            Canvas.SetLeft(image, bounds.X);
            Canvas.SetTop(image, bounds.Y);
            image.Width = bounds.Width;
            image.Height = bounds.Height;
        }

        void ApplySpriteLayout()
        {
            if (_activeArt == null) { _spriteBounds = Rect.Empty; return; }
            var mask = _activeArt.Mask ?? (_activeArt.Mask = new AlphaMask(_activeArt));
            double scale = Math.Min(ScaledH / mask.Height, ScaledW / Math.Max(mask.Width, mask.HalfWidth * 2));
            _spriteBounds = new Rect(ScaledW / 2 - mask.FootX * scale, ScaledH - mask.Bottom * scale,
                mask.Width * scale, mask.Height * scale);
            PlaceSpriteLayer(_sprite, _spriteBounds);
            PlaceSpriteLayer(_mouthImg, _spriteBounds);
            foreach (var overlay in _overlayImgs) PlaceSpriteLayer(overlay, _spriteBounds);
            var canvas = _activeSkin.CanvasFor(_activeArt);
            var clip = _activeSkin.MouthRect;
            _mouthImg.Clip = clip.IsEmpty ? null : new RectangleGeometry(new Rect(
                clip.X * _spriteBounds.Width / canvas.Width, clip.Y * _spriteBounds.Height / canvas.Height,
                clip.Width * _spriteBounds.Width / canvas.Width, clip.Height * _spriteBounds.Height / canvas.Height));
            PositionBubble();
        }

        double BubbleAnchorX()
        {
            if (_activeArt == null || _spriteBounds.IsEmpty) return ScaledW / 2;
            Rect head;
            if (!_activeSkin.Regions.TryGetValue("head", out head)) return ScaledW / 2;
            double x = (head.X + head.Width / 2) / _activeSkin.CanvasFor(_activeArt).Width;
            return Math.Max(0, Math.Min(ScaledW, _spriteBounds.X + _spriteBounds.Width * x));
        }

        bool IsOpaque(double x, double y)
        {
            if (_activeArt == null || _spriteBounds.IsEmpty || x < 0 || y < 0 ||
                x >= _spriteBounds.Width || y >= _spriteBounds.Height) return false;
            var mask = _activeArt.Mask;
            return mask.Pixels[(int)(y * mask.Height / _spriteBounds.Height) * mask.Width +
                (int)(x * mask.Width / _spriteBounds.Width)] > HitAlpha;
        }

        string RegionAt(Point point)
        {
            if (!IsOpaque(point.X, point.Y)) return "none";
            var canvas = _activeSkin.CanvasFor(_activeArt);
            var art = new Point(point.X * canvas.Width / _spriteBounds.Width, point.Y * canvas.Height / _spriteBounds.Height);
            foreach (string key in ShellRegions)
            {
                Rect region;
                if (_activeSkin.Regions.TryGetValue(key, out region) && region.Contains(art)) return key;
            }
            return _activeSkin.Regions.Count == 0 && art.Y < canvas.Height * 0.26 ? "head" : "body";
        }
    }
}
