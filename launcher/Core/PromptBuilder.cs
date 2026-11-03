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

    private static string Strip(string s) => s.Replace("<", "").Replace(">", "");
}
