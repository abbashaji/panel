using System.Runtime.Versioning;
using Microsoft.Win32;

namespace BlueprintLauncher.Core;

public interface IBrowserExeLocator
{
    string? Find(string browser);
}

/// <summary>Registry App Paths first, then standard install dirs. Both are injectable.</summary>
public sealed class BrowserExeLocator : IBrowserExeLocator
{
    private readonly IReadOnlyList<string> _dirs;
    private readonly Func<string, string?> _registry;

    public BrowserExeLocator(IEnumerable<string> standardDirs, Func<string, string?>? registryLookup = null)
    {
        _dirs = standardDirs.ToList();
        _registry = registryLookup ?? DefaultRegistryLookup;
    }

    public static BrowserExeLocator CreateDefault()
    {
        var dirs = new[]
        {
            Environment.GetEnvironmentVariable("ProgramFiles"),
            Environment.GetEnvironmentVariable("ProgramFiles(x86)"),
            Environment.GetEnvironmentVariable("LOCALAPPDATA"),
        };
        return new BrowserExeLocator(dirs.Where(d => !string.IsNullOrEmpty(d)).Select(d => d!));
    }

    public string? Find(string browser)
    {
        var info = BrowserCatalog.TryGet(browser);
        if (info is null) return null;
        var reg = SafeRegistry(info.ExeName);
        if (reg is not null && File.Exists(reg) && RegistryPathFits(info, reg)) return reg;
        foreach (var d in _dirs)
        {
            foreach (var rel in info.ExeRelativePaths)
            {
                var p = Path.Combine(d, rel);
                if (File.Exists(p)) return p;
            }
        }
        return null;
    }

    /// <summary>Firefox and Firefox Developer Edition share firefox.exe in App Paths, so the registry path must belong to the asked edition.</summary>
    private static bool RegistryPathFits(BrowserInfo info, string path)
    {
        if (info.Family != BrowserFamily.Firefox) return true;
        var isDevPath = path.Contains("Developer Edition", StringComparison.OrdinalIgnoreCase);
        return isDevPath == (info.Id == "firefox-dev");
    }

    private string? SafeRegistry(string exe)
    {
        try
        {
            var v = _registry(exe)?.Trim().Trim('"');
            return string.IsNullOrWhiteSpace(v) ? null : v;
        }
        catch (Exception e) when (e is System.Security.SecurityException or UnauthorizedAccessException or IOException or PlatformNotSupportedException)
        {
            return null;
        }
    }

    private static string? DefaultRegistryLookup(string exe)
    {
        if (!OperatingSystem.IsWindows()) return null;
        return ReadAppPath(exe);
    }

    [SupportedOSPlatform("windows")]
    private static string? ReadAppPath(string exe)
    {
        var sub = @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\" + exe;
        foreach (var hive in new[] { Registry.CurrentUser, Registry.LocalMachine })
        {
            using var key = hive.OpenSubKey(sub);
            if (key?.GetValue("") is string s && s.Length > 0) return s;
        }
        return null;
    }
}
