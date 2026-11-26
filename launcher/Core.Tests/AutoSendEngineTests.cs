using BlueprintLauncher.Core;

namespace BlueprintLauncher.Core.Tests;

public class AutoSendEngineTests : IDisposable
{
    private const string Repo = "abbashaji/panel";
    private const string Cell = "C-092";
    private static readonly string Prompt = PromptBuilder.BuildPrompt(Repo, Cell);

    private readonly string _dir = Path.Combine(Path.GetTempPath(), "autosend-engine-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        try { if (Directory.Exists(_dir)) Directory.Delete(_dir, true); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    /// <summary>Advances only when the engine asks for a delay, so no test waits for real time.</summary>
    private sealed class FakeClock : IAutoSendClock
    {
        public long NowMs { get; private set; }

        public Task DelayAsync(int ms, CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested();
            NowMs += ms;
            return Task.CompletedTask;
        }
    }

    /// <summary>The script gets the fake time and the number of presses so far and returns the next snapshot.</summary>
    private sealed class FakeChatPage(FakeClock clock, Func<long, int, PageSnapshot> script) : IChatPage
    {
        public int ReadCount;
        public int PressCount;
        public readonly List<long> PressTimes = new();
        public readonly List<string> PressArgs = new();
        public bool PressResult = true;
        public bool ThrowOnPress;

        public PageSnapshot Read()
        {
            ReadCount++;
            return script(clock.NowMs, PressCount);
        }

        public bool PressSend(string expectedComposerText)
        {
            PressCount++;
            PressTimes.Add(clock.NowMs);
            PressArgs.Add(expectedComposerText);
            if (ThrowOnPress) throw new InvalidOperationException("press failed");
            return PressResult;
        }
    }

    private sealed class RecordingLog : IAutoSendLog
    {
        public readonly List<(string Decision, (string Key, string Value)[] Fields)> Entries = new();
        public void Write(string decision, params (string Key, string Value)[] fields) => Entries.Add((decision, fields));
    }

    private sealed class SyncProgress : IProgress<AutoSendProgress>
    {
        public readonly List<AutoSendProgress> Items = new();
        public Action<AutoSendProgress>? OnReport;

        public void Report(AutoSendProgress value)
        {
            Items.Add(value);
            OnReport?.Invoke(value);
        }
    }

    private sealed class Rig
    {
        public required AutoSendEngine Engine { get; init; }
        public required FakeClock Clock { get; init; }
        public required FakeChatPage Page { get; init; }
        public required AutoSendGuard Guard { get; init; }
        public required RecordingLog Log { get; init; }
    }

    private Rig Build(Func<long, int, PageSnapshot> script, bool allowed = true, AutoSendOptions? options = null)
    {
        var clock = new FakeClock();
        var page = new FakeChatPage(clock, script);
        var settings = new LauncherSettings();
        if (allowed) Assert.True(settings.AllowRepo(Repo));
        var guard = new AutoSendGuard(_dir);
        var log = new RecordingLog();
        return new Rig
        {
            Engine = new AutoSendEngine(page, clock, settings, guard, log, options),
            Clock = clock,
            Page = page,
            Guard = guard,
            Log = log,
        };
    }

    private static AutoSendRequest Req() => new(Repo, Cell, Prompt);

    private static PageSnapshot Ready(string? text = null, string window = "background")
        => new(true, true, true, text ?? Prompt, true, true, window, 120, 40, null);

    /// <summary>A snapshot whose first failing condition is the given reason; every later condition fails as well.</summary>
    private static PageSnapshot Failing(AutoSendReason reason) => reason switch
    {
        AutoSendReason.NoWindow => new PageSnapshot(false, false, false, null, false, false, "unknown", 0, 0, null),
        AutoSendReason.NoDocument => new PageSnapshot(true, false, false, null, false, false, "foreground", 4, 10, null),
        AutoSendReason.NoComposer => new PageSnapshot(true, true, false, null, false, false, "foreground", 64, 10, null),
        AutoSendReason.TextMismatch => new PageSnapshot(true, true, true, "something else", false, false, "foreground", 90, 10, null),
        AutoSendReason.SendNotFound => new PageSnapshot(true, true, true, Prompt, false, false, "foreground", 90, 10, null),
        AutoSendReason.SendDisabled => new PageSnapshot(true, true, true, Prompt, true, false, "foreground", 90, 10, null),
        _ => throw new ArgumentOutOfRangeException(nameof(reason)),
    };

    private static void AssertPressedAtMostOnce(Rig rig) => Assert.True(rig.Page.PressCount <= 1);

    [Fact]
    public async Task Happy_path_presses_once_at_ready_plus_stable_plus_countdown()
    {
        var rig = Build((t, p) => p > 0 ? Ready("") : Ready());
        var progress = new SyncProgress();

        var result = await rig.Engine.RunAsync(Req(), progress, CancellationToken.None);

        Assert.Equal(AutoSendOutcome.Sent, result.Outcome);
        Assert.Equal(AutoSendReason.None, result.Reason);
        Assert.Equal("background", result.WindowStateAtSend);
        Assert.Equal(1, rig.Page.PressCount);
        Assert.Equal(Prompt, rig.Page.PressArgs[0]);
        // ready at 0, stable seen at the first poll at or after 800 ms (1000), then 3000 ms of countdown
        Assert.InRange(rig.Page.PressTimes[0], 800 + 3000, 800 + 3000 + 250);
        Assert.True(result.ElapsedMs >= rig.Page.PressTimes[0]);
        Assert.Equal(new[] { "waiting", "countdown", "sending", "confirming" }, progress.Items.Select(i => i.Phase).Distinct().ToArray());
        Assert.Equal(new[] { 3, 2, 1 }, progress.Items.Where(i => i.Phase == "countdown").Select(i => i.SecondsLeft).ToArray());
    }

    [Fact]
    public async Task Whitespace_in_the_composer_does_not_matter()
    {
        var spaced = Prompt.Replace("\n", "  \r\n ") + "  ";
        var rig = Build((t, p) => p > 0 ? Ready("") : Ready(spaced));

        var result = await rig.Engine.RunAsync(Req(), null, CancellationToken.None);

        Assert.Equal(AutoSendOutcome.Sent, result.Outcome);
        Assert.Equal(1, rig.Page.PressCount);
    }

    [Fact]
    public async Task One_sample_dip_restarts_the_stability_timer()
    {
        var rig = Build((t, p) =>
            p > 0 ? Ready("") :
            t == 500 ? Ready() with { SendEnabled = false } :
            Ready());

        var result = await rig.Engine.RunAsync(Req(), null, CancellationToken.None);

        Assert.Equal(AutoSendOutcome.Sent, result.Outcome);
        Assert.Equal(1, rig.Page.PressCount);
        // ready again from 750: stable at 1750, countdown ends at 4750 (without the dip it would be 4000)
        Assert.InRange(rig.Page.PressTimes[0], 750 + 800 + 3000, 750 + 800 + 3000 + 250);
        Assert.True(rig.Page.PressTimes[0] > 4000);
    }

    [Theory]
    [InlineData(AutoSendReason.NoWindow)]
    [InlineData(AutoSendReason.NoDocument)]
    [InlineData(AutoSendReason.NoComposer)]
    [InlineData(AutoSendReason.TextMismatch)]
    [InlineData(AutoSendReason.SendNotFound)]
    [InlineData(AutoSendReason.SendDisabled)]
    public async Task Timeout_reports_the_reason_that_failed(AutoSendReason reason)
    {
        var snap = Failing(reason);
        var rig = Build((t, p) => snap);

        var result = await rig.Engine.RunAsync(Req(), null, CancellationToken.None);

        Assert.Equal(AutoSendOutcome.NotSent, result.Outcome);
        Assert.Equal(reason, result.Reason);
        Assert.Equal(snap.WindowState, result.WindowStateAtSend);
        Assert.InRange(result.ElapsedMs, 60000, 60250);
        Assert.Equal(0, rig.Page.PressCount);
    }

    [Fact]
    public async Task Timeout_reports_the_reason_that_failed_last()
    {
        var rig = Build((t, p) => t < 30000 ? Failing(AutoSendReason.NoWindow) : Failing(AutoSendReason.SendDisabled));

        var result = await rig.Engine.RunAsync(Req(), null, CancellationToken.None);

        Assert.Equal(AutoSendOutcome.NotSent, result.Outcome);
        Assert.Equal(AutoSendReason.SendDisabled, result.Reason);
        Assert.Equal(0, rig.Page.PressCount);
    }

    [Fact]
    public async Task A_read_that_throws_counts_as_no_window()
    {
        var rig = Build((t, p) => throw new InvalidOperationException("boom"));

        var result = await rig.Engine.RunAsync(Req(), null, CancellationToken.None);

        Assert.Equal(AutoSendOutcome.NotSent, result.Outcome);
        Assert.Equal(AutoSendReason.NoWindow, result.Reason);
        Assert.Equal(0, rig.Page.PressCount);
    }
}
