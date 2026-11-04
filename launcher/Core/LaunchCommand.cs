namespace BlueprintLauncher.Core;

/// <summary>Executable plus argument list. Never a shell string.</summary>
public sealed record LaunchCommand(string Exe, IReadOnlyList<string> Arguments)
{
    /// <summary>Chromium family only (chrome, edge, brave, yandex).</summary>
    public static LaunchCommand Build(string exe, string profileFolder, string url)
    {
        CheckExe(exe);
        if (!BrowserProfiles.IsValidFolder(profileFolder)) throw new ArgumentException("invalid profile folder", nameof(profileFolder));
        CheckUrl(url);
        return new LaunchCommand(exe, new[] { "--profile-directory=" + profileFolder, url });
    }

    /// <summary>Chromium: --profile-directory=folder then url. Opera: url only (profile ignored). Firefox: -P, name, url as separate arguments.</summary>
    public static LaunchCommand Build(string exe, string browser, string profile, string url)
    {
        var info = BrowserCatalog.TryGet(browser) ?? throw new ArgumentException("unknown browser", nameof(browser));
        switch (info.Family)
        {
            case BrowserFamily.Chromium:
                return Build(exe, profile, url);
            case BrowserFamily.Opera:
                CheckExe(exe);
                CheckUrl(url);
                return new LaunchCommand(exe, new[] { url });
            case BrowserFamily.Firefox:
                CheckExe(exe);
                if (!BrowserProfiles.IsValidFirefoxProfileName(profile)) throw new ArgumentException("invalid profile name", nameof(profile));
                CheckUrl(url);
                return new LaunchCommand(exe, new[] { "-P", profile, url });
            default:
                throw new ArgumentException("unknown browser", nameof(browser));
        }
    }

    private static void CheckExe(string exe)
    {
        if (string.IsNullOrWhiteSpace(exe) || exe.Any(c => c < ' ')) throw new ArgumentException("invalid executable", nameof(exe));
    }

    private static void CheckUrl(string url)
    {
        if (string.IsNullOrEmpty(url)
            || !url.StartsWith(PromptBuilder.BaseUrl, StringComparison.Ordinal)
            || url.Any(c => c <= ' ' || c >= (char)0x7F))
        {
            throw new ArgumentException("invalid url", nameof(url));
        }
    }
}
