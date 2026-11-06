using System.Text.RegularExpressions;

namespace BlueprintLauncher.Core;

/// <summary>Builds the pre-filled prompt URL from a fixed template and validated values only.</summary>
public static class PromptBuilder
{
    /// <summary>Fixed host, never taken from input.</summary>
    public const string BaseUrl = "https://claude.ai/new?q=";

    public static string BuildPrompt(string repo, string cell)
    {
        if (!ProtocolParser.IsValidRepo(repo)) throw new ArgumentException("invalid repo", nameof(repo));
        if (!ProtocolParser.IsValidCell(cell)) throw new ArgumentException("invalid cell", nameof(cell));
        var r = Strip(repo);
        var c = Strip(cell);
        return "Repo: " + r + "\n"
            + "Follow BLUEPRINT.md.\n"
            + "Call next_cell with repo and cell_id=" + c + " (reserved for me).\n"
            + "Do only that cell. Begin your next message with the CLAIMED line.";
    }

    public static string BuildUrl(string repo, string cell)
        => BaseUrl + Uri.EscapeDataString(BuildPrompt(repo, cell));

    /// <summary>Marker the browser userscript looks for to click send.</summary>
    public const string AutoSendSuffix = "&autosend=1";

    private static readonly Regex CellPromptRx = new(
        @"^Repo: ([A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100})\nFollow BLUEPRINT\.md\.\nCall next_cell with repo and cell_id=(C-[0-9]{3,5}) \(reserved for me\)\.\nDo only that cell\. Begin your next message with the CLAIMED line\.\z",
        RegexOptions.CultureInvariant);

    private static readonly Regex EncodedRx = new(@"^[A-Za-z0-9\-_.~%]+\z", RegexOptions.CultureInvariant);

    /// <summary>
    /// Appends the auto-send marker. Accepts only a URL produced by BuildUrl for a valid repo and cell.
    /// A steward URL, extra parameters, another host, an edited prompt or an already marked URL is rejected.
    /// </summary>
    public static string WithAutoSend(string url)
    {
        if (string.IsNullOrEmpty(url) || !url.StartsWith(BaseUrl, StringComparison.Ordinal))
            throw new ArgumentException("not a cell url", nameof(url));
        var encoded = url.Substring(BaseUrl.Length);
        if (!EncodedRx.IsMatch(encoded)) throw new ArgumentException("not a cell url", nameof(url));
        string decoded;
        try { decoded = Uri.UnescapeDataString(encoded); }
        catch (UriFormatException) { throw new ArgumentException("not a cell url", nameof(url)); }
        var m = CellPromptRx.Match(decoded);
        if (!m.Success) throw new ArgumentException("not a cell url", nameof(url));
        var repo = m.Groups[1].Value;
        var cell = m.Groups[2].Value;
        if (!ProtocolParser.IsValidRepo(repo) || !ProtocolParser.IsValidCell(cell))
            throw new ArgumentException("not a cell url", nameof(url));
        if (!string.Equals(BuildUrl(repo, cell), url, StringComparison.Ordinal))
            throw new ArgumentException("not a cell url", nameof(url));
        return url + AutoSendSuffix;
    }

    /// <summary>Fixed steward template. The only inserted text is the validated repo.</summary>
    public static string BuildStewardPrompt(string repo)
    {
        if (!ProtocolParser.IsValidRepo(repo)) throw new ArgumentException("invalid repo", nameof(repo));
        var r = Strip(repo);
        return "You are the Steward of " + r + ".\n"
            + "Call steward_next with repo and who.\n"
            + "When the tool asks for the admin key, ask me to paste it in this chat.\n"
            + "Never write the key into any file, commit, comment or message.\n"
            + "Follow the briefing and always take the first problem.\n"
            + "Call steward_next again after each solved problem.";
    }

    public static string BuildStewardUrl(string repo)
        => BaseUrl + Uri.EscapeDataString(BuildStewardPrompt(repo));

    private static string Strip(string s) => s.Replace("<", "").Replace(">", "");
}
