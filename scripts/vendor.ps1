# Downloads the open-source parts Frosted-AIO bundles into vendor\ (not stored in git):
#   vendor\ffmpeg   FFmpeg 8.1, BtbN win64 GPL shared build (video/image conversion)
#   vendor\sensors  LibreHardwareMonitorLib 0.9.6 + its .NET Framework dependencies (sensor readings)
# Usage (from the project folder):  npm run vendor
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path $PSScriptRoot -Parent
$vendor = Join-Path $root 'vendor'
$work = Join-Path ([IO.Path]::GetTempPath()) 'frosted-aio-vendor'
New-Item -ItemType Directory -Force $vendor, $work | Out-Null

# ---------- FFmpeg ----------
$ffName = 'ffmpeg-n8.1-latest-win64-gpl-shared-8.1'
$ffZip = Join-Path $work "$ffName.zip"
$ffOut = Join-Path $vendor 'ffmpeg'
Write-Host "Downloading $ffName ..."
Invoke-WebRequest "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/$ffName.zip" -OutFile $ffZip -UseBasicParsing
$ffTmp = Join-Path $work 'ffmpeg-x'
if (Test-Path $ffTmp) { Remove-Item -LiteralPath $ffTmp -Recurse -Force }
Expand-Archive $ffZip $ffTmp -Force
if (Test-Path $ffOut) { Get-ChildItem -LiteralPath $ffOut -File | Remove-Item -Force }
New-Item -ItemType Directory -Force $ffOut | Out-Null
$bin = Join-Path $ffTmp "$ffName\bin"
Get-ChildItem $bin -File | Where-Object { $_.Name -ne 'ffplay.exe' } | Copy-Item -Destination $ffOut
Copy-Item (Join-Path $ffTmp "$ffName\LICENSE.txt") (Join-Path $ffOut 'LICENSE-FFmpeg.txt') -ErrorAction SilentlyContinue
$ver = (& (Join-Path $ffOut 'ffmpeg.exe') -hide_banner -version | Select-Object -First 1)
@"
FFmpeg (ffmpeg.exe, ffprobe.exe and the DLLs in this folder)

$ver
Build: BtbN FFmpeg-Builds, $ffName (https://github.com/BtbN/FFmpeg-Builds)

FFmpeg is free software under the GNU General Public License version 3 (this build includes GPL
components such as libx264). Source: https://ffmpeg.org/download.html and https://github.com/FFmpeg/FFmpeg
Build scripts: https://github.com/BtbN/FFmpeg-Builds  Licence: https://www.gnu.org/licenses/gpl-3.0.txt

Frosted-AIO runs these programs as separate processes to convert videos and images for the cooler.
"@ | Set-Content (Join-Path $ffOut 'FFMPEG-NOTICE.txt') -Encoding utf8
Write-Host "  $ver"

# ---------- LibreHardwareMonitor and dependencies (from nuget.org) ----------
# Only the DLLs needed on .NET Framework 4.7.2; framework-provided ones (System.Management, ...) are skipped.
$keep = @('LibreHardwareMonitorLib', 'BlackSharp.Core', 'DiskInfoToolkit', 'HidSharp', 'Microsoft.Win32.Registry', 'RAMSPDToolkit-NDD',
  'System.Buffers', 'System.CodeDom', 'System.Memory', 'System.Numerics.Vectors', 'System.Runtime.CompilerServices.Unsafe',
  'System.Security.AccessControl', 'System.Security.Principal.Windows', 'System.Threading.AccessControl')
$sOut = Join-Path $vendor 'sensors'
if (Test-Path $sOut) { Get-ChildItem -LiteralPath $sOut -File | Remove-Item -Force }
New-Item -ItemType Directory -Force $sOut | Out-Null
$frameworks = @('net472', 'net471', 'net47', 'net462', 'net461', 'net46', 'net45', 'netstandard2.0')
$seen = @{}
$licences = New-Object System.Collections.ArrayList

function Get-Package($id, $version) {
  $key = $id.ToLower()
  if ($key.StartsWith('runtime.') -or $seen.ContainsKey($key)) { return }
  $seen[$key] = $true
  $zip = Join-Path $work "$key.$version.zip"
  if (-not (Test-Path $zip)) { Invoke-WebRequest "https://api.nuget.org/v3-flatcontainer/$key/$version/$key.$version.nupkg" -OutFile $zip -UseBasicParsing }
  $dir = Join-Path $work "$key.$version"
  if (-not (Test-Path $dir)) { Expand-Archive $zip $dir -Force }
  [xml]$spec = Get-Content (Get-ChildItem $dir -Filter *.nuspec | Select-Object -First 1).FullName
  $meta = $spec.package.metadata
  if ($keep -contains $meta.id) {
    $dll = $null
    foreach ($fw in $frameworks) {
      foreach ($base in @("runtimes\win-x64\lib\$fw", "lib\$fw")) {
        $p = Join-Path $dir $base
        if ((Test-Path $p) -and (Get-ChildItem $p -Filter *.dll)) { $dll = Get-ChildItem $p -Filter *.dll; break }
      }
      if ($dll) { break }
    }
    if ($dll) { $dll | Copy-Item -Destination $sOut -Force }
    $lic = if ($meta.license) { $meta.license.'#text' } else { $meta.licenseUrl }
    [void]$licences.Add("$($meta.id) $version - licence: $lic - https://www.nuget.org/packages/$($meta.id)/$version")
    Write-Host "  $($meta.id) $version"
  }
  $groups = @($meta.dependencies.group)
  foreach ($fw in $frameworks) {
    $g = $groups | Where-Object { $_.targetFramework -and (($_.targetFramework -replace '^\.NETFramework4\.(\d)(\d?)$', 'net4$1$2' -replace '^\.NETStandard2\.0$', 'netstandard2.0').ToLower() -eq $fw) }
    if ($g) { foreach ($d in @($g.dependency)) { if ($d.id) { Get-Package $d.id ((($d.version -replace '[\[\]\(\)]', '') -split ',')[0]) } }; break }
  }
}

Write-Host 'Downloading LibreHardwareMonitorLib 0.9.6 and dependencies ...'
Get-Package 'LibreHardwareMonitorLib' '0.9.6'
$licences | Sort-Object | Set-Content (Join-Path $sOut 'THIRD-PARTY-LICENSES.txt') -Encoding utf8
$missing = $keep | Where-Object { -not (Test-Path (Join-Path $sOut "$_.dll")) }
if ($missing) { throw "Missing sensor DLLs: $($missing -join ', ')" }
Write-Host 'Done.'
