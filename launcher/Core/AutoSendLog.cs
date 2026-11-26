using System.Text;

namespace BlueprintLauncher.Core;

/// <summary>Diagnostics for auto-send. Never receives prompt text, URLs, repo names or page text.</summary>
public interface IAutoSendLog
{
    void Write(string decision, params (string Key, string Value)[] fields);
}

public sealed class NullAutoSendLog : IAutoSendLog
{
    public static readonly NullAutoSendLog Instance = new();
    private NullAutoSendLog() { }
    public void Write(string decision, params (string Key, string Value)[] fields) { }
}

/// <summary>Appends 'yyyy-MM-dd HH:mm:ss decision key=value ...' to autosend.log. Never throws; the file stays under 64 KB.</summary>
public sealed class FileAutoSendLog : IAutoSendLog
{
    public const string FileName = "autosend.log";
    private const int MaxBytes = 64 * 1024;
    private const int MaxToken = 40;
    private const int MaxLine = 2000;
    private static readonly object Gate = new();
    private static readonly UTF8Encoding Utf8 = new(false);

    private readonly string _directory;

    public FileAutoSendLog(string directory) => _directory = directory;

    public void Write(string decision, params (string Key, string Value)[] fields)
    {
        try
        {
            var sb = new StringBuilder();
            sb.Append(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", System.Globalization.CultureInfo.InvariantCulture));
            sb.Append(' ').Append(Sanitize(decision, "-"));
            if (fields is not null)
            {
                foreach (var (key, value) in fields)
                {
                    sb.Append(' ').Append(Sanitize(key, "-")).Append('=').Append(Sanitize(value, ""));
                    if (sb.Length >= MaxLine) break;
                }
            }
            if (sb.Length > MaxLine) sb.Length = MaxLine;
            sb.Append('\n');
            var bytes = Utf8.GetBytes(sb.ToString());

            lock (Gate)
            {
                Directory.CreateDirectory(_directory);
                var path = Path.Combine(_directory, FileName);
                var info = new FileInfo(path);
                if (info.Exists && info.Length + bytes.Length >= MaxBytes) DropOldestHalf(path);
                using var stream = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read);
                stream.Write(bytes, 0, bytes.Length);
            }
        }
        catch (Exception)
        {
            // never throws
        }
    }

    /// <summary>Keeps the newer half, cut at a line boundary.</summary>
    private static void DropOldestHalf(string path)
    {
        var data = File.ReadAllBytes(path);
        var mid = data.Length / 2;
        var nl = Array.IndexOf(data, (byte)'\n', mid);
        var keep = nl < 0 ? Array.Empty<byte>() : data[(nl + 1)..];
        File.WriteAllBytes(path, keep);
    }

    private static string Sanitize(string? s, string fallback)
    {
        if (string.IsNullOrEmpty(s)) return fallback;
        var sb = new StringBuilder(Math.Min(s.Length, MaxToken));
        foreach (var ch in s)
        {
            if (ch == '\r' || ch == '\n') continue;
            sb.Append(char.IsWhiteSpace(ch) ? '_' : ch);
            if (sb.Length >= MaxToken) break;
        }
        return sb.Length == 0 ? fallback : sb.ToString();
    }
}
