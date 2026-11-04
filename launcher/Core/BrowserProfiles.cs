using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace BlueprintLauncher.Core;

/// <summary>Folder, display name, optional theme color (ARGB) and avatar file path. Never email, cookies or history.</summary>
public sealed record Profile(string Browser, string Folder, string Name, uint? ThemeColor = null, string? AvatarFile = null);

public static class BrowserProfiles
{
    public static readonly string[] Browsers = BrowserCatalog.All.Select(b => b.Id).ToArray();
    private const long MaxBytes = 10_000_000;
    private static readonly Regex FolderRx = new(@"^[A-Za-z0-9 _.-]{1,64}\z", RegexOptions.CultureInvariant);

    public static bool IsValidFolder(string? s) => s is not null && s != "." && s != ".." && FolderRx.IsMatch(s);

    public static string LocalStatePath(string localAppData, string browser) => browser switch
    {
        "chrome" => Path.Combine(localAppData, "Google", "Chrome", "User Data", "Local State"),
        "edge" => Path.Combine(localAppData, "Microsoft", "Edge", "User Data", "Local State"),
        _ => CatalogLocalState(localAppData, browser),
    };

    /// <summary>Profiles of every supported browser. localAppData is injectable for tests.</summary>
    public static IReadOnlyList<Profile> List(string localAppData, string? appData = null)
    {
        var all = new List<Profile>();
        foreach (var b in Browsers) all.AddRange(ListFor(localAppData, appData, b));
        return all;
    }

    public static IReadOnlyList<Profile> ListFor(string localAppData, string browser) => ListFor(localAppData, null, browser);

    /// <summary>appData is only needed for Opera and Firefox; without it they return nothing.</summary>
    public static IReadOnlyList<Profile> ListFor(string localAppData, string? appData, string browser)
    {
        var info = BrowserCatalog.TryGet(browser);
        if (info is null) return new List<Profile>();
        return info.Family switch
        {
            BrowserFamily.Chromium => ListChromium(localAppData, info.Id),
            BrowserFamily.Opera => ListOpera(appData, info),
            BrowserFamily.Firefox => ListFirefox(appData, info),
            _ => new List<Profile>(),
        };
    }

    private static IReadOnlyList<Profile> ListChromium(string localAppData, string browser)
    {
        var result = new List<Profile>();
        try
        {
            var path = LocalStatePath(localAppData, browser);
            var userDataDir = Path.GetDirectoryName(path)!;
            var info = new FileInfo(path);
            if (!info.Exists || info.Length > MaxBytes) return result;
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var doc = JsonDocument.Parse(stream, new JsonDocumentOptions { AllowTrailingCommas = true, MaxDepth = 64 });
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return result;
            if (!doc.RootElement.TryGetProperty("profile", out var profile) || profile.ValueKind != JsonValueKind.Object) return result;
            if (!profile.TryGetProperty("info_cache", out var cache) || cache.ValueKind != JsonValueKind.Object) return result;
            foreach (var entry in cache.EnumerateObject())
            {
                var folder = entry.Name;
                if (!IsValidFolder(folder) || entry.Value.ValueKind != JsonValueKind.Object) continue;
                string? name = null;
                if (entry.Value.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String) name = n.GetString();
                var avatar = Path.Combine(userDataDir, folder, AvatarName);
                result.Add(new Profile(browser, folder, CleanName(name, folder), ReadColor(entry.Value), File.Exists(avatar) ? avatar : null));
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException or ArgumentException)
        {
            return new List<Profile>();
        }
        return result.OrderBy(p => p.Folder, StringComparer.Ordinal).ToList();
    }

    private const string AvatarName = "Google Profile Picture.png";
    private static readonly string[] ColorKeys = { "default_avatar_fill_color", "profile_highlight_color" };

    /// <summary>Firefox gets the name as its own argument after -P, so a leading '-' could be read as an option.</summary>
    public static bool IsValidFirefoxProfileName(string? s) => IsValidFolder(s) && s![0] != '-';

    public static bool IsValidProfileId(string? browser, string? folder) =>
        BrowserCatalog.TryGet(browser) is { Family: BrowserFamily.Firefox } ? IsValidFirefoxProfileName(folder) : IsValidFolder(folder);

    private static string CatalogLocalState(string localAppData, string browser)
    {
        var info = BrowserCatalog.TryGet(browser);
        if (info is null || info.Family != BrowserFamily.Chromium) throw new ArgumentException("unknown browser", nameof(browser));
        return Path.Combine(localAppData, info.UserDataRelative, "Local State");
    }

    /// <summary>ARGB from default_avatar_fill_color, else profile_highlight_color. Null when absent or not a 32-bit integer.</summary>
    private static uint? ReadColor(JsonElement entry)
    {
        foreach (var key in ColorKeys)
        {
            if (entry.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number
                && v.TryGetInt64(out var l) && l >= int.MinValue && l <= uint.MaxValue)
            {
                return unchecked((uint)l);
            }
        }
        return null;
    }

    private static IReadOnlyList<Profile> ListOpera(string? appData, BrowserInfo info)
    {
        var result = new List<Profile>();
        if (string.IsNullOrEmpty(appData)) return result;
        try
        {
            var dir = Path.Combine(appData, info.UserDataRelative);
            if (Directory.Exists(dir)) result.Add(new Profile(info.Id, Path.GetFileName(dir), "Opera"));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return new List<Profile>();
        }
        return result;
    }

    private static IReadOnlyList<Profile> ListFirefox(string? appData, BrowserInfo info)
    {
        var result = new List<Profile>();
        if (string.IsNullOrEmpty(appData)) return result;
        try
        {
            var path = Path.Combine(appData, info.UserDataRelative, "profiles.ini");
            var fi = new FileInfo(path);
            if (!fi.Exists || fi.Length > MaxBytes) return result;
            string text;
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var reader = new StreamReader(stream))
            {
                text = reader.ReadToEnd();
            }
            var dev = info.Id == "firefox-dev";
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var name in ParseIniProfileNames(text))
            {
                if (!IsValidFirefoxProfileName(name)) continue;
                if (name.StartsWith("dev-edition", StringComparison.Ordinal) != dev) continue;
                if (seen.Add(name)) result.Add(new Profile(info.Id, name, name));
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return new List<Profile>();
        }
        return result.OrderBy(p => p.Folder, StringComparer.Ordinal).ToList();
    }

    /// <summary>Only the Name key of [Profile...] sections. Everything else in the file is ignored.</summary>
    private static IEnumerable<string> ParseIniProfileNames(string text)
    {
        var inProfile = false;
        foreach (var raw in text.Split('\n'))
        {
            var line = raw.Trim();
            if (line.Length == 0 || line[0] == ';' || line[0] == '#') continue;
            if (line[0] == '[')
            {
                inProfile = line.EndsWith(']') && line.StartsWith("[Profile", StringComparison.OrdinalIgnoreCase);
                continue;
            }
            if (!inProfile) continue;
            var eq = line.IndexOf('=');
            if (eq <= 0) continue;
            if (line.Substring(0, eq).Trim().Equals("Name", StringComparison.OrdinalIgnoreCase)) yield return line.Substring(eq + 1).Trim();
        }
    }

    internal static string CleanName(string? name, string fallback)
    {
        if (name is null) return fallback;
        var sb = new StringBuilder();
        foreach (var c in name)
        {
            if (c >= ' ' && c != (char)0x7F) sb.Append(c);
        }
        var cleaned = sb.ToString().Trim();
        if (cleaned.Length > 100) cleaned = cleaned.Substring(0, 100);
        return cleaned.Length == 0 ? fallback : cleaned;
    }
}
