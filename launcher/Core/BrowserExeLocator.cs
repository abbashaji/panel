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
        string exe;
        string rel;
        switch (browser)
        {
            case "chrome":
                exe = "chrome.exe";
                rel = Path.Combine("Google", "Chrome", "Application", "chrome.exe");
                break;
            case "edge":
                exe = "msedge.exe";
                rel = Path.Combine("Microsoft", "Edge", "Application", "msedge.exe");
                break;
            default:
                return null;
        }
        var reg = SafeRegistry(exe);
        if (reg is not null && File.Exists(reg)) return reg;
        foreach (var d in _dirs)
        {
            var p = Path.Combine(d, rel);
            if (File.Exists(p)) return p;
        }
        return null;
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
