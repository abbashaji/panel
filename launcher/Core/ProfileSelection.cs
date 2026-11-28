using System.Security;
using System.Text.Json;

namespace BlueprintLauncher.Core;

/// <summary>The person's chosen browser profiles, saved in %LOCALAPPDATA%\BlueprintLauncher\profiles.json. Only browser id and folder are stored. A missing, corrupt or oversized file means 'no saved list' (everything is offered, as before).</summary>
public sealed class ProfileSelection
{
    public const int MaxEntries = 200;
    private const long MaxBytes = 262_144;

    private static readonly ProfileSelection NoList = new(false, new List<(string Browser, string Folder)>(), new List<(string Browser, string Folder)>());

    private readonly List<(string Browser, string Folder)> _selected;
    private readonly HashSet<(string, string)> _selectedSet;
    private readonly HashSet<(string, string)> _seenSet;

    private ProfileSelection(bool has, List<(string Browser, string Folder)> selected, List<(string Browser, string Folder)> seen)
    {
        HasSavedList = has;
        _selected = selected;
        _selectedSet = new HashSet<(string, string)>(selected);
        _seenSet = new HashSet<(string, string)>(seen);
    }

    public bool HasSavedList { get; }

    public static string DefaultPath() =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "BlueprintLauncher", "profiles.json");

    public static ProfileSelection Load(string path)
    {
        try
        {
            var fi = new FileInfo(path);
            if (!fi.Exists || fi.Length > MaxBytes) return NoList;
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var doc = JsonDocument.Parse(stream, new JsonDocumentOptions { MaxDepth = 16 });
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return NoList;
            if (!root.TryGetProperty("version", out var v) || v.ValueKind != JsonValueKind.Number || !v.TryGetInt32(out var ver) || ver != 1) return NoList;
            var selected = ReadList(root, "selected");
            var seen = ReadList(root, "seen");
            if (selected is null || seen is null) return NoList;
            return new ProfileSelection(true, selected, seen);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException or SecurityException or ArgumentException or NotSupportedException or InvalidOperationException)
        {
            return NoList;
        }
    }

    /// <summary>Detected profiles that are selected, in detected order. Without a saved list: all detected.</summary>
    public IReadOnlyList<Profile> Filter(IReadOnlyList<Profile> detected)
    {
        if (!HasSavedList) return detected;
        return detected.Where(p => _selectedSet.Contains((p.Browser, p.Folder))).ToList();
    }

    /// <summary>Detected profiles that were not there when the list was last saved. Empty without a saved list.</summary>
    public IReadOnlyList<Profile> NewSinceSaved(IReadOnlyList<Profile> detected)
    {
        if (!HasSavedList) return new List<Profile>();
        return detected.Where(p => !_seenSet.Contains((p.Browser, p.Folder))).ToList();
    }

    /// <summary>Selected entries that are no longer detected.</summary>
    public IReadOnlyList<(string Browser, string Folder)> Missing(IReadOnlyList<Profile> detected)
    {
        if (!HasSavedList) return new List<(string Browser, string Folder)>();
        var present = new HashSet<(string, string)>(detected.Select(p => (p.Browser, p.Folder)));
        return _selected.Where(s => !present.Contains(s)).ToList();
    }

    /// <summary>selected = ticked entries that are detected, seen = every detected profile. Temp file, then move. Returns false instead of throwing when the disk cannot be written.</summary>
    public static bool Save(string path, IReadOnlyList<Profile> detected, IReadOnlyCollection<(string, string)> ticked)
    {
        string? tmp = null;
        try
        {
            var tickSet = new HashSet<(string, string)>(ticked);
            var selected = new List<(string, string)>();
            var seen = new List<(string, string)>();
            var seenSet = new HashSet<(string, string)>();
            foreach (var p in detected)
            {
                if (!BrowserCatalog.IsKnown(p.Browser) || !BrowserProfiles.IsValidProfileId(p.Browser, p.Folder)) continue;
                var key = (p.Browser, p.Folder);
                if (!seenSet.Add(key)) continue;
                if (seen.Count < MaxEntries) seen.Add(key);
                if (selected.Count < MaxEntries && tickSet.Contains(key)) selected.Add(key);
            }
            var dir = Path.GetDirectoryName(Path.GetFullPath(path));
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            tmp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            using (var fs = new FileStream(tmp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            using (var w = new Utf8JsonWriter(fs))
            {
                w.WriteStartObject();
                w.WriteNumber("version", 1);
                WriteList(w, "selected", selected);
                WriteList(w, "seen", seen);
                w.WriteEndObject();
            }
            File.Move(tmp, path, true);
            return true;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or SecurityException or NotSupportedException or ArgumentException)
        {
            if (tmp is not null)
            {
                try { File.Delete(tmp); }
                catch (Exception d) when (d is IOException or UnauthorizedAccessException or SecurityException) { }
            }
            return false;
        }
    }

    private static void WriteList(Utf8JsonWriter w, string name, List<(string, string)> items)
    {
        w.WriteStartArray(name);
        foreach (var (browser, folder) in items)
        {
            w.WriteStartObject();
            w.WriteString("browser", browser);
            w.WriteString("folder", folder);
            w.WriteEndObject();
        }
        w.WriteEndArray();
    }

    private static List<(string Browser, string Folder)>? ReadList(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out var arr) || arr.ValueKind != JsonValueKind.Array) return null;
        if (arr.GetArrayLength() > MaxEntries) return null;
        var list = new List<(string Browser, string Folder)>();
        var dedupe = new HashSet<(string, string)>();
        foreach (var e in arr.EnumerateArray())
        {
            if (e.ValueKind != JsonValueKind.Object) return null;
            var b = Str(e, "browser");
            var f = Str(e, "folder");
            if (!BrowserCatalog.IsKnown(b) || !BrowserProfiles.IsValidProfileId(b, f)) continue;
            if (dedupe.Add((b!, f!))) list.Add((b!, f!));
        }
        return list;
    }

    private static string? Str(JsonElement obj, string name) =>
        obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
}
