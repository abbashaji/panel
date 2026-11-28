namespace BlueprintLauncher.Core;

/// <summary>Which kind of prompt a launch carries.</summary>
public enum PromptKind { Cell, Steward }

/// <summary>
/// One policy for what may be pre-filled and auto-sent. Pure logic: no Windows types, no network, no logging.
/// A reason never contains the prompt text.
/// </summary>
public static class PromptPolicy
{
    /// <summary>Longest prompt in characters, measured after Sanitize (the text that is actually sent).</summary>
    public const int MaxLength = 1500;

    /// <summary>
    /// True when the text may be pre-filled and auto-sent. On false, reason is a short plain sentence for the window;
    /// on true it is empty.
    /// </summary>
    public static bool IsSendable(PromptKind kind, string repo, string? cell, string? text, out string reason)
    {
        reason = string.Empty;
        var raw = text ?? string.Empty;
        var clean = Sanitize(raw);
        if (clean.Length == 0)
        {
            reason = "The prompt is empty.";
            return false;
        }
        foreach (var c in raw)
        {
            if (char.IsControl(c) && c != '\n' && c != '\r' && c != '\t')
            {
                reason = "The prompt contains a control character.";
                return false;
            }
        }
        if (clean.Length > MaxLength)
        {
            reason = "The prompt is longer than " + MaxLength + " characters.";
            return false;
        }
        if (!ProtocolParser.IsValidRepo(repo))
        {
            reason = "The repo name is not valid.";
            return false;
        }
        if (kind == PromptKind.Cell)
        {
            if (cell is null || !ProtocolParser.IsValidCell(cell))
            {
                reason = "The cell id is not valid.";
                return false;
            }
            if (!clean.Contains("next_cell", StringComparison.Ordinal))
            {
                reason = "The prompt must still mention next_cell.";
                return false;
            }
            if (!ContainsToken(clean, "cell_id=" + cell))
            {
                reason = "The prompt must still mention cell_id=" + cell + ".";
                return false;
            }
            return true;
        }
        if (kind != PromptKind.Steward)
        {
            reason = "Unknown prompt kind.";
            return false;
        }
        if (!clean.Contains("steward_next", StringComparison.Ordinal))
        {
            reason = "The prompt must still mention steward_next.";
            return false;
        }
        return true;
    }

    /// <summary>Removes &lt; and &gt;, turns every line end into \n and trims both ends (same stripping as the fixed templates).</summary>
    public static string Sanitize(string text)
    {
        if (text is null) return string.Empty;
        return text.Replace("<", "").Replace(">", "").Replace("\r\n", "\n").Replace('\r', '\n').Trim();
    }

    private static bool IsWordChar(char c)
        => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_';

    /// <summary>The token must stand alone: not glued to a word before it, and not continued by a word character or '-' after it.</summary>
    private static bool ContainsToken(string text, string token)
    {
        var i = 0;
        while ((i = text.IndexOf(token, i, StringComparison.Ordinal)) >= 0)
        {
            var end = i + token.Length;
            var beforeOk = i == 0 || !IsWordChar(text[i - 1]);
            var afterOk = end >= text.Length || (!IsWordChar(text[end]) && text[end] != '-');
            if (beforeOk && afterOk) return true;
            i++;
        }
        return false;
    }
}
