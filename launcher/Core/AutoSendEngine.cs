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
