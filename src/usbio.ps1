# USB byte pipe for the TRYX Panorama coolers (Frosted-AIO's replacement for TRYX's UDB.exe transport).
# Finds the cooler (USB vendor 0x391A) through Windows' own device list, opens it like a file
# (Windows' built-in USB driver; no TRYX driver), and relays raw bytes over stdin/stdout:
#   stdout:  OPEN <path> | D <base64 bytes read> | CLOSED <reason> | NODEV | ERR <message>
#   stdin:   W <base64 bytes to write> | Q (quit)
# All protocol work (framing, protobuf) happens in Frosted-AIO's cooler.js. The script exits when stdin closes.

param([switch]$List) # -List: print the cooler device paths found and exit (opens nothing)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class UsbIo {
  // ---------- Windows device enumeration (setupapi) ----------
  static readonly Guid UsbDeviceInterface = new Guid("A5DCBF10-6530-11D2-901F-00C04FB951ED");
  const int DIGCF_PRESENT = 0x2, DIGCF_DEVICEINTERFACE = 0x10;

  [StructLayout(LayoutKind.Sequential)]
  struct SP_DEVICE_INTERFACE_DATA { public int cbSize; public Guid InterfaceClassGuid; public int Flags; public IntPtr Reserved; }

  [DllImport("setupapi.dll", SetLastError = true)]
  static extern IntPtr SetupDiGetClassDevsW(ref Guid g, IntPtr e, IntPtr hwnd, int flags);
  [DllImport("setupapi.dll", SetLastError = true)]
  static extern bool SetupDiEnumDeviceInterfaces(IntPtr set, IntPtr info, ref Guid g, int index, ref SP_DEVICE_INTERFACE_DATA data);
  [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool SetupDiGetDeviceInterfaceDetailW(IntPtr set, ref SP_DEVICE_INTERFACE_DATA data, IntPtr detail, int size, out int required, IntPtr info);
  [DllImport("setupapi.dll")]
  static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);

  public static List<string> FindCoolers() {
    var found = new List<string>();
    var g = UsbDeviceInterface;
    IntPtr set = SetupDiGetClassDevsW(ref g, IntPtr.Zero, IntPtr.Zero, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE);
    if (set == new IntPtr(-1)) return found;
    try {
      for (int i = 0; ; i++) {
        var d = new SP_DEVICE_INTERFACE_DATA(); d.cbSize = Marshal.SizeOf(d);
        if (!SetupDiEnumDeviceInterfaces(set, IntPtr.Zero, ref g, i, ref d)) break;
        int need;
        SetupDiGetDeviceInterfaceDetailW(set, ref d, IntPtr.Zero, 0, out need, IntPtr.Zero);
        IntPtr buf = Marshal.AllocHGlobal(need);
        try {
          Marshal.WriteInt32(buf, IntPtr.Size == 8 ? 8 : 6); // cbSize of SP_DEVICE_INTERFACE_DETAIL_DATA_W
          if (SetupDiGetDeviceInterfaceDetailW(set, ref d, buf, need, out need, IntPtr.Zero)) {
            string path = Marshal.PtrToStringUni(new IntPtr(buf.ToInt64() + 4));
            if (path != null && path.ToLowerInvariant().Contains("vid_391a")) found.Add(path);
          }
        } finally { Marshal.FreeHGlobal(buf); }
      }
    } finally { SetupDiDestroyDeviceInfoList(set); }
    return found;
  }

  // ---------- byte relay ----------
  static readonly object outLock = new object();
  static FileStream dev;
  static readonly object devLock = new object();
  static volatile bool quit;

  static void Say(string line) { lock (outLock) { Console.Out.WriteLine(line); Console.Out.Flush(); } }

  // Separate unbuffered handles for reading and writing: a pending read on a shared, buffered FileStream
  // held writes back (and blocked replies), so each direction gets its own handle.
  static FileStream Open(string path, bool forWrite) {
    // GENERIC_READ or GENERIC_WRITE, share read+write, OPEN_EXISTING, FILE_FLAG_OVERLAPPED
    var h = CreateFileW(path, forWrite ? 0x40000000u : 0x80000000u, 3, IntPtr.Zero, 3, 0x40000000, IntPtr.Zero);
    if (h.IsInvalid) throw new IOException("open failed, Win32 error " + Marshal.GetLastWin32Error());
    return new FileStream(h, forWrite ? FileAccess.Write : FileAccess.Read, 1, true);
  }

  static void StdinLoop() {
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      if (line == "Q") break;
      if (!line.StartsWith("W ")) continue;
      byte[] bytes;
      try { bytes = Convert.FromBase64String(line.Substring(2)); } catch { Say("ERR bad base64"); continue; }
      FileStream d;
      lock (devLock) d = dev;
      if (d == null) { Say("ERR not open"); continue; }
      try { d.WriteAsync(bytes, 0, bytes.Length).Wait(); d.Flush(); }
      catch (Exception e) { Say("ERR write " + Flatten(e)); }
    }
    quit = true;
    lock (devLock) { if (dev != null) dev.Dispose(); }
  }

  static string Flatten(Exception e) {
    while (e is AggregateException && e.InnerException != null) e = e.InnerException;
    return e.Message.Replace("\r", " ").Replace("\n", " ");
  }

  public static void Run() {
    var stdin = new Thread(StdinLoop) { IsBackground = true };
    stdin.Start();
    bool saidNoDev = false;
    var buf = new byte[1 << 20];
    while (!quit) {
      var paths = FindCoolers();
      if (paths.Count == 0) {
        if (!saidNoDev) { Say("NODEV"); saidNoDev = true; }
        Thread.Sleep(2000);
        continue;
      }
      saidNoDev = false;
      FileStream reader, writer;
      try { reader = Open(paths[0], false); }
      catch (Exception e) { Say("ERR " + Flatten(e)); Thread.Sleep(2000); continue; }
      try { writer = Open(paths[0], true); }
      catch (Exception e) { reader.Dispose(); Say("ERR " + Flatten(e)); Thread.Sleep(2000); continue; }
      lock (devLock) dev = writer;
      Say("OPEN " + paths[0]);
      try {
        while (!quit) {
          int n = reader.ReadAsync(buf, 0, buf.Length).Result;
          if (n <= 0) throw new IOException("device returned no data");
          Say("D " + Convert.ToBase64String(buf, 0, n));
        }
      } catch (Exception e) {
        if (!quit) Say("CLOSED " + Flatten(e));
      }
      lock (devLock) { dev = null; }
      try { reader.Dispose(); } catch { }
      try { writer.Dispose(); } catch { }
      if (!quit) Thread.Sleep(1000);
    }
  }
}
'@

if ($List) { [UsbIo]::FindCoolers() | ForEach-Object { $_ }; exit 0 }
[Console]::InputEncoding = [Text.Encoding]::ASCII
[Console]::OutputEncoding = [Text.Encoding]::ASCII
[UsbIo]::Run()
