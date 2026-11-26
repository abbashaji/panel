using System.Diagnostics;
using System.Globalization;

namespace BlueprintLauncher.Core;

/// <summary>Time source of the send engine. Tests inject a clock that advances on DelayAsync.</summary>
public interface IAutoSendClock
{
    long NowMs { get; }
    Task DelayAsync(int ms, CancellationToken ct);
}

public sealed class SystemClock : IAutoSendClock
{
    private readonly Stopwatch _watch = Stopwatch.StartNew();
    public long NowMs => _watch.ElapsedMilliseconds;
    public Task DelayAsync(int ms, CancellationToken ct) => Task.Delay(Math.Max(0, ms), ct);
}

public sealed record AutoSendOptions(int PollMs = 250, int StableMs = 800, int CountdownMs = 3000, int TimeoutMs = 60000, int ConfirmMs = 12000);

/// <summary>
/// Decides when it is safe to press Send. Pure logic: no Windows types, no threads of its own.
/// PressSend is called at most once per RunAsync and never retried.
/// </summary>
public sealed class AutoSendEngine(IChatPage page, IAutoSendClock clock, LauncherSettings settings, AutoSendGuard guard, IAutoSendLog log, AutoSendOptions? options = null)
{
    private readonly AutoSendOptions _options = options ?? new AutoSendOptions();

    public async Task<AutoSendResult> RunAsync(AutoSendRequest request, IProgress<AutoSendProgress>? progress, CancellationToken cancel)
    {
        var poll = Math.Max(1, _options.PollMs);
        var stable = Math.Max(0, _options.StableMs);
        var timeout = Math.Max(0, _options.TimeoutMs);
        var start = clock.NowMs;
        var state = "unknown";

        AutoSendResult Finish(AutoSendOutcome outcome, AutoSendReason reason)
        {
            var ms = Math.Max(0, clock.NowMs - start);
            WriteLog(Decision(outcome), reason, ms, state);
            return new AutoSendResult(outcome, reason, ms, state);
        }

        void Report(string phase, int seconds)
        {
            try { progress?.Report(new AutoSendProgress(phase, seconds)); }
            catch (Exception) { /* a broken listener must not stop the engine */ }
        }

        // 1. Self check, the page is not touched.
        var expected = request?.ExpectedPrompt ?? string.Empty;
        if (request is null
            || !PromptBuilder.TryMatchCellPrompt(expected, out var repo, out var cell)
            || !string.Equals(repo, request.Repo, StringComparison.Ordinal)
            || !string.Equals(cell, request.Cell, StringComparison.Ordinal))
            return Finish(AutoSendOutcome.NotSent, AutoSendReason.TextMismatch);
        if (!settings.IsRepoAllowed(repo))
            return Finish(AutoSendOutcome.NotSent, AutoSendReason.RepoNotAllowed);
        if (!guard.CanSend(out _))
            return Finish(AutoSendOutcome.NotSent, AutoSendReason.RateLimited);

        // 2. Wait until ready without a break for StableMs.
        var waitStart = clock.NowMs;
        var stableSince = -1L;
        var lastReason = AutoSendReason.None;
        var lastSecond = -1;
        while (true)
        {
            if (cancel.IsCancellationRequested) return Finish(AutoSendOutcome.Cancelled, AutoSendReason.None);
            var snap = SafeRead();
            state = StateOf(snap);
            var reason = Check(snap, expected);
            var now = clock.NowMs;
            if (reason == AutoSendReason.None)
            {
                if (stableSince < 0) stableSince = now;
                if (now - stableSince >= stable) break;
            }
            else
            {
                stableSince = -1;
                lastReason = reason;
            }
            var elapsed = now - waitStart;
            if (elapsed >= timeout)
                return Finish(AutoSendOutcome.NotSent, lastReason != AutoSendReason.None ? lastReason : AutoSendReason.PageChanged);
            var left = Seconds(timeout - elapsed);
            if (left != lastSecond)
            {
                lastSecond = left;
                Report("waiting", left);
            }
            try { await clock.DelayAsync(poll, cancel).ConfigureAwait(false); }
            catch (OperationCanceledException) { return Finish(AutoSendOutcome.Cancelled, AutoSendReason.None); }
        }
        WriteLog("ready", AutoSendReason.None, Math.Max(0, clock.NowMs - start), state);

        // 3. Countdown with Cancel. PressSend is never called once cancelled here.
        var remaining = Math.Max(0, _options.CountdownMs);
        while (remaining > 0)
        {
            if (cancel.IsCancellationRequested) return Finish(AutoSendOutcome.Cancelled, AutoSendReason.None);
            Report("countdown", Seconds(remaining));
            var step = Math.Min(1000, remaining);
            try { await clock.DelayAsync(step, cancel).ConfigureAwait(false); }
            catch (OperationCanceledException) { return Finish(AutoSendOutcome.Cancelled, AutoSendReason.None); }
            remaining -= step;
        }
        if (cancel.IsCancellationRequested) return Finish(AutoSendOutcome.Cancelled, AutoSendReason.None);

        // 4. Read again. Never retry and never click blindly.
        var again = SafeRead();
        state = StateOf(again);
        if (Check(again, expected) != AutoSendReason.None)
            return Finish(AutoSendOutcome.NotSent, AutoSendReason.PageChanged);

        // 5. Record, then press exactly once. From here cancel is ignored.
        Report("sending", 0);
        guard.RecordSend();
        var pressed = false;
        try { pressed = page.PressSend(expected); }
        catch (Exception) { pressed = false; }
        if (!pressed) return Finish(AutoSendOutcome.NotSent, AutoSendReason.Refused);
        WriteLog("pressed", AutoSendReason.None, Math.Max(0, clock.NowMs - start), state);

        // 6. Confirm that the composer text is gone or the Send button is gone.
        var confirm = Math.Max(0, _options.ConfirmMs);
        var confirmStart = clock.NowMs;
        Report("confirming", Seconds(confirm));
        while (true)
        {
            try { await clock.DelayAsync(poll, CancellationToken.None).ConfigureAwait(false); }
            catch (OperationCanceledException) { /* cancel is ignored after the press */ }
            var s = SafeRead();
            if (s.Error is null)
            {
                if (!s.WindowFound) return Finish(AutoSendOutcome.NotConfirmed, AutoSendReason.None);
                if (s.DocumentFound && (!s.SendFound || !SameText(s.ComposerText, expected)))
                    return Finish(AutoSendOutcome.Sent, AutoSendReason.None);
            }
            if (clock.NowMs - confirmStart >= confirm) return Finish(AutoSendOutcome.NotConfirmed, AutoSendReason.None);
        }
    }

    private static readonly PageSnapshot Failed = new(false, false, false, null, false, false, "unknown", 0, 0, "read failed");

    private PageSnapshot SafeRead()
    {
        try { return page.Read() ?? Failed; }
        catch (Exception) { return Failed; }
    }

    private static string StateOf(PageSnapshot s) => string.IsNullOrWhiteSpace(s.WindowState) ? "unknown" : s.WindowState;

    /// <summary>The first condition that fails, in the fixed order. None means ready.</summary>
    private static AutoSendReason Check(PageSnapshot s, string expected)
    {
        if (!s.WindowFound) return AutoSendReason.NoWindow;
        if (!s.DocumentFound) return AutoSendReason.NoDocument;
        if (!s.ComposerFound) return AutoSendReason.NoComposer;
        if (!SameText(s.ComposerText, expected)) return AutoSendReason.TextMismatch;
        if (!s.SendFound) return AutoSendReason.SendNotFound;
        if (!s.SendEnabled) return AutoSendReason.SendDisabled;
        return AutoSendReason.None;
    }

    /// <summary>Equal ignoring all whitespace.</summary>
    private static bool SameText(string? actual, string expected)
        => actual is not null && string.Equals(StripWhitespace(actual), StripWhitespace(expected), StringComparison.Ordinal);

    private static string StripWhitespace(string s)
    {
        var sb = new System.Text.StringBuilder(s.Length);
        foreach (var ch in s)
        {
            if (!char.IsWhiteSpace(ch)) sb.Append(ch);
        }
        return sb.ToString();
    }

    private static int Seconds(long ms) => (int)Math.Max(0, (ms + 999) / 1000);

    private static string Decision(AutoSendOutcome outcome) => outcome switch
    {
        AutoSendOutcome.Sent => "sent",
        AutoSendOutcome.NotConfirmed => "not_confirmed",
        AutoSendOutcome.Cancelled => "cancelled",
        _ => "not_sent",
    };

    /// <summary>Only the decision, reason, milliseconds and window state. Never prompt text, repo name or cell id.</summary>
    private void WriteLog(string decision, AutoSendReason reason, long ms, string windowState)
    {
        try
        {
            log.Write("autosend",
                ("decision", decision),
                ("reason", reason.ToString()),
                ("ms", ms.ToString(CultureInfo.InvariantCulture)),
                ("window", windowState));
        }
        catch (Exception)
        {
            // logging never stops a send decision
        }
    }
}
