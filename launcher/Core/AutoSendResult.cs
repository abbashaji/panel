namespace BlueprintLauncher.Core;

public enum AutoSendOutcome { Sent, NotConfirmed, NotSent, Cancelled }

public enum AutoSendReason
{
    None,
    RepoNotAllowed,
    RateLimited,
    NoWindow,
    NoDocument,
    NoComposer,
    TextMismatch,
    SendNotFound,
    SendDisabled,
    PageChanged,
    Refused,
}

/// <summary>One auto-send attempt: the repo and cell of the launch and the exact prompt that was pre-filled.</summary>
public sealed record AutoSendRequest(string Repo, string Cell, string ExpectedPrompt);

/// <summary>Phase is one of waiting, countdown, sending, confirming.</summary>
public sealed record AutoSendProgress(string Phase, int SecondsLeft);

public sealed record AutoSendResult(AutoSendOutcome Outcome, AutoSendReason Reason, long ElapsedMs, string WindowStateAtSend)
{
    /// <summary>Text for the teammate. Every failure ends with 'Press Send yourself' except the ones that need a look at the chat.</summary>
    public string PlainText() => Outcome switch
    {
        AutoSendOutcome.Sent => "Sent.",
        AutoSendOutcome.NotConfirmed => "Send was pressed but the chat did not confirm it. Look at the chat window.",
        AutoSendOutcome.Cancelled => "Cancelled. Press Send yourself if you still want it.",
        _ => Reason switch
        {
            AutoSendReason.RepoNotAllowed => "Auto-send is not allowed for this repo on this PC. Press Send yourself.",
            AutoSendReason.RateLimited => "Too many auto-sends in 10 minutes. Press Send yourself.",
            AutoSendReason.NoWindow => "The browser window was not found. Press Send yourself.",
            AutoSendReason.NoDocument => "This browser does not show the page to Windows UI Automation. Press Send yourself.",
            AutoSendReason.NoComposer => "The prompt box was not found. Press Send yourself.",
            AutoSendReason.TextMismatch => "The prompt was changed. Press Send yourself.",
            AutoSendReason.SendNotFound => "The Send button was not available. Press Send yourself.",
            AutoSendReason.SendDisabled => "The Send button was not available. Press Send yourself.",
            AutoSendReason.PageChanged => "The page changed during the countdown. Press Send yourself.",
            AutoSendReason.Refused => "Windows refused the click. Press Send yourself.",
            _ => "Not sent. Press Send yourself.",
        },
    };
}
