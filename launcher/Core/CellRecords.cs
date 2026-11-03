using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace BlueprintLauncher.Core;

public sealed record CellRecord
{
    public string Browser { get; init; } = "";
    public string ProfileFolder { get; init; } = "";
    public string ProfileName { get; init; } = "";
    public DateTimeOffset StartedAt { get; init; }
    public string? ChatUrl { get; init; }
}

/// <summary>%LOCALAPPDATA%\BlueprintLauncher\cells.json. Directory and clock are injectable.</summary>
public sealed class CellRecords
{
    public const string FileName = "cells.json";
    public static readonly TimeSpan MaxAge = TimeSpan.FromDays(14);
    private const long MaxBytes = 5_000_000;

    private static readonly Regex ChatRx = new(@"^https://claude\.ai/chat/[0-9a-f-]{36}\z", RegexOptions.CultureInvariant);
    private static readonly Regex KeyRx = new(@"^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100} C-[0-9]{3,5}\z", RegexOptions.CultureInvariant);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly string _dir;
    private readonly Func<DateTimeOffset> _clock;

    public CellRecords(string directory, Func<DateTimeOffset>? clock = null)
    {
        _dir = directory;
        _clock = clock ?? (() => DateTimeOffset.UtcNow);
    }

    public string FilePath => Path.Combine(_dir, FileName);

    public static string DefaultDirectory(string localAppData) => Path.Combine(localAppData, "BlueprintLauncher");

    public static string Key(string repo, string cell) => repo + " " + cell;

    public static bool IsValidChatUrl(string? url) => url is not null && ChatRx.IsMatch(url);

    /// <summary>Loads and sanitizes. Missing or corrupt file gives an empty map.</summary>
    public Dictionary<string, CellRecord> Load()
    {
        var result = new Dictionary<string, CellRecord>(StringComparer.Ordinal);
        try
        {
            var info = new FileInfo(FilePath);
            if (!info.Exists || info.Length > MaxBytes) return result;
            var raw = JsonSerializer.Deserialize<Dictionary<string, CellRecord?>>(File.ReadAllText(FilePath), Json);
            if (raw is null) return result;
            foreach (var (key, rec) in raw)
            {
                if (rec is null || !KeyRx.IsMatch(key)) continue;
                if (rec.Browser != "chrome" && rec.Browser != "edge") continue;
                if (!BrowserProfiles.IsValidFolder(rec.ProfileFolder)) continue;
                result[key] = rec with
                {
                    ProfileName = BrowserProfiles.CleanName(rec.ProfileName, rec.ProfileFolder),
                    ChatUrl = IsValidChatUrl(rec.ChatUrl) ? rec.ChatUrl : null,
                };
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException or NotSupportedException)
        {
            return new Dictionary<string, CellRecord>(StringComparer.Ordinal);
        }
        return result;
    }

    /// <summary>Atomic: temp file in the same directory, then replace.</summary>
    public void Save(IReadOnlyDictionary<string, CellRecord> records)
    {
        Directory.CreateDirectory(_dir);
        var tmp = Path.Combine(_dir, FileName + "." + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            File.WriteAllText(tmp, JsonSerializer.Serialize(records, Json));
            File.Move(tmp, FilePath, true);
        }
        catch
        {
            try { File.Delete(tmp); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            throw;
        }
    }

    public CellRecord Upsert(string repo, string cell, string browser, string profileFolder, string profileName)
    {
        if (!ProtocolParser.IsValidRepo(repo)) throw new ArgumentException("invalid repo", nameof(repo));
        if (!ProtocolParser.IsValidCell(cell)) throw new ArgumentException("invalid cell", nameof(cell));
        if (browser != "chrome" && browser != "edge") throw new ArgumentException("invalid browser", nameof(browser));
        if (!BrowserProfiles.IsValidFolder(profileFolder)) throw new ArgumentException("invalid profile folder", nameof(profileFolder));
        var rec = new CellRecord
        {
            Browser = browser,
            ProfileFolder = profileFolder,
            ProfileName = BrowserProfiles.CleanName(profileName, profileFolder),
            StartedAt = _clock(),
        };
        var all = Load();
        all[Key(repo, cell)] = rec;
        Save(all);
        return rec;
    }

    /// <summary>Stores the chat link only if it matches the strict pattern and the record exists.</summary>
    public bool SetChatUrl(string repo, string cell, string? chatUrl)
    {
        if (!ProtocolParser.IsValidRepo(repo) || !ProtocolParser.IsValidCell(cell)) return false;
        if (!IsValidChatUrl(chatUrl)) return false;
        var all = Load();
        var key = Key(repo, cell);
        if (!all.TryGetValue(key, out var rec)) return false;
        all[key] = rec with { ChatUrl = chatUrl };
        Save(all);
        return true;
    }

    /// <summary>Deletes records of merged cells for this repo. Returns how many were removed.</summary>
    public int Sync(string repo, IEnumerable<string> mergedIds)
    {
        if (!ProtocolParser.IsValidRepo(repo)) return 0;
        var all = Load();
        var removed = 0;
        foreach (var id in mergedIds)
        {
            if (ProtocolParser.IsValidCell(id) && all.Remove(Key(repo, id))) removed++;
        }
        if (removed > 0) Save(all);
        return removed;
    }

    /// <summary>Deletes records older than 14 days. Returns how many were removed.</summary>
    public int Cleanup(DateTimeOffset now)
    {
        var all = Load();
        var stale = all.Where(kv => now - kv.Value.StartedAt > MaxAge).Select(kv => kv.Key).ToList();
        foreach (var k in stale) all.Remove(k);
        if (stale.Count > 0) Save(all);
        return stale.Count;
    }

    public int Cleanup() => Cleanup(_clock());
}
