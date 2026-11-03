using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace BlueprintLauncher.Core;

/// <summary>Only folder and display name. Never email, cookies or history.</summary>
public sealed record Profile(string Browser, string Folder, string Name);

public static class BrowserProfiles
{
    public static readonly string[] Browsers = { "chrome", "edge" };
    private const long MaxBytes = 10_000_000;
    private static readonly Regex FolderRx = new(@"^[A-Za-z0-9 _.-]{1,64}\z", RegexOptions.CultureInvariant);

    public static bool IsValidFolder(string? s) => s is not null && s != "." && s != ".." && FolderRx.IsMatch(s);

    public static string LocalStatePath(string localAppData, string browser) => browser switch
    {
        "chrome" => Path.Combine(localAppData, "Google", "Chrome", "User Data", "Local State"),
        "edge" => Path.Combine(localAppData, "Microsoft", "Edge", "User Data", "Local State"),
        _ => throw new ArgumentException("unknown browser", nameof(browser)),
    };

    /// <summary>Profiles of every supported browser. localAppData is injectable for tests.</summary>
    public static IReadOnlyList<Profile> List(string localAppData)
    {
        var all = new List<Profile>();
        foreach (var b in Browsers) all.AddRange(ListFor(localAppData, b));
        return all;
    }

    public static IReadOnlyList<Profile> ListFor(string localAppData, string browser)
    {
        var result = new List<Profile>();
        try
        {
            var path = LocalStatePath(localAppData, browser);
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
                result.Add(new Profile(browser, folder, CleanName(name, folder)));
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException or ArgumentException)
        {
            return new List<Profile>();
        }
        return result.OrderBy(p => p.Folder, StringComparer.Ordinal).ToList();
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
