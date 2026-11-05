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
