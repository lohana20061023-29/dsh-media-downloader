param(
  [Parameter(Mandatory = $true)][string]$Base,
  [int]$IntervalMs = 250,
  [int]$Seconds = 8
)

# 单进程：监听剪贴板 + 显示角落提示窗；窗口只建一次，之后复用（避免每次 600ms 的创建开销）
$log = Join-Path $env:TEMP 'dsh-corner-watch.log'
function Log($m) { "[$([DateTime]::Now.ToString('HH:mm:ss.fff'))] $m" | Out-File -FilePath $log -Append -Encoding utf8 }

$mutex = New-Object System.Threading.Mutex($false, 'Global\dsh-media-corner-watch')
if (-not $mutex.WaitOne(0)) { exit 0 }

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Xaml, System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Clip {
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
}
public class Dwm {
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
}
"@
[void][System.Windows.Forms.Screen]::PrimaryScreen

$themeFile = Join-Path $env:TEMP 'dsh-corner-theme.json'
$enabledFile = Join-Path $env:TEMP 'dsh-toast-enabled.txt'
$hb = Join-Path $env:TEMP 'dsh-corner-watch.hb'

$pattern = 'https?://[^\s"''<>]+'
$platform = '(bilibili\.com|b23\.tv|xiaohongshu\.com|xhslink\.(com|cn)|douyin\.com|youtube\.com|youtu\.be|x\.com|twitter\.com|tiktok\.com|vimeo\.com)'

$W = 244; $H = 56
$script:win = $null
$script:parts = $null
$script:hideTimer = $null
$script:currentUrl = ''

function Read-Theme {
  $t = @{ accent = '#2F6BEF'; bg = ''; fg = ''; sub = ''; border = ''; font = '' }
  try {
    if (Test-Path $themeFile) {
      $j = Get-Content $themeFile -Raw -Encoding UTF8 | ConvertFrom-Json
      foreach ($k in @('accent', 'bg', 'fg', 'sub', 'border', 'font')) {
        if ($j.$k) { $t[$k] = $j.$k }
      }
    }
  } catch { }
  return $t
}

function Build-Window {
  $win = New-Object System.Windows.Window
  $win.WindowStyle = 'None'
  $win.ResizeMode = 'NoResize'
  $win.Topmost = $true
  $win.ShowInTaskbar = $false
  $win.Width = $W; $win.Height = $H
  $win.Cursor = [System.Windows.Input.Cursors]::Hand

  $border = New-Object System.Windows.Controls.Border
  $border.CornerRadius = 10
  $border.BorderThickness = 1
  $win.Content = $border

  $grid = New-Object System.Windows.Controls.Grid
  $grid.Margin = '10,0,8,0'
  $border.Child = $grid

  $cd0 = New-Object System.Windows.Controls.ColumnDefinition
  $cd0.Width = [System.Windows.GridLength]::new(30)
  $cd1 = New-Object System.Windows.Controls.ColumnDefinition
  $cd1.Width = [System.Windows.GridLength]::new(1, [System.Windows.GridUnitType]::Star)
  $cd2 = New-Object System.Windows.Controls.ColumnDefinition
  $cd2.Width = [System.Windows.GridLength]::new(20)
  [void]$grid.ColumnDefinitions.Add($cd0)
  [void]$grid.ColumnDefinitions.Add($cd1)
  [void]$grid.ColumnDefinitions.Add($cd2)

  $icon = New-Object System.Windows.Controls.Border
  $icon.Width = 24; $icon.Height = 24
  $icon.CornerRadius = 7
  $icon.VerticalAlignment = 'Center'
  $glyph = New-Object System.Windows.Controls.TextBlock
  $glyph.Text = [char]0xE896
  $glyph.FontFamily = New-Object System.Windows.Media.FontFamily('Segoe MDL2 Assets')
  $glyph.FontSize = 15
  $glyph.Foreground = [System.Windows.Media.Brushes]::White
  $glyph.HorizontalAlignment = 'Center'; $glyph.VerticalAlignment = 'Center'
  $icon.Child = $glyph
  [System.Windows.Controls.Grid]::SetColumn($icon, 0)
  [void]$grid.Children.Add($icon)

  $text = New-Object System.Windows.Controls.TextBlock
  $text.Text = '检测到链接，点此打开'
  $text.FontSize = 13
  $text.VerticalAlignment = 'Center'
  $text.Margin = '10,0,4,0'
  [System.Windows.Controls.Grid]::SetColumn($text, 1)
  [void]$grid.Children.Add($text)

  $close = New-Object System.Windows.Controls.Button
  $close.Content = [char]0x2715
  $close.FontSize = 11
  $close.Width = 18; $close.Height = 18
  $close.BorderThickness = 0
  $close.Background = [System.Windows.Media.Brushes]::Transparent
  $close.VerticalAlignment = 'Center'
  [System.Windows.Controls.Grid]::SetColumn($close, 2)
  [void]$grid.Children.Add($close)

  $close.Add_Click({ if ($script:hideTimer) { $script:hideTimer.Stop() }; if ($script:win) { $script:win.Hide() } })

  $border.Add_MouseLeftButtonUp({
    try {
      $body = @{ url = $script:currentUrl } | ConvertTo-Json -Compress
      Invoke-RestMethod -Uri "http://$Base/bili-dl/toast/open" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 8 | Out-Null
    } catch { }
    if ($script:hideTimer) { $script:hideTimer.Stop() }
    if ($script:win) { $script:win.Hide() }
  })

  $win.Left = -4000; $win.Top = -4000
  $win.Show()
  $win.Hide()
  $hwnd = (New-Object System.Windows.Interop.WindowInteropHelper($win)).Handle
  $round = 2
  try { [void][Dwm]::DwmSetWindowAttribute($hwnd, 33, [ref]$round, 4) } catch { }

  return @{ win = $win; border = $border; icon = $icon; text = $text; close = $close }
}

function Show-Toast([string]$url) {
  $theme = Read-Theme

  $light = $true
  try {
    $v = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name AppsUseLightTheme -ErrorAction Stop
    $light = [int]$v.AppsUseLightTheme -ne 0
  } catch { }

  $cBg = if ($theme.bg) { $theme.bg } elseif ($light) { '#FFFFFF' } else { '#23262B' }
  $cBorder = if ($theme.border) { $theme.border } elseif ($light) { '#D3DDED' } else { '#3A3F46' }
  $cText = if ($theme.fg) { $theme.fg } elseif ($light) { '#16233A' } else { '#F2F5F9' }
  $cSub = if ($theme.sub) { $theme.sub } elseif ($light) { '#5B6B82' } else { '#9BA7B6' }
  $cAccent = $theme.accent

  $p = $script:parts
  if (-not $p) { return }

  $p.win.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString($cBg)
  $p.border.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString($cBg)
  $p.border.BorderBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString($cBorder)
  $p.icon.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString($cAccent)
  $p.text.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString($cText)
  $p.close.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString($cSub)

  if ($theme.font) {
    $fontName = ($theme.font -split ',')[0].Trim().Trim('"').Trim("'")
    if ($fontName) { try { $p.win.FontFamily = New-Object System.Windows.Media.FontFamily($fontName) } catch { } }
  }

  $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $sx = [System.Windows.Media.VisualTreeHelper]::GetDpi($p.win).DpiScaleX
  $targetLeft = ($wa.Right / $sx) - $W - 16
  $targetTop = ($wa.Bottom / $sx) - $H - 16

  $p.win.Top = $targetTop
  $p.win.Left = $targetLeft + 42
  $p.win.Show()
  $p.win.Activate() | Out-Null

  $anim = New-Object System.Windows.Media.Animation.DoubleAnimation
  $anim.From = $targetLeft + 42
  $anim.To = $targetLeft
  $anim.Duration = [System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(200))
  $ease = New-Object System.Windows.Media.Animation.CubicEase
  $ease.EasingMode = 'EaseOut'
  $anim.EasingFunction = $ease
  $p.win.BeginAnimation([System.Windows.Window]::LeftProperty, $anim)

  if ($script:hideTimer) { $script:hideTimer.Stop(); $script:hideTimer = $null }
  $script:hideTimer = New-Object System.Windows.Threading.DispatcherTimer
  $script:hideTimer.Interval = [TimeSpan]::FromSeconds($Seconds)
  $script:hideTimer.Add_Tick({ $script:hideTimer.Stop(); if ($script:win) { $script:win.Hide() } })
  $script:hideTimer.Start()

  Log "show url=$url accent=$cAccent"
}

try { $script:parts = Build-Window; $script:win = $script:parts.win; Log 'window ready' }
catch { Log "build failed: $($_.Exception.Message)" }

$script:lastSeq = [Clip]::GetClipboardSequenceNumber()
$script:lastUrl = ''
$script:timer = New-Object System.Windows.Threading.DispatcherTimer
$script:timer.Interval = [TimeSpan]::FromMilliseconds($IntervalMs)
$script:timer.Add_Tick({
  try {
    [System.IO.File]::WriteAllText($hb, [string][DateTime]::Now.Ticks)
    $seq = [Clip]::GetClipboardSequenceNumber()
    if ($seq -eq $script:lastSeq) { return }
    $script:lastSeq = $seq

    $text = ''
    try { $text = Get-Clipboard -Raw -ErrorAction Stop } catch { return }
    if (-not $text) { return }
    $text = $text.Trim()
    if ($text.Length -gt 4096) { return }
    if ($text -notmatch $platform) { return }

    $m = [regex]::Match($text, $pattern)
    if (-not $m.Success) { return }
    $url = $m.Value
    # 插件设置里关掉「复制时提示」时，连窗口都不弹
    try {
      if (Test-Path $enabledFile) {
        $flag = (Get-Content $enabledFile -Raw -ErrorAction Stop).Trim()
        if ($flag -eq '0') { $script:lastUrl = $url; return }
      }
    } catch { }

    if ($url -eq $script:lastUrl) { return }
    $script:lastUrl = $url
    $script:currentUrl = $url

    Show-Toast $url
  } catch {
    Log "tick error: $($_.Exception.Message)"
  }
})
$script:timer.Start()

Log "watch start base=$Base interval=$IntervalMs"
[System.Windows.Threading.Dispatcher]::Run()
