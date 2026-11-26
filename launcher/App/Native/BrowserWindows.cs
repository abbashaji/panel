using System.Diagnostics;
using BlueprintLauncher.Core;

namespace BlueprintLauncher.App.Native;

/// <summary>Finds visible top-level browser windows and tells their state. No input of any kind is sent.</summary>
public static class BrowserWindows
{
    /// <summary>Process names (no .exe) of every browser in BrowserCatalog, without duplicates.</summary>
    public static IReadOnlyList<string> BrowserProcessNames { get; } = BuildNames();

    private static IReadOnlyList<string> BuildNames()
    {
        var list = new List<string>();
        foreach (var browser in BrowserCatalog.All)
        {
            var name = Strip(browser.ExeName);
            if (!list.Contains(name, StringComparer.OrdinalIgnoreCase)) list.Add(name);
        }
        return list.AsReadOnly();
    }

    private static string Strip(string name)
    {
        var n = name.Trim();
        return n.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? n.Substring(0, n.Length - 4) : n;
    }

    /// <summary>Handles of visible top-level windows with a non-empty title whose process name is in the list.</summary>
    public static IReadOnlyCollection<IntPtr> Snapshot(IEnumerable<string> processNames)
    {
        return Enumerate(ToSet(processNames));
    }

    /// <summary>Polls every 100 ms; returns the first window not in 'before', or IntPtr.Zero on timeout or cancel.</summary>
    public static async Task<IntPtr> WaitForNewAsync(IReadOnlyCollection<IntPtr> before, IEnumerable<string> processNames, int timeoutMs, CancellationToken ct)
    {
        var known = new HashSet<IntPtr>(before ?? Array.Empty<IntPtr>());
        var names = ToSet(processNames);
        var clock = Stopwatch.StartNew();
        while (true)
        {
            if (ct.IsCancellationRequested) return IntPtr.Zero;
            foreach (var hwnd in Enumerate(names))
            {
                if (!known.Contains(hwnd)) return hwnd;
            }
            if (clock.ElapsedMilliseconds >= timeoutMs) return IntPtr.Zero;
            try
            {
                await Task.Delay(100, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return IntPtr.Zero;
            }
        }
    }

    /// <summary>minimized, hidden (DWM cloaked or not visible), foreground, background, or unknown for a dead handle.</summary>
    public static string StateOf(IntPtr hwnd)
    {
        try
        {
            if (hwnd == IntPtr.Zero || !NativeMethods.IsWindow(hwnd)) return "unknown";
            if (NativeMethods.IsIconic(hwnd)) return "minimized";
            if (IsCloaked(hwnd) || !NativeMethods.IsWindowVisible(hwnd)) return "hidden";
            return NativeMethods.GetForegroundWindow() == hwnd ? "foreground" : "background";
        }
        catch (Exception)
        {
            return "unknown";
        }
    }

    /// <summary>Process id that owns the window, 0 when it cannot be read.</summary>
    public static int ProcessIdOf(IntPtr hwnd)
    {
        NativeMethods.GetWindowThreadProcessId(hwnd, out var pid);
        return (int)pid;
    }

    private static bool IsCloaked(IntPtr hwnd)
    {
        try
        {
            return NativeMethods.DwmGetWindowAttribute(hwnd, NativeMethods.DWMWA_CLOAKED, out var cloaked, sizeof(int)) == 0 && cloaked != 0;
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static HashSet<string> ToSet(IEnumerable<string> names)
    {
        return new HashSet<string>(names.Select(Strip), StringComparer.OrdinalIgnoreCase);
    }

    private static List<IntPtr> Enumerate(HashSet<string> names)
    {
        var found = new List<IntPtr>();
        var byPid = new Dictionary<uint, string?>();
        NativeMethods.EnumWindows((hwnd, _) =>
        {
            try
            {
                if (!NativeMethods.IsWindowVisible(hwnd)) return true;
                if (NativeMethods.GetWindowTextLength(hwnd) <= 0) return true;
                NativeMethods.GetWindowThreadProcessId(hwnd, out var pid);
                if (pid == 0) return true;
                if (!byPid.TryGetValue(pid, out var processName))
                {
                    processName = ProcessNameOf(pid);
                    byPid[pid] = processName;
                }
                if (processName != null && names.Contains(processName)) found.Add(hwnd);
            }
            catch (Exception)
            {
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    private static string? ProcessNameOf(uint pid)
    {
        try
        {
            using var process = Process.GetProcessById((int)pid);
            return process.ProcessName;
        }
        catch (Exception)
        {
            return null;
        }
    }
}
