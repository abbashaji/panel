using System.Text;
using System.Text.RegularExpressions;

namespace BlueprintLauncher.Core;

public enum CommandKind { Start, Open, Sync }

/// <summary>Typed result of parsing a blueprint:// URL. Ok=false carries a rejection reason.</summary>
public sealed record ParseResult
{
    public bool Ok { get; init; }
    public string? Reason { get; init; }
    public CommandKind Kind { get; init; }
    public string Repo { get; init; } = "";
    public string Cell { get; init; } = "";
    public string Who { get; init; } = "";
    public IReadOnlyList<string> Merged { get; init; } = Array.Empty<string>();

    internal static ParseResult Reject(string reason) => new() { Ok = false, Reason = reason };
}

/// <summary>Strict parser for the launcher protocol. The URL is hostile input.</summary>
public static class ProtocolParser
{
    public const int MaxUrlLength = 400;
    private const int MaxMerged = 50;
    private const string Prefix = "blueprint://";

    private static readonly string[] StartKeys = { "repo", "cell", "who" };
    private static readonly string[] OpenKeys = { "repo", "cell" };
    private static readonly string[] SyncKeys = { "repo", "merged" };

    // ASCII-only on purpose (same meaning as a JavaScript \w).
    private static readonly Regex RepoRx = new(@"^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}\z", RegexOptions.CultureInvariant);
    private static readonly Regex CellRx = new(@"^C-[0-9]{3,5}\z", RegexOptions.CultureInvariant);
    private static readonly Regex WhoRx = new(@"^[A-Za-z0-9_ .-]{1,40}\z", RegexOptions.CultureInvariant);

    public static bool IsValidRepo(string? s) => s is not null && RepoRx.IsMatch(s);
    public static bool IsValidCell(string? s) => s is not null && CellRx.IsMatch(s);
    public static bool IsValidWho(string? s) => s is not null && WhoRx.IsMatch(s);

    public static ParseResult Parse(string? url)
    {
        if (string.IsNullOrEmpty(url)) return ParseResult.Reject("empty url");
        if (url.Length > MaxUrlLength) return ParseResult.Reject("url too long");
        foreach (var ch in url)
        {
            if (ch <= ' ' || ch >= (char)0x7F) return ParseResult.Reject("control, space or non-ASCII character");
        }
        if (!url.StartsWith(Prefix, StringComparison.Ordinal)) return ParseResult.Reject("bad scheme");

        var rest = url.Substring(Prefix.Length);
        if (rest.Contains('#')) return ParseResult.Reject("fragment not allowed");
        var q = rest.IndexOf('?');
        if (q < 0) return ParseResult.Reject("missing query");
        var command = rest.Substring(0, q);
        // Windows and browsers normalise blueprint://start?x into blueprint://start/?x. Accept exactly one slash.
        if (command.EndsWith("/", StringComparison.Ordinal)) command = command.Substring(0, command.Length - 1);
        var query = rest.Substring(q + 1);

        CommandKind kind;
        string[] keys;
        switch (command)
        {
            case "start": kind = CommandKind.Start; keys = StartKeys; break;
            case "open": kind = CommandKind.Open; keys = OpenKeys; break;
            case "sync": kind = CommandKind.Sync; keys = SyncKeys; break;
            default: return ParseResult.Reject("unknown command");
        }
        if (query.Length == 0) return ParseResult.Reject("empty query");

        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var pair in query.Split('&'))
        {
            var eq = pair.IndexOf('=');
            if (eq <= 0) return ParseResult.Reject("malformed pair");
            var key = pair.Substring(0, eq);
            var raw = pair.Substring(eq + 1);
            if (raw.Contains('=')) return ParseResult.Reject("malformed pair");
            if (Array.IndexOf(keys, key) < 0) return ParseResult.Reject("unexpected key");
            if (values.ContainsKey(key)) return ParseResult.Reject("duplicate key");
            var decoded = PercentDecode(raw);
            if (decoded is null) return ParseResult.Reject("bad percent-encoding");
            values[key] = decoded;
        }
        foreach (var k in keys)
        {
            if (!values.ContainsKey(k)) return ParseResult.Reject("missing key " + k);
        }

        var repo = values["repo"];
        if (!IsValidRepo(repo)) return ParseResult.Reject("invalid repo");

        if (kind == CommandKind.Sync)
        {
            var ids = values["merged"].Split(',');
            if (ids.Length > MaxMerged) return ParseResult.Reject("too many merged ids");
            foreach (var id in ids)
            {
                if (!IsValidCell(id)) return ParseResult.Reject("invalid merged id");
            }
            return new ParseResult { Ok = true, Kind = kind, Repo = repo, Merged = ids.Distinct(StringComparer.Ordinal).ToList() };
        }

        var cell = values["cell"];
        if (!IsValidCell(cell)) return ParseResult.Reject("invalid cell");
        if (kind == CommandKind.Open)
        {
            return new ParseResult { Ok = true, Kind = kind, Repo = repo, Cell = cell };
        }

        var who = values["who"];
        if (!IsValidWho(who)) return ParseResult.Reject("invalid who");
        return new ParseResult { Ok = true, Kind = kind, Repo = repo, Cell = cell, Who = who };
    }

    /// <summary>Decodes %XX once. Returns null on a bad sequence or invalid UTF-8. Input must already be ASCII.</summary>
    private static string? PercentDecode(string s)
    {
        var bytes = new List<byte>(s.Length);
        for (var i = 0; i < s.Length; i++)
        {
            var c = s[i];
            if (c == '%')
            {
                if (i + 2 >= s.Length) return null;
                if (!Uri.IsHexDigit(s[i + 1]) || !Uri.IsHexDigit(s[i + 2])) return null;
                bytes.Add((byte)((Uri.FromHex(s[i + 1]) << 4) | Uri.FromHex(s[i + 2])));
                i += 2;
            }
            else
            {
                bytes.Add((byte)c);
            }
        }
        try
        {
            return new UTF8Encoding(false, true).GetString(bytes.ToArray());
        }
        catch (ArgumentException)
        {
            return null;
        }
    }
}
