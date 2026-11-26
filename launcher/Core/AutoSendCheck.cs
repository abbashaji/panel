using System.Globalization;
using System.Text;

namespace BlueprintLauncher.Core;

/// <summary>One named moment in a check: milliseconds since the launch and the window state at that moment.</summary>
public sealed record CheckMark(string Name, long Ms, string State);

/// <summary>Collects the marks of one read-only check. Each name is recorded once, the first time it is true.</summary>
public sealed class CheckTimeline
{
    private readonly List<CheckMark> _marks = new();

    public IReadOnlyList<CheckMark> Marks => _marks;

    /// <summary>The first failing condition of the most recent read. NoWindow until something was read.</summary>
    public AutoSendReason LastReason { get; set; } = AutoSendReason.NoWindow;

    public bool Has(string name)
    {
        foreach (var m in _marks)
        {
            if (string.Equals(m.Name, name, StringComparison.Ordinal)) return true;
        }
        return false;
    }

    public void Mark(string name, long ms, string state)
    {
        if (Has(name)) return;
        _marks.Add(new CheckMark(name, Math.Max(0, ms), state));
    }

    public long? ReadyMs
    {
        get
        {
            foreach (var m in _marks)
            {
                if (m.Name == AutoSendCheck.Ready) return m.Ms;
            }
            return null;
        }
    }

    public bool IsReady => ReadyMs is not null;
}

/// <summary>The pure check logic. No Windows types, no Send: it only judges snapshots.</summary>
public static class AutoSendCheck
{
    /// <summary>The fixed, harmless text the check window is opened with.</summary>
    public const string CheckText = "Blueprint auto-send check. Do not send.";

    public const string WindowFound = "windowFound";
    public const string DocumentFound = "documentFound";
    public const string ComposerFound = "composerFound";
    public const string ComposerTextMatches = "composerTextMatches";
    public const string SendButtonFound = "sendButtonFound";
    public const string SendButtonEnabled = "sendButtonEnabled";
    public const string Ready = "ready";

    /// <summary>The first condition that fails, in the engine's fixed order. None means ready.</summary>
    public static AutoSendReason Evaluate(PageSnapshot s, string expected)
    {
        if (!s.WindowFound) return AutoSendReason.NoWindow;
        if (!s.DocumentFound) return AutoSendReason.NoDocument;
        if (!s.ComposerFound) return AutoSendReason.NoComposer;
        if (!SameText(s.ComposerText, expected)) return AutoSendReason.TextMismatch;
        if (!s.SendFound) return AutoSendReason.SendNotFound;
        if (!s.SendEnabled) return AutoSendReason.SendDisabled;
        return AutoSendReason.None;
    }

    /// <summary>Records every condition that is true in this snapshot and returns the verdict reason.</summary>
    public static AutoSendReason Observe(CheckTimeline timeline, PageSnapshot s, long ms)
    {
        var state = NormalizeState(s.WindowState);
        if (s.WindowFound) timeline.Mark(WindowFound, ms, state);
        if (s.DocumentFound) timeline.Mark(DocumentFound, ms, state);
        if (s.ComposerFound) timeline.Mark(ComposerFound, ms, state);
        if (s.ComposerFound && SameText(s.ComposerText, CheckText)) timeline.Mark(ComposerTextMatches, ms, state);
        if (s.SendFound) timeline.Mark(SendButtonFound, ms, state);
        if (s.SendEnabled) timeline.Mark(SendButtonEnabled, ms, state);
        var reason = Evaluate(s, CheckText);
        timeline.LastReason = reason;
        if (reason == AutoSendReason.None) timeline.Mark(Ready, ms, state);
        return reason;
    }

    /// <summary>Whitespace-insensitive, ordinal equality.</summary>
    public static bool SameText(string? actual, string expected)
    {
        if (actual is null) return false;
        return string.Equals(StripWhitespace(actual), StripWhitespace(expected), StringComparison.Ordinal);
    }

    public static string NormalizeState(string? state)
    {
        var s = (state ?? string.Empty).Trim().ToLowerInvariant();
        return s is "foreground" or "background" or "minimized" or "hidden" ? s : "unknown";
    }

    private static string StripWhitespace(string s)
    {
        var sb = new StringBuilder(s.Length);
        foreach (var c in s)
        {
            if (!char.IsWhiteSpace(c)) sb.Append(c);
        }
        return sb.ToString();
    }
}

/// <summary>Plain text report of a check. Holds only ids, numbers and fixed words: never prompt text, profile names, titles or page text.</summary>
public static class CheckReport
{
    public static string Format(string browserId, string windowsVersion, CheckTimeline timeline, int timeoutMs = 60000)
    {
        var sb = new StringBuilder();
        sb.Append("Blueprint auto-send check (read-only, nothing was sent)\n");
        sb.Append("browser: ").Append(Safe(browserId, 24)).Append('\n');
        sb.Append("windows: ").Append(Safe(windowsVersion, 32)).Append('\n');
        sb.Append("timeline:\n");
        if (timeline.Marks.Count == 0) sb.Append("(no marks)\n");
        foreach (var m in timeline.Marks)
        {
            sb.Append(Safe(m.Name, 32)).Append('=')
                .Append(m.Ms.ToString(CultureInfo.InvariantCulture))
                .Append('(').Append(AutoSendCheck.NormalizeState(m.State)).Append(")\n");
        }
        if (timeline.ReadyMs is { } ready)
        {
            sb.Append("READY at ").Append(ready.ToString(CultureInfo.InvariantCulture)).Append(" ms\n");
        }
        else
        {
            var reason = timeline.LastReason == AutoSendReason.None ? AutoSendReason.NoWindow : timeline.LastReason;
            sb.Append("NOT READY: ").Append(reason.ToString()).Append(" - ").Append(Hint(reason))
                .Append(" (not ready within ").Append(timeoutMs.ToString(CultureInfo.InvariantCulture)).Append(" ms)\n");
        }
        return sb.ToString();
    }

    private static string Hint(AutoSendReason reason) => reason switch
    {
        AutoSendReason.NoWindow => "the browser window was not found",
        AutoSendReason.NoDocument => "this browser does not show the page to Windows UI Automation",
        AutoSendReason.NoComposer => "the prompt box was not found",
        AutoSendReason.TextMismatch => "the prompt box did not hold the check text",
        AutoSendReason.SendNotFound => "the Send button was not found",
        AutoSendReason.SendDisabled => "the Send button stayed disabled",
        _ => "no ready state",
    };

    /// <summary>Keeps letters, digits, dot, dash and underscore only, so nothing personal can slip in.</summary>
    private static string Safe(string? value, int max)
    {
        var sb = new StringBuilder();
        foreach (var c in value ?? string.Empty)
        {
            if (sb.Length >= max) break;
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c is '.' or '-' or '_') sb.Append(c);
        }
        return sb.Length == 0 ? "unknown" : sb.ToString();
    }
}
