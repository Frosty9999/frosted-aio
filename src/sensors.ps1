# PC sensor reader for Frosted-AIO (replaces TRYX's Screen.exe), built on the open-source LibreHardwareMonitor
# library (MPL-2.0) and the PawnIO driver. Prints one JSON line per second:
#   {"cpu":{"temperature","load","frequency","power"},"gpu":{...},"memory":{"load","frequency"},"network":{"down","up"}}
# plus a single "INFO ..." line at start describing what it found. Run elevated for CPU temperatures.
param([Parameter(Mandatory = $true)][string]$LibDir, [int]$IntervalMs = 1000, [switch]$Once)

$ErrorActionPreference = 'Stop'
$LibDir = (Resolve-Path $LibDir).Path
$lhm = Join-Path $LibDir 'LibreHardwareMonitorLib.dll'

# Dependencies sit next to the library; let .NET find them there (and accept any version).
Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Reflection;
public static class DepResolver {
  public static string Dir;
  public static void Install(string dir) {
    Dir = dir;
    AppDomain.CurrentDomain.AssemblyResolve += (s, e) => {
      var name = new AssemblyName(e.Name).Name;
      var p = Path.Combine(Dir, name + ".dll");
      return File.Exists(p) ? Assembly.LoadFrom(p) : null;
    };
  }
}
"@
[DepResolver]::Install($LibDir)
$null = [Reflection.Assembly]::LoadFrom($lhm)

Add-Type -ReferencedAssemblies @($lhm, 'System.Management', 'System.Core') -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Management;
using System.Net.NetworkInformation;
using System.Security.Principal;
using System.Text;
using System.Threading;
using LibreHardwareMonitor.Hardware;

public static class KanaliSensors {
  static Computer pc;
  static long lastRx = -1, lastTx = -1;
  static DateTime lastNet;
  static int memClock;

  static void UpdateAll(IHardware h) { h.Update(); foreach (var s in h.SubHardware) UpdateAll(s); }
  static IEnumerable<ISensor> All(IHardware h) { return h.Sensors.Concat(h.SubHardware.SelectMany(All)); }

  // First sensor of a type whose name matches one of the given names (in order of preference).
  static float? Find(IHardware h, SensorType t, params string[] names) {
    var list = All(h).Where(s => s.SensorType == t && s.Value.HasValue).ToList();
    foreach (var n in names) {
      var m = list.FirstOrDefault(s => string.Equals(s.Name, n, StringComparison.OrdinalIgnoreCase));
      if (m != null) return m.Value;
    }
    return null;
  }
  static float? Avg(IHardware h, SensorType t, string prefix) {
    var v = All(h).Where(s => s.SensorType == t && s.Value.HasValue && s.Name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)).Select(s => s.Value.Value).ToList();
    return v.Count > 0 ? (float?)v.Average() : null;
  }
  static float? Max(IHardware h, SensorType t) {
    var v = All(h).Where(s => s.SensorType == t && s.Value.HasValue).Select(s => s.Value.Value).ToList();
    return v.Count > 0 ? (float?)v.Max() : null;
  }

  static string N(float? v) { return v.HasValue && !float.IsNaN(v.Value) ? Math.Round(v.Value).ToString(CultureInfo.InvariantCulture) : "0"; }

  public static string Open() {
    pc = new Computer { IsCpuEnabled = true, IsGpuEnabled = true, IsMemoryEnabled = true };
    pc.Open();
    try {
      using (var q = new ManagementObjectSearcher("SELECT ConfiguredClockSpeed, Speed FROM Win32_PhysicalMemory"))
        foreach (ManagementObject m in q.Get()) {
          var c = Convert.ToInt32(m["ConfiguredClockSpeed"] ?? m["Speed"] ?? 0);
          if (c > memClock) memClock = c;
        }
    } catch { }
    var admin = new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);
    var hw = string.Join(" | ", pc.Hardware.Select(h => h.HardwareType + ": " + h.Name));
    return "INFO elevated=" + admin + " memClock=" + memClock + " hardware=" + hw;
  }

  public static string Read() {
    foreach (var h in pc.Hardware) UpdateAll(h);
    var cpu = pc.Hardware.FirstOrDefault(h => h.HardwareType == HardwareType.Cpu);
    // Prefer a dedicated graphics card over the graphics built into the CPU.
    var gpu = pc.Hardware.FirstOrDefault(h => h.HardwareType == HardwareType.GpuNvidia)
           ?? pc.Hardware.FirstOrDefault(h => h.HardwareType == HardwareType.GpuAmd)
           ?? pc.Hardware.FirstOrDefault(h => h.HardwareType == HardwareType.GpuIntel);
    var mem = pc.Hardware.FirstOrDefault(h => h.HardwareType == HardwareType.Memory);

    var sb = new StringBuilder("{");
    if (cpu != null) {
      var temp = Find(cpu, SensorType.Temperature, "CPU Package", "Core (Tctl/Tdie)", "Core Max", "Core Average") ?? Max(cpu, SensorType.Temperature);
      var load = Find(cpu, SensorType.Load, "CPU Total");
      var clock = Avg(cpu, SensorType.Clock, "Core #") ?? Avg(cpu, SensorType.Clock, "P-Core #") ?? Avg(cpu, SensorType.Clock, "CPU Core #");
      var power = Find(cpu, SensorType.Power, "CPU Package", "Package");
      sb.AppendFormat("\"cpu\":{{\"temperature\":{0},\"load\":{1},\"frequency\":{2},\"power\":{3}}},", N(temp), N(load), N(clock), N(power));
    } else sb.Append("\"cpu\":{\"temperature\":0,\"load\":0,\"frequency\":0,\"power\":0},");
    if (gpu != null) {
      var temp = Find(gpu, SensorType.Temperature, "GPU Core", "GPU Hot Spot") ?? Max(gpu, SensorType.Temperature);
      var load = Find(gpu, SensorType.Load, "GPU Core", "D3D 3D");
      var clock = Find(gpu, SensorType.Clock, "GPU Core");
      var power = Find(gpu, SensorType.Power, "GPU Package", "GPU Power", "GPU Board Power") ?? Max(gpu, SensorType.Power);
      sb.AppendFormat("\"gpu\":{{\"temperature\":{0},\"load\":{1},\"frequency\":{2},\"power\":{3}}},", N(temp), N(load), N(clock), N(power));
    } else sb.Append("\"gpu\":{\"temperature\":0,\"load\":0,\"frequency\":0,\"power\":0},");
    var memLoad = mem != null ? Find(mem, SensorType.Load, "Memory") : null;
    sb.AppendFormat("\"memory\":{{\"load\":{0},\"frequency\":{1}}},", N(memLoad), memClock);

    // Network: total bytes on all active, non-loopback adapters, per second since the last read.
    long rx = 0, tx = 0;
    try {
      foreach (var ni in NetworkInterface.GetAllNetworkInterfaces()) {
        if (ni.OperationalStatus != OperationalStatus.Up || ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
        var st = ni.GetIPStatistics();
        rx += st.BytesReceived; tx += st.BytesSent;
      }
    } catch { }
    var now = DateTime.UtcNow;
    double down = 0, up = 0;
    if (lastRx >= 0) {
      var secs = Math.Max(0.1, (now - lastNet).TotalSeconds);
      down = Math.Max(0, (rx - lastRx) / secs);
      up = Math.Max(0, (tx - lastTx) / secs);
    }
    lastRx = rx; lastTx = tx; lastNet = now;
    sb.AppendFormat("\"network\":{{\"down\":{0},\"up\":{1}}}}}", Math.Round(down).ToString(CultureInfo.InvariantCulture), Math.Round(up).ToString(CultureInfo.InvariantCulture));
    return sb.ToString();
  }

  public static void Close() { if (pc != null) pc.Close(); }
}
'@

[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::Out.WriteLine([KanaliSensors]::Open())
try {
  while ($true) {
    [Console]::Out.WriteLine([KanaliSensors]::Read())
    [Console]::Out.Flush()
    if ($Once) { break }
    Start-Sleep -Milliseconds $IntervalMs
  }
} finally {
  [KanaliSensors]::Close()
}
