param(
  [Parameter(Mandatory = $true)][string]$Url,
  [Parameter(Mandatory = $true)][string]$Base,
  [int]$Seconds = 8,
  [string]$Accent = '',
  [string]$Bg = '',
  [string]$Fg = '',
  [string]$Sub = '',
  [string]$BorderColor = '',
  [string]$Font = '',
  [string]$ThemeFile = ''
)

$log = Join-Path $env:TEMP 'dsh-corner-toast.log'
function Log($m) { "[$([DateTime]::Now.ToString('HH:mm:ss.fff'))] $m" | Out-File -FilePath $log -Append -Encoding utf8 }

try {
  Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Xaml, System.Windows.Forms

  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Dwm {
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
}
"@

  # 跟随系统深浅色
  $light = $true
  try {
    $v = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name AppsUseLightTheme -ErrorAction Stop
    $light = [int]$v.AppsUseLightTheme -ne 0
  } catch { }
  Log "theme light=$light"

  # 默认值来自系统深浅色；DSH 传了主题就用 DSH 的
  $cBg     = if ($light) { '#FFFFFF' } else { '#23262B' }
  $cBorder = if ($light) { '#D3DDED' } else { '#3A3F46' }
  $cText   = if ($light) { '#16233A' } else { '#F2F5F9' }
  $cSub    = if ($light) { '#5B6B82' } else { '#9BA7B6' }
  $cClose  = if ($light) { '#8595AA' } else { '#7C8798' }
  $cAccent = '#2F6BEF'
  try {
    $reg = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\DWM' -Name AccentColor -ErrorAction Stop
    $v = [uint32]$reg.AccentColor
    $r = $v -band 0xFF; $g = ($v -shr 8) -band 0xFF; $b = ($v -shr 16) -band 0xFF
    $cAccent = ('#{0:X2}{1:X2}{2:X2}' -f $r, $g, $b)
  } catch { }

  # DSH 通过 JSON 文件下发主题
  if ($ThemeFile -and (Test-Path $ThemeFile)) {
    try {
      $t = Get-Content $ThemeFile -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($t.accent) { $Accent = $t.accent }
      if ($t.bg)     { $Bg = $t.bg }
      if ($t.fg)     { $Fg = $t.fg }
      if ($t.sub)    { $Sub = $t.sub }
      if ($t.border) { $BorderColor = $t.border }
      if ($t.font)   { $Font = $t.font }
      Log "theme file loaded: $Accent / $Bg / $Font"
    } catch { Log "theme file parse failed: $($_.Exception.Message)" }
  }

  if ($Bg)     { $cBg = $Bg }
  if ($BorderColor) { $cBorder = $BorderColor }
  if ($Fg)     { $cText = $Fg }
  if ($Sub)    { $cSub = $Sub; $cClose = $Sub }
  if ($Accent) { $cAccent = $Accent }
  Log "colors bg=$cBg accent=$cAccent font=$Font"

  # 单行紧凑尺寸
  $w = 244; $h = 56
  $win = New-Object System.Windows.Window
  $win.WindowStyle = 'None'
  $win.ResizeMode = 'NoResize'
  $win.Topmost = $true
  $win.ShowInTaskbar = $false
  $win.Width = $w; $win.Height = $h
  $win.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString($cBg)
  $win.Cursor = [System.Windows.Input.Cursors]::Hand

  $border = New-Object System.Windows.Controls.Border
  $border.CornerRadius = 10
  $border.BorderThickness = 1
  $border.BorderBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString($cBorder)
  $border.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString($cBg)
  $win.Content = $border

  if ($Font) {
    $fontName = ($Font -split ',')[0].Trim().Trim('"').Trim("'")
    if ($fontName) {
      try { $win.FontFamily = New-Object System.Windows.Media.FontFamily($fontName) } catch { }
    }
  }

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
  $icon.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString($cAccent)
  $arrow = New-Object System.Windows.Controls.TextBlock
  $arrow.Text = [char]0xE896
  $arrow.FontFamily = New-Object System.Windows.Media.FontFamily('Segoe MDL2 Assets')
  $arrow.FontSize = 15; $arrow.FontWeight = 'Normal'
  $arrow.Foreground = [System.Windows.Media.Brushes]::White
  $arrow.HorizontalAlignment = 'Center'; $arrow.VerticalAlignment = 'Center'
  $icon.Child = $arrow
  [System.Windows.Controls.Grid]::SetColumn($icon, 0)
  [void]$grid.Children.Add($icon)

  $text = New-Object System.Windows.Controls.TextBlock
  $text.Text = '检测到链接，点此打开'
  $text.FontSize = 13
  $text.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString($cText)
  $text.VerticalAlignment = 'Center'
  $text.TextTrimming = 'CharacterEllipsis'
  $text.Margin = '10,0,4,0'
  [System.Windows.Controls.Grid]::SetColumn($text, 1)
  [void]$grid.Children.Add($text)

  $close = New-Object System.Windows.Controls.Button
  $close.Content = [char]0x2715
  $close.FontSize = 11
  $close.Width = 18; $close.Height = 18
  $close.BorderThickness = 0
  $close.Background = [System.Windows.Media.Brushes]::Transparent
  $close.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString($cClose)
  $close.VerticalAlignment = 'Center'
  $close.Cursor = [System.Windows.Input.Cursors]::Arrow
  [System.Windows.Controls.Grid]::SetColumn($close, 2)
  [void]$grid.Children.Add($close)
  $close.Add_Click({ $win.Close() })

  $border.Add_MouseLeftButtonUp({
    try {
      $body = @{ url = $Url } | ConvertTo-Json -Compress
      Invoke-RestMethod -Uri "http://$Base/bili-dl/toast/open" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 8 | Out-Null
      Log 'clicked -> host'
    } catch { Log "click failed: $($_.Exception.Message)" }
    $win.Close()
  })

  $script:timer = New-Object System.Windows.Threading.DispatcherTimer
  $script:timer.Interval = [TimeSpan]::FromSeconds($Seconds)
  $script:timer.Add_Tick({ $script:timer.Stop(); $win.Close() })
  $script:timer.Start()

  # 贴右下角（按真实 DPI 换算）
  $win.Add_Loaded({
    $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $sx = [System.Windows.Media.VisualTreeHelper]::GetDpi($win).DpiScaleX
    $win.Left = ($wa.Right / $sx) - $w - 16
    $win.Top = ($wa.Bottom / $sx) - $h - 16
    $hwnd = (New-Object System.Windows.Interop.WindowInteropHelper($win)).Handle
    $round = 2
    try { [void][Dwm]::DwmSetWindowAttribute($hwnd, 33, [ref]$round, 4) } catch { }
    Log ("dpi $sx pos " + [int]$win.Left + "," + [int]$win.Top)
  })

  Log 'show'
  [void]$win.ShowDialog()
  Log 'closed'
} catch {
  Log "FATAL: $($_.Exception.Message)"
  exit 1
}
