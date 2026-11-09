// tools/ImageTool.cs — 伪春菜美术后处理小工具（.NET Framework，用 csc.exe 编译）
//
// 编译：
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /optimize+ ^
//     /target:exe /out:tools\ImageTool.exe /r:System.Drawing.dll tools\ImageTool.cs
//
// 用法：
//   ImageTool matte  <in.png> <out.png> [tol=40] [erode=1]
//   ImageTool resize <in.png> <out.png> <w> <h> [contain|cover|stretch]
//   ImageTool trim   <in.png> <out.png> [pad=0]
//   ImageTool croprel <in.png> <out.png> <x0> <y0> <x1> <y1>   // 0~1 比例裁剪
//   ImageTool info   <in.png>
//
// 说明：matte 从四条边做 flood fill，只删除「与边缘连通的背景色」，
//       所以角色身上的白衬衫不会被挖掉；再腐蚀 1px + alpha 模糊，去掉白边。

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.Runtime.InteropServices;

static class ImageTool
{
    static int Main(string[] args)
    {
        if (args.Length < 2)
        {
            Console.Error.WriteLine("usage: ImageTool <matte|resize|trim|croprel|info> <in> <out> [..]");
            return 2;
        }
        try
        {
            switch (args[0])
            {
                case "matte": return Matte(args);
                case "resize": return Resize(args);
                case "trim": return Trim(args);
                case "croprel": return CropRel(args);
                case "crop": return Crop(args);
                case "paste": return Paste(args);
                case "bandmask": return BandMask(args);
                case "info": return Info(args);
                default:
                    Console.Error.WriteLine("unknown command: " + args[0]);
                    return 2;
            }
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("ERR " + e.GetType().Name + ": " + e.Message);
            return 1;
        }
    }

    // ---------- 通用 ----------

    static Bitmap Load(string path)
    {
        using (Image src = Image.FromFile(path))
        {
            Bitmap bmp = new Bitmap(src.Width, src.Height, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.CompositingMode = System.Drawing.Drawing2D.CompositingMode.SourceCopy;
                g.DrawImage(src, new Rectangle(0, 0, src.Width, src.Height));
            }
            return bmp;
        }
    }

    static int[] GetPixels(Bitmap bmp, out BitmapData data)
    {
        data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height),
            ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
        int n = bmp.Width * bmp.Height;
        int[] px = new int[n];
        Marshal.Copy(data.Scan0, px, 0, n);
        return px;
    }

    static void SetPixels(Bitmap bmp, BitmapData data, int[] px)
    {
        Marshal.Copy(px, 0, data.Scan0, px.Length);
        bmp.UnlockBits(data);
    }

    // ---------- matte ----------

    static int Matte(string[] args)
    {
        string inPath = args[1], outPath = args[2];
        int tol = args.Length > 3 ? int.Parse(args[3]) : 40;
        int erode = args.Length > 4 ? int.Parse(args[4]) : 1;

        Bitmap bmp = Load(inPath);
        int w = bmp.Width, h = bmp.Height;
        BitmapData data;
        int[] px = GetPixels(bmp, out data);

        // 背景色 = 四角 7x7 采样均值
        long sr = 0, sg = 0, sb = 0; int sn = 0;
        int[,] corners = { { 0, 0 }, { w - 7, 0 }, { 0, h - 7 }, { w - 7, h - 7 } };
        for (int c = 0; c < 4; c++)
        {
            for (int y = 0; y < 7; y++)
            {
                for (int x = 0; x < 7; x++)
                {
                    int i = (corners[c, 1] + y) * w + (corners[c, 0] + x);
                    if (i < 0 || i >= px.Length) continue;
                    int v = px[i];
                    sb += v & 0xFF; sg += (v >> 8) & 0xFF; sr += (v >> 16) & 0xFF; sn++;
                }
            }
        }
        double br = (double)sr / sn, bg = (double)sg / sn, bb = (double)sb / sn;

        // flood fill：只从四边连通区域删背景
        // 种子：四边且接近全局背景色（防止角色伸到边缘的部分被吃）
        // 扩展：与来源像素色差 < localTol（允许渐变/光晕背景被逐层吃掉）
        int localTol = args.Length > 6 ? int.Parse(args[6]) : 16;
        long localTol2 = (long)localTol * localTol * 3;
        int driftTol = args.Length > 7 ? int.Parse(args[7]) : 44;
        long driftTol2 = (long)driftTol * driftTol * 3;
        bool[] isBg = new bool[w * h];
        int[] stackIdx = new int[w * h];
        int[] stackFrom = new int[w * h];
        int[] rootCol = new int[w * h];
        int sp = 0;
        long tol2 = (long)tol * tol * 3;
        for (int x = 0; x < w; x++) { TrySeed(px, isBg, stackIdx, stackFrom, rootCol, ref sp, x, br, bg, bb, tol2); TrySeed(px, isBg, stackIdx, stackFrom, rootCol, ref sp, (h - 1) * w + x, br, bg, bb, tol2); }
        for (int y = 0; y < h; y++) { TrySeed(px, isBg, stackIdx, stackFrom, rootCol, ref sp, y * w, br, bg, bb, tol2); TrySeed(px, isBg, stackIdx, stackFrom, rootCol, ref sp, y * w + w - 1, br, bg, bb, tol2); }

        while (sp > 0)
        {
            int i = stackIdx[--sp];
            int from = stackFrom[sp];
            if (isBg[i]) continue;
            if (ColorDist2From(px[i], px[from]) > localTol2) continue;
            // 累计漂移上限：防止沿渐变一路吃到角色身上
            if (ColorDist2From(px[i], rootCol[i]) > driftTol2) continue;
            isBg[i] = true;
            int root = rootCol[i];
            int x = i % w, y = i / w;
            if (x > 0 && !isBg[i - 1]) { stackIdx[sp] = i - 1; stackFrom[sp] = i; rootCol[i - 1] = root; sp++; }
            if (x < w - 1 && !isBg[i + 1]) { stackIdx[sp] = i + 1; stackFrom[sp] = i; rootCol[i + 1] = root; sp++; }
            if (y > 0 && !isBg[i - w]) { stackIdx[sp] = i - w; stackFrom[sp] = i; rootCol[i - w] = root; sp++; }
            if (y < h - 1 && !isBg[i + w]) { stackIdx[sp] = i + w; stackFrom[sp] = i; rootCol[i + w] = root; sp++; }
        }

        // 清除被前景包住的小块背景（例如手臂与笔记本之间的缝）
        // 只清「面积 < holesPct% 且 85% 以上像素接近背景色」的连通域，白衬衫不会被误杀
        double holesPct = args.Length > 5 ? double.Parse(args[5]) : 1.5;
        if (holesPct > 0) KillSmallHoles(px, ref isBg, w, h, br, bg, bb, tol, holesPct / 100.0 * w * h);

        // 腐蚀前景，去掉白边
        for (int k = 0; k < erode; k++) Erode(ref isBg, w, h);

        // alpha 图 + 3x3 模糊做软边
        byte[] alpha = new byte[w * h];
        for (int i = 0; i < alpha.Length; i++) alpha[i] = isBg[i] ? (byte)0 : (byte)255;
        byte[] blurred = BlurAlpha(alpha, w, h);

        int kept = 0;
        for (int i = 0; i < px.Length; i++)
        {
            int v = px[i];
            int a = blurred[i];
            if (a > 250) a = 255;
            if (a == 0) { px[i] = 0; continue; }
            kept++;
            px[i] = (a << 24) | (v & 0x00FFFFFF);
        }

        SetPixels(bmp, data, px);
        bmp.Save(outPath, ImageFormat.Png);
        bmp.Dispose();
        Console.WriteLine(string.Format("matte ok {0} bg=({1:0},{2:0},{3:0}) tol={4} keep={5:0.0}%",
            outPath, br, bg, bb, tol, 100.0 * kept / px.Length));
        return 0;
    }

    static void TrySeed(int[] px, bool[] isBg, int[] stackIdx, int[] stackFrom, int[] rootCol, ref int sp, int i, double br, double bg, double bb, long tol2)
    {
        if (isBg[i]) return;
        if (ColorDist2(px[i], br, bg, bb) > tol2) return;
        stackIdx[sp] = i;
        stackFrom[sp] = i;
        rootCol[i] = px[i];
        sp++;
    }

    static long ColorDist2From(int a, int b)
    {
        double dr = ((a >> 16) & 0xFF) - ((b >> 16) & 0xFF);
        double dg = ((a >> 8) & 0xFF) - ((b >> 8) & 0xFF);
        double db = (a & 0xFF) - (b & 0xFF);
        return (long)(dr * dr + dg * dg + db * db);
    }

    static long ColorDist2(int v, double br, double bg, double bb)
    {
        double dr = ((v >> 16) & 0xFF) - br;
        double dg = ((v >> 8) & 0xFF) - bg;
        double db = (v & 0xFF) - bb;
        return (long)(dr * dr + dg * dg + db * db);
    }

    static void KillSmallHoles(int[] px, ref bool[] isBg, int w, int h, double br, double bg, double bb, int tol, double maxArea)
    {
        bool[] seen = new bool[w * h];
        List<int> region = new List<int>(4096);
        List<int> queue = new List<int>(4096);
        long tol2 = (long)tol * tol * 3;
        for (int i = 0; i < px.Length; i++)
        {
            if (isBg[i] || seen[i]) continue;
            region.Clear(); queue.Clear();
            queue.Add(i); seen[i] = true;
            int near = 0;
            int head = 0;
            while (head < queue.Count)
            {
                int j = queue[head++];
                region.Add(j);
                if (ColorDist2(px[j], br, bg, bb) <= tol2) near++;
                if (region.Count > maxArea) { head = queue.Count; break; } // 太大，放弃
                int x = j % w, y = j / w;
                if (x > 0 && !isBg[j - 1] && !seen[j - 1]) { seen[j - 1] = true; queue.Add(j - 1); }
                if (x < w - 1 && !isBg[j + 1] && !seen[j + 1]) { seen[j + 1] = true; queue.Add(j + 1); }
                if (y > 0 && !isBg[j - w] && !seen[j - w]) { seen[j - w] = true; queue.Add(j - w); }
                if (y < h - 1 && !isBg[j + w] && !seen[j + w]) { seen[j + w] = true; queue.Add(j + w); }
            }
            if (region.Count > maxArea || region.Count == 0) continue;
            if ((double)near / region.Count < 0.85) continue;
            for (int k = 0; k < region.Count; k++) isBg[region[k]] = true;
        }
    }

    static void Erode(ref bool[] isBg, int w, int h)    {
        bool[] copy = (bool[])isBg.Clone();
        for (int y = 1; y < h - 1; y++)
        {
            for (int x = 1; x < w - 1; x++)
            {
                int i = y * w + x;
                if (copy[i]) continue;
                if (copy[i - 1] || copy[i + 1] || copy[i - w] || copy[i + w]) isBg[i] = true;
            }
        }
    }

    static byte[] BlurAlpha(byte[] a, int w, int h)
    {
        byte[] o = new byte[a.Length];
        for (int y = 0; y < h; y++)
        {
            for (int x = 0; x < w; x++)
            {
                int sum = 0, cnt = 0;
                for (int dy = -1; dy <= 1; dy++)
                {
                    int yy = y + dy; if (yy < 0 || yy >= h) continue;
                    for (int dx = -1; dx <= 1; dx++)
                    {
                        int xx = x + dx; if (xx < 0 || xx >= w) continue;
                        sum += a[yy * w + xx]; cnt++;
                    }
                }
                o[y * w + x] = (byte)(sum / cnt);
            }
        }
        return o;
    }

    // ---------- resize ----------

    static int Resize(string[] args)
    {
        string inPath = args[1], outPath = args[2];
        int tw = int.Parse(args[3]), th = int.Parse(args[4]);
        string mode = args.Length > 5 ? args[5] : "contain";

        Bitmap src = Load(inPath);
        Bitmap dst = new Bitmap(tw, th, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(dst))
        {
            g.CompositingMode = System.Drawing.Drawing2D.CompositingMode.SourceCopy;
            g.CompositingQuality = System.Drawing.Drawing2D.CompositingQuality.HighQuality;
            g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.HighQuality;
            g.Clear(Color.Transparent);

            double sx = (double)tw / src.Width, sy = (double)th / src.Height;
            double s = mode == "cover" ? Math.Max(sx, sy) : mode == "stretch" ? 0 : Math.Min(sx, sy);
            int dw, dh;
            if (mode == "stretch") { dw = tw; dh = th; }
            else { dw = Math.Max(1, (int)Math.Round(src.Width * s)); dh = Math.Max(1, (int)Math.Round(src.Height * s)); }
            int dx0 = (tw - dw) / 2, dy0 = th - dh; // 底对齐，脚贴着底边
            if (mode == "contain") dy0 = (th - dh) / 2;
            g.DrawImage(src, new Rectangle(dx0, dy0, dw, dh));
        }
        src.Dispose();
        dst.Save(outPath, ImageFormat.Png);
        dst.Dispose();
        Console.WriteLine("resize ok " + outPath + " " + tw + "x" + th + " " + mode);
        return 0;
    }

    // ---------- trim ----------

    static int Trim(string[] args)
    {
        string inPath = args[1], outPath = args[2];
        int pad = args.Length > 3 ? int.Parse(args[3]) : 0;
        Bitmap bmp = Load(inPath);
        int w = bmp.Width, h = bmp.Height;
        BitmapData data;
        int[] px = GetPixels(bmp, out data);
        bmp.UnlockBits(data);

        int minX = w, minY = h, maxX = -1, maxY = -1;
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
            {
                int a = (px[y * w + x] >> 24) & 0xFF;
                if (a > 8)
                {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        if (maxX < 0) { Console.Error.WriteLine("trim: 全透明"); return 1; }
        minX = Math.Max(0, minX - pad); minY = Math.Max(0, minY - pad);
        maxX = Math.Min(w - 1, maxX + pad); maxY = Math.Min(h - 1, maxY + pad);
        Rectangle rc = new Rectangle(minX, minY, maxX - minX + 1, maxY - minY + 1);
        Bitmap outBmp = bmp.Clone(rc, PixelFormat.Format32bppArgb);
        bmp.Dispose();
        outBmp.Save(outPath, ImageFormat.Png);
        Console.WriteLine("trim ok " + outPath + " " + rc.Width + "x" + rc.Height);
        outBmp.Dispose();
        return 0;
    }

    // ---------- croprel ----------

    /// <summary>按比例裁剪：croprel in out x0 y0 x1 y1（0~1，按左上原点），用来把全身立绘切到半身</summary>
    static int CropRel(string[] args)
    {
        string inPath = args[1], outPath = args[2];
        double fx0 = double.Parse(args[3], CultureInfo.InvariantCulture);
        double fy0 = double.Parse(args[4], CultureInfo.InvariantCulture);
        double fx1 = double.Parse(args[5], CultureInfo.InvariantCulture);
        double fy1 = double.Parse(args[6], CultureInfo.InvariantCulture);

        Bitmap bmp = Load(inPath);
        int w = bmp.Width, h = bmp.Height;
        int x0 = (int)Math.Round(Math.Min(fx0, fx1) * w);
        int y0 = (int)Math.Round(Math.Min(fy0, fy1) * h);
        int x1 = (int)Math.Round(Math.Max(fx0, fx1) * w);
        int y1 = (int)Math.Round(Math.Max(fy0, fy1) * h);
        x0 = Math.Max(0, Math.Min(w - 1, x0));
        y0 = Math.Max(0, Math.Min(h - 1, y0));
        x1 = Math.Max(x0 + 1, Math.Min(w, x1));
        y1 = Math.Max(y0 + 1, Math.Min(h, y1));
        Rectangle rc = new Rectangle(x0, y0, x1 - x0, y1 - y0);
        Bitmap outBmp = bmp.Clone(rc, PixelFormat.Format32bppArgb);
        bmp.Dispose();
        outBmp.Save(outPath, ImageFormat.Png);
        Console.WriteLine("croprel ok " + outPath + " " + rc.Width + "x" + rc.Height);
        outBmp.Dispose();
        return 0;
    }

    // ---------- crop（像素坐标裁剪）----------

    static int Crop(string[] args)
    {
        string inPath = args[1], outPath = args[2];
        int x = int.Parse(args[3]), y = int.Parse(args[4]);
        int w = int.Parse(args[5]), h = int.Parse(args[6]);

        Bitmap bmp = Load(inPath);
        int W = bmp.Width, H = bmp.Height;
        x = Math.Max(0, Math.Min(W - 1, x));
        y = Math.Max(0, Math.Min(H - 1, y));
        w = Math.Max(1, Math.Min(W - x, w));
        h = Math.Max(1, Math.Min(H - y, h));
        Bitmap outBmp = bmp.Clone(new Rectangle(x, y, w, h), PixelFormat.Format32bppArgb);
        bmp.Dispose();
        outBmp.Save(outPath, ImageFormat.Png);
        Console.WriteLine("crop ok " + outPath + " " + w + "x" + h + " @" + x + "," + y);
        outBmp.Dispose();
        return 0;
    }

    // ---------- paste（把 patch 羽化贴回 base 的 (x,y)，用于只改脸）----------

    static int Paste(string[] args)
    {
        string basePath = args[1], patchPath = args[2], outPath = args[3];
        int ox = int.Parse(args[4]), oy = int.Parse(args[5]);
        double feather = args.Length > 6 ? double.Parse(args[6], CultureInfo.InvariantCulture) : 12;
        if (feather < 0.5) feather = 0.5;

        Bitmap baseBmp = Load(basePath);
        Bitmap patchBmp = Load(patchPath);
        int bw = baseBmp.Width, bh = baseBmp.Height;
        int pw = patchBmp.Width, ph = patchBmp.Height;

        BitmapData bd; int[] bp = GetPixels(baseBmp, out bd);
        BitmapData pd; int[] pp = GetPixels(patchBmp, out pd);
        patchBmp.UnlockBits(pd);

        double minEdge = Math.Min(pw, ph) * 0.35;
        if (feather > minEdge) feather = minEdge;

        // 先算一次色差：patch 内部均值 vs base 同位置均值，整体平移颜色，避免贴上去一块白/黄
        double sbr = 0, sbg = 0, sbb = 0, spr = 0, spg = 0, spb = 0;
        int cnt = 0;
        for (int j = 0; j < ph; j++)
        {
            int by = oy + j;
            if (by < 0 || by >= bh) continue;
            for (int i = 0; i < pw; i++)
            {
                int bx = ox + i;
                if (bx < 0 || bx >= bw) continue;
                double d = Math.Min(Math.Min(i, pw - 1 - i), Math.Min(j, ph - 1 - j));
                if (d < feather * 1.5) continue;
                int src = pp[j * pw + i];
                if (((src >> 24) & 0xFF) < 200) continue;
                int dst = bp[by * bw + bx];
                if (((dst >> 24) & 0xFF) < 250) continue;
                sbr += (dst >> 16) & 0xFF; sbg += (dst >> 8) & 0xFF; sbb += dst & 0xFF;
                spr += (src >> 16) & 0xFF; spg += (src >> 8) & 0xFF; spb += src & 0xFF;
                cnt++;
            }
        }
        double kr = 0, kg = 0, kb = 0;
        if (cnt > 200)
        {
            kr = (sbr - spr) / cnt; kg = (sbg - spg) / cnt; kb = (sbb - spb) / cnt;
            kr = Math.Max(-24, Math.Min(24, kr));
            kg = Math.Max(-24, Math.Min(24, kg));
            kb = Math.Max(-24, Math.Min(24, kb));
            Console.WriteLine("  tone shift r=" + kr.ToString("0.0", CultureInfo.InvariantCulture) + " g=" + kg.ToString("0.0", CultureInfo.InvariantCulture) + " b=" + kb.ToString("0.0", CultureInfo.InvariantCulture) + " n=" + cnt);
        }

        for (int j = 0; j < ph; j++)
        {
            int by = oy + j;
            if (by < 0 || by >= bh) continue;
            for (int i = 0; i < pw; i++)
            {
                int bx = ox + i;
                if (bx < 0 || bx >= bw) continue;
                int src = pp[j * pw + i];
                int sa = (src >> 24) & 0xFF;
                if (sa == 0) continue;
                double d = Math.Min(Math.Min(i, pw - 1 - i), Math.Min(j, ph - 1 - j));
                double t = d / feather;
                if (t > 1) t = 1;
                double ease = t * t * (3 - 2 * t);
                int dstA = (bp[by * bw + bx] >> 24) & 0xFF;
                // 只在原图本来就不透明的地方贴（生成出来的背景是黑块，不能盖上去）
                double cover = Math.Min(1.0, dstA / 200.0);
                double a = sa / 255.0 * ease * cover;
                if (a <= 0.0001) continue;

                int bi = by * bw + bx;
                int dst = bp[bi];
                int dr = (dst >> 16) & 0xFF, dg = (dst >> 8) & 0xFF, db = dst & 0xFF;
                int da = (dst >> 24) & 0xFF;
                int sr = (src >> 16) & 0xFF, sg = (src >> 8) & 0xFF, sb = src & 0xFF;
                if (cnt > 200)
                {
                    sr = Math.Max(0, Math.Min(255, (int)Math.Round(sr + kr)));
                    sg = Math.Max(0, Math.Min(255, (int)Math.Round(sg + kg)));
                    sb = Math.Max(0, Math.Min(255, (int)Math.Round(sb + kb)));
                }
                int r = (int)Math.Round(sr * a + dr * (1 - a));
                int g = (int)Math.Round(sg * a + dg * (1 - a));
                int b = (int)Math.Round(sb * a + db * (1 - a));
                double oa = a + da / 255.0 * (1 - a);
                int aa = (int)Math.Round(oa * 255);
                if (aa < 0) aa = 0; if (aa > 255) aa = 255;
                bp[bi] = (aa << 24) | (r << 16) | (g << 8) | b;
            }
        }

        SetPixels(baseBmp, bd, bp);
        baseBmp.Save(outPath, ImageFormat.Png);
        Console.WriteLine("paste ok " + outPath + " patch=" + pw + "x" + ph + " @" + ox + "," + oy + " feather=" + feather.ToString("0.0", CultureInfo.InvariantCulture));
        baseBmp.Dispose();
        patchBmp.Dispose();
        return 0;
    }

    // ---------- bandmask（生成横向白条蒙版，给 ComfyUI 的 SetLatentNoiseMask 用）----------

    static int BandMask(string[] args)
    {
        string outPath = args[1];
        int w = int.Parse(args[2]), h = int.Parse(args[3]);
        int y0 = int.Parse(args[4]), y1 = int.Parse(args[5]);
        double feather = args.Length > 6 ? double.Parse(args[6], CultureInfo.InvariantCulture) : 10;
        if (feather < 0.5) feather = 0.5;
        if (y1 < y0) { int t = y0; y0 = y1; y1 = t; }

        using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
        {
            BitmapData d = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
            int[] px = new int[w * h];
            for (int y = 0; y < h; y++)
            {
                double v;
                if (y < y0 - feather || y > y1 + feather) v = 0;
                else if (y >= y0 && y <= y1) v = 1;
                else
                {
                    double dist = y < y0 ? (y0 - y) : (y - y1);
                    double t = 1 - dist / feather;
                    v = t * t * (3 - 2 * t);
                }
                int a = (int)Math.Round(v * 255);
                int col = (255 << 24) | (a << 16) | (a << 8) | a;
                for (int x = 0; x < w; x++) px[y * w + x] = col;
            }
            Marshal.Copy(px, 0, d.Scan0, px.Length);
            bmp.UnlockBits(d);
            bmp.Save(outPath, ImageFormat.Png);
        }
        Console.WriteLine("bandmask ok " + outPath + " " + w + "x" + h + " band=" + y0 + ".." + y1 + " feather=" + feather.ToString("0.0", CultureInfo.InvariantCulture));
        return 0;
    }

    // ---------- info ----------

    static int Info(string[] args)
    {
        Bitmap bmp = Load(args[1]);
        int w = bmp.Width, h = bmp.Height;
        BitmapData data;
        int[] px = GetPixels(bmp, out data);
        bmp.UnlockBits(data);
        int opaque = 0, semi = 0, trans = 0;
        for (int i = 0; i < px.Length; i++)
        {
            int a = (px[i] >> 24) & 0xFF;
            if (a > 250) opaque++; else if (a == 0) trans++; else semi++;
        }
        Console.WriteLine(w + "x" + h + " opaque=" + (100.0 * opaque / px.Length).ToString("0.0") + "% semi=" + (100.0 * semi / px.Length).ToString("0.0") + "% transparent=" + (100.0 * trans / px.Length).ToString("0.0") + "%");
        bmp.Dispose();
        return 0;
    }
}
