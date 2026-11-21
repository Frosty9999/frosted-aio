# Now Playing helper for Frosted-AIO.
# Reads the track Windows shows in its media controls (Spotify, browsers, Apple Music, VLC, ...) through the
# built-in Global System Media Transport Controls API and prints one JSON line per second to stdout.
# With -Command play-pause | next | previous it sends that command to the current player once and exits.
param([string]$Command = '')

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]

# WinRT async -> .NET Task, so PowerShell can wait on it.
$asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Await($op, [Type]$type) {
  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $null = $task.Wait(5000)
  $task.Result
}

$mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$mgr = Await ($mgrType::RequestAsync()) $mgrType

if ($Command) {
  $s = $mgr.GetCurrentSession()
  if ($s) {
    $op = switch ($Command) {
      'play-pause' { $s.TryTogglePlayPauseAsync() }
      'next' { $s.TrySkipNextAsync() }
      'previous' { $s.TrySkipPreviousAsync() }
    }
    if ($op) { $null = Await $op ([bool]) }
  }
  exit 0
}

[Console]::OutputEncoding = [Text.Encoding]::UTF8
$cache = @{ key = ''; title = ''; artist = ''; album = '' }
while ($true) {
  $out = @{ playing = $false; status = 'None' }
  try {
    $s = $mgr.GetCurrentSession()
    if ($s) {
      $info = $s.GetPlaybackInfo()
      $tl = $s.GetTimelineProperties()
      # Track details only change with the song; re-read them when the timeline changes or every 5 s.
      $key = "$($s.SourceAppUserModelId)|$($tl.EndTime.Ticks)"
      if ($key -ne $cache.key -or ([DateTime]::Now.Second % 5) -eq 0) {
        $p = Await ($s.TryGetMediaPropertiesAsync()) $propsType
        $cache = @{ key = $key; title = $p.Title; artist = $p.Artist; album = $p.AlbumTitle }
      }
      $status = $info.PlaybackStatus.ToString()
      $pos = $tl.Position.TotalSeconds
      if ($status -eq 'Playing') {
        # Players report position occasionally; extrapolate from when it was last updated.
        $pos += ([DateTimeOffset]::Now - $tl.LastUpdatedTime).TotalSeconds
      }
      $out = @{
        playing  = ($status -eq 'Playing')
        status   = $status
        app      = $s.SourceAppUserModelId
        title    = $cache.title
        artist   = $cache.artist
        album    = $cache.album
        position = [Math]::Max(0, [Math]::Round($pos, 1))
        duration = [Math]::Round($tl.EndTime.TotalSeconds, 1)
      }
    }
  } catch {
    $out = @{ playing = $false; status = 'Error'; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 1000
}
