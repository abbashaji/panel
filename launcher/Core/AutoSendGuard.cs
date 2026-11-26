using System.Text.Json;

namespace BlueprintLauncher.Core;

/// <summary>Local rate cap for auto-send: at most 12 sends per 10 minutes. Never throws.</summary>
public sealed class AutoSendGuard
{
    public const string FileName = "autosend-sends.json";
    public const int MaxSends = 12;
    public const int MaxEntries = 50;
    private const long MaxBytes = 64 * 1024;
    private static readonly TimeSpan Window = TimeSpan.FromMinutes(10);

    private readonly string _directory;
    private readonly Func<DateTimeOffset> _now;

    public AutoSendGuard(string directory, Func<DateTimeOffset>? now = null)
    {
        _directory = directory;
        _now = now ?? (() => DateTimeOffset.UtcNow);
    }

    private string FilePath => Path.Combine(_directory, FileName);

    /// <summary>False with reason 'rate limit' when 12 or more sends were recorded in the last 10 minutes.</summary>
    public bool CanSend(out string reason)
    {
        reason = "";
        try
        {
            var nowMs = _now().ToUnixTimeMilliseconds();
            var recent = ReadTimes().Count(t => IsRecent(t, nowMs));
            if (recent >= MaxSends)
            {
                reason = "rate limit";
                return false;
            }
        }
        catch (Exception)
        {
            // never throws; an unreadable state counts as no sends
        }
        return true;
    }

    /// <summary>Appends the current time. Keeps at most 50 entries. Never throws.</summary>
    public void RecordSend()
    {
        string? tmp = null;
        try
        {
            var nowMs = _now().ToUnixTimeMilliseconds();
            var times = ReadTimes().Where(t => IsRecent(t, nowMs)).ToList();
            times.Add(nowMs);
            if (times.Count > MaxEntries) times = times.GetRange(times.Count - MaxEntries, MaxEntries);
            Directory.CreateDirectory(_directory);
            tmp = Path.Combine(_directory, FileName + "." + Guid.NewGuid().ToString("N") + ".tmp");
            File.WriteAllText(tmp, JsonSerializer.Serialize(times));
            File.Move(tmp, FilePath, true);
        }
        catch (Exception)
        {
            // never throws
        }
        finally
        {
            try { if (tmp is not null && File.Exists(tmp)) File.Delete(tmp); } catch (Exception) { }
        }
    }

    private static bool IsRecent(long t, long nowMs) => t <= nowMs && t > nowMs - (long)Window.TotalMilliseconds;

    /// <summary>Missing, corrupt or oversized file gives an empty list. Non-number entries are skipped.</summary>
    private List<long> ReadTimes()
    {
        var result = new List<long>();
        try
        {
            var info = new FileInfo(FilePath);
            if (!info.Exists || info.Length > MaxBytes) return result;
            using var doc = JsonDocument.Parse(File.ReadAllText(FilePath));
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return result;
            foreach (var item in doc.RootElement.EnumerateArray())
            {
                if (item.ValueKind == JsonValueKind.Number && item.TryGetInt64(out var v)) result.Add(v);
            }
        }
        catch (Exception)
        {
            return new List<long>();
        }
        return result;
    }
}
