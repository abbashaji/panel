namespace BlueprintLauncher.Core;

public enum BrowserFamily { Chromium, Opera, Firefox }

/// <summary>ExeRelativePaths are relative to each standard dir (Program Files, Program Files (x86), LocalAppData). UserDataRelative is relative to LocalAppData for Chromium and to AppData for Opera and Firefox.</summary>
public sealed record BrowserInfo(string Id, string Display, BrowserFamily Family, string ExeName, IReadOnlyList<string> ExeRelativePaths, string UserDataRelative);

public static class BrowserCatalog
{
    private static readonly BrowserInfo[] Items =
    {
        new("chrome", "Google Chrome", BrowserFamily.Chromium, "chrome.exe",
            new[] { Path.Combine("Google", "Chrome", "Application", "chrome.exe") },
            Path.Combine("Google", "Chrome", "User Data")),
        new("edge", "Microsoft Edge", BrowserFamily.Chromium, "msedge.exe",
            new[] { Path.Combine("Microsoft", "Edge", "Application", "msedge.exe") },
            Path.Combine("Microsoft", "Edge", "User Data")),
        new("brave", "Brave", BrowserFamily.Chromium, "brave.exe",
            new[] { Path.Combine("BraveSoftware", "Brave-Browser", "Application", "brave.exe") },
            Path.Combine("BraveSoftware", "Brave-Browser", "User Data")),
        new("yandex", "Yandex Browser", BrowserFamily.Chromium, "browser.exe",
            new[] { Path.Combine("Yandex", "YandexBrowser", "Application", "browser.exe") },
            Path.Combine("Yandex", "YandexBrowser", "User Data")),
        new("opera", "Opera", BrowserFamily.Opera, "opera.exe",
            new[] { Path.Combine("Programs", "Opera", "opera.exe"), Path.Combine("Opera", "opera.exe") },
            Path.Combine("Opera Software", "Opera Stable")),
        new("firefox", "Firefox", BrowserFamily.Firefox, "firefox.exe",
            new[] { Path.Combine("Mozilla Firefox", "firefox.exe") },
            Path.Combine("Mozilla", "Firefox")),
        new("firefox-dev", "Firefox Developer Edition", BrowserFamily.Firefox, "firefox.exe",
            new[] { Path.Combine("Firefox Developer Edition", "firefox.exe") },
            Path.Combine("Mozilla", "Firefox")),
    };

    /// <summary>Fixed order: chrome, edge, brave, yandex, opera, firefox, firefox-dev.</summary>
    public static IReadOnlyList<BrowserInfo> All { get; } = Array.AsReadOnly(Items);

    public static bool IsKnown(string? id) => TryGet(id) is not null;

    public static BrowserInfo? TryGet(string? id)
    {
        if (id is null) return null;
        foreach (var b in Items)
        {
            if (string.Equals(b.Id, id, StringComparison.Ordinal)) return b;
        }
        return null;
    }

    public static BrowserInfo Get(string id) => TryGet(id) ?? throw new ArgumentException("unknown browser", nameof(id));
}
