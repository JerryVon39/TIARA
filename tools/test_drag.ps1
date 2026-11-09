# tools/test_drag.ps1
# Drag acceptance test: synthesize press + 800px/s horizontal drag, measure follow error.
# Usage: node tools/build_pet.mjs ; powershell -NoProfile -File tools/test_drag.ps1
# PASS when maxErr <= 4 DIP and total displacement matches (the old build lagged and lost distance).

param(
    [int]$Steps = 24,
    [int]$StepPx = 16,
    [int]$DelayMs = 25
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DragProbe {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr e);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string t);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    public delegate bool EnumProc(IntPtr h, IntPtr p);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    // Pet.exe uses ShowInTaskbar=false + WindowStyle=None, so MainWindowTitle is empty:
    // pick the biggest visible top-level window owned by that pid instead.
    public static IntPtr Best;
    public static int BestArea;
    public static IntPtr FindPetWindow(uint wantPid) {
        Best = IntPtr.Zero; BestArea = 0;
        EnumWindows(delegate(IntPtr h, IntPtr p) {
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (pid != wantPid || !IsWindowVisible(h)) return true;
            RECT r; if (!GetWindowRect(h, out r)) return true;
            int cw = r.Right - r.Left, ch = r.Bottom - r.Top;
            if (cw <= 0 || ch <= 0) return true;
            if (cw * ch > BestArea) { BestArea = cw * ch; Best = h; }
            return true;
        }, IntPtr.Zero);
        return Best;
    }
}
"@

$proc = Get-Process Pet -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $proc) {
    Write-Output "FAIL Pet.exe not running (start it first)"
    exit 1
}
$w = 0; $hh = 0
$h = [DragProbe]::FindPetWindow([uint32]$proc.Id)
if ($h -eq [IntPtr]::Zero) {
    Write-Output "FAIL pet window not found for pid $($proc.Id)"
    exit 1
}
$rr = New-Object DragProbe+RECT
[DragProbe]::GetWindowRect($h, [ref]$rr) | Out-Null
$w = $rr.Right - $rr.Left; $hh = $rr.Bottom - $rr.Top
Write-Output "window pid=$($proc.Id) size=${w}x${hh} at $($rr.Left),$($rr.Top)"

$r = New-Object DragProbe+RECT
[DragProbe]::GetWindowRect($h, [ref]$r) | Out-Null
$cx = [int](($r.Left + $r.Right) / 2)
$cy = [int](($r.Top + $r.Bottom) / 2)

$offX = $cx - $r.Left
$offY = $cy - $r.Top

# 屏幕边缘会让 SetCursorPos 被裁剪，测出来像"拖不动"：先看哪边有空间就往哪边拖
$screenW = [int]([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width * 1.25)
$need = [math]::Abs($Steps * $StepPx)
$dir = 1
if (($screenW - $r.Right) -lt ($need + 40)) { $dir = -1 }
$StepPx = [math]::Abs($StepPx) * $dir
Write-Output ("drag dir={0} need={1}px rightGap={2}px" -f $dir, $need, ($screenW - $r.Right))

[DragProbe]::SetCursorPos($cx, $cy) | Out-Null
Start-Sleep -Milliseconds 120
[DragProbe]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 120

$maxErr = 0.0
[DragProbe]::GetWindowRect($h, [ref]$r) | Out-Null
$left0 = $r.Left
for ($i = 1; $i -le $Steps; $i++) {
    $cx += $StepPx
    [DragProbe]::SetCursorPos($cx, $cy) | Out-Null
    Start-Sleep -Milliseconds $DelayMs
    [DragProbe]::GetWindowRect($h, [ref]$r) | Out-Null
    $expect = $cx - $offX
    $err = [math]::Abs($r.Left - $expect)
    if ($err -gt $maxErr) { $maxErr = $err }
}

[DragProbe]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 200
[DragProbe]::GetWindowRect($h, [ref]$r) | Out-Null
$movedX = $r.Left - $left0
$expectTotal = $Steps * $StepPx

$ok = ($maxErr -le 4) -and ([math]::Abs($movedX - $expectTotal) -le 8)
Write-Output ("moved={0}px expected={1}px maxErr={2}px" -f $movedX, $expectTotal, [math]::Round($maxErr, 1))
if ($ok) { Write-Output "PASS drag follows cursor" } else { Write-Output "FAIL drag lag or lost distance" }
if (-not $ok) { exit 1 }
