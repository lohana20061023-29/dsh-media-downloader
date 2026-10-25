param(
  [Parameter(Mandatory = $true)][string]$Base,
  [int]$IntervalMs = 700
)

# 系统剪贴板监听：任何地方复制到受支持的链接都会通知宿主
$log = Join-Path $env:TEMP 'dsh-clipboard-watch.log'
function Log($m) { "[$([DateTime]::Now.ToString('HH:mm:ss.fff'))] $m" | Out-File -FilePath $log -Append -Encoding utf8 }

$mutex = New-Object System.Threading.Mutex($false, 'Global\dsh-media-clipboard-watch')
if (-not $mutex.WaitOne(0)) { exit 0 }

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Clip {
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
}
"@

$pattern = 'https?://[^\s"''<>]+'
$platform = '(bilibili\.com|b23\.tv|xiaohongshu\.com|xhslink\.(com|cn)|douyin\.com|youtube\.com|youtu\.be|x\.com|twitter\.com|tiktok\.com|vimeo\.com)'

# 供宿主清理旧实例
$pidFile = Join-Path $env:TEMP 'dsh-clipboard-watch.pid'
try { $PID | Out-File -FilePath $pidFile -Encoding ascii -NoNewline } catch { }

Log "watch start base=$Base pid=$PID"
$lastSeq = [Clip]::GetClipboardSequenceNumber()
$lastUrl = ''

$hostFile = Join-Path $env:TEMP 'dsh-media-host.txt'

# 立即写一次心跳，宿主据此判断已有实例
$hbEarly = Join-Path $env:TEMP 'dsh-clipboard-watch.hb'
try { [System.IO.File]::WriteAllText($hbEarly, [string][DateTime]::Now.Ticks) } catch { }
$hb = Join-Path $env:TEMP 'dsh-clipboard-watch.hb'
$hbTimer = [DateTime]::MinValue

while ($true) {
  Start-Sleep -Milliseconds $IntervalMs
  try {
    if (([DateTime]::Now - $hbTimer).TotalSeconds -ge 3) {
      [System.IO.File]::WriteAllText($hb, [string][DateTime]::Now.Ticks)
      $hbTimer = [DateTime]::Now
    }
  } catch { }
  try {
    $seq = [Clip]::GetClipboardSequenceNumber()
    if ($seq -eq $lastSeq) { continue }
    $lastSeq = $seq

    $text = ''
    try { $text = Get-Clipboard -Raw -ErrorAction Stop } catch { continue }
    if (-not $text) { continue }
    $text = $text.Trim()
    if ($text.Length -gt 4096) { continue }
    if ($text -notmatch $platform) { continue }

    $m = [regex]::Match($text, $pattern)
    if (-not $m.Success) { continue }
    $url = $m.Value
    if ($url -eq $lastUrl) { continue }
    $lastUrl = $url

    try {
      if (Test-Path $hostFile) {
        $fresh = (Get-Content $hostFile -Raw -ErrorAction Stop).Trim()
        if ($fresh) { $Base = $fresh }
      }
    } catch { }

    Log "hit $url base=$Base"
    $body = @{ url = $url } | ConvertTo-Json -Compress
    try {
      Invoke-RestMethod -Uri "http://$Base/bili-dl/notify" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 10 | Out-Null
      Log 'notified'
    } catch { Log "notify failed: $($_.Exception.Message)" }
  } catch {
    Log "loop error: $($_.Exception.Message)"
    Start-Sleep -Seconds 2
  }
}
