using BlueprintLauncher.Core;
using Xunit;

namespace BlueprintLauncher.Core.Tests;

public class AutoSendCheckTests
{
    private const string Text = AutoSendCheck.CheckText;

    /// <summary>A snapshot where every condition up to the given failing reason holds. None means everything is fine.</summary>
    private static PageSnapshot Build(AutoSendReason failing, string state = "foreground", string? composerOverride = null)
    {
        var w = failing != AutoSendReason.NoWindow;
        var d = w && failing != AutoSendReason.NoDocument;
        var c = d && failing != AutoSendReason.NoComposer;
        var text = c ? (failing == AutoSendReason.TextMismatch ? "something else" : composerOverride ?? Text) : null;
        var sf = c && failing != AutoSendReason.SendNotFound;
        var se = sf && failing != AutoSendReason.SendDisabled;
        return new PageSnapshot(w, d, c, text, sf, se, state, 100, 10, null);
    }

    private static string[] Lines(string report) => report.Split('\n', StringSplitOptions.RemoveEmptyEntries);

    [Fact]
    public void Ready_report_has_header_browser_windows_timeline_and_verdict()
    {
        var t = new CheckTimeline();
        AutoSendCheck.Observe(t, Build(AutoSendReason.NoDocument, "background"), 800);
        AutoSendCheck.Observe(t, Build(AutoSendReason.None, "foreground"), 9100);
        var lines = Lines(CheckReport.Format("edge", "10.0.19045.0", t));

        Assert.Contains("Blueprint auto-send check", lines[0]);
        Assert.Contains("browser: edge", lines);
        Assert.Contains("windows: 10.0.19045.0", lines);
        Assert.Contains("windowFound=800(background)", lines);
        Assert.Contains("documentFound=9100(foreground)", lines);
        Assert.Contains("composerFound=9100(foreground)", lines);
        Assert.Contains("composerTextMatches=9100(foreground)", lines);
        Assert.Contains("sendButtonFound=9100(foreground)", lines);
        Assert.Contains("sendButtonEnabled=9100(foreground)", lines);
        Assert.Contains("ready=9100(foreground)", lines);
        Assert.Equal("READY at 9100 ms", lines[^1]);
        Assert.DoesNotContain(lines, l => l.StartsWith("NOT READY", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(AutoSendReason.NoWindow)]
    [InlineData(AutoSendReason.NoDocument)]
    [InlineData(AutoSendReason.NoComposer)]
    [InlineData(AutoSendReason.TextMismatch)]
    [InlineData(AutoSendReason.SendNotFound)]
    [InlineData(AutoSendReason.SendDisabled)]
    public void Not_ready_report_names_the_engine_reason(AutoSendReason reason)
    {
        var t = new CheckTimeline();
        Assert.Equal(reason, AutoSendCheck.Observe(t, Build(reason), 60000));
        var lines = Lines(CheckReport.Format("firefox", "10.0.22631.0", t, 60000));

        Assert.StartsWith("NOT READY: " + reason + " ", lines[^1], StringComparison.Ordinal);
        Assert.Contains("60000 ms", lines[^1]);
        Assert.False(t.IsReady);
        Assert.DoesNotContain(lines, l => l.StartsWith("ready=", StringComparison.Ordinal));
    }

    [Fact]
    public void Not_ready_uses_the_last_failing_reason()
    {
        var t = new CheckTimeline();
        AutoSendCheck.Observe(t, Build(AutoSendReason.SendDisabled), 5000);
        AutoSendCheck.Observe(t, Build(AutoSendReason.NoComposer), 6000);
        var verdict = Lines(CheckReport.Format("brave", "10.0.19045.0", t))[^1];
        Assert.StartsWith("NOT READY: NoComposer ", verdict, StringComparison.Ordinal);
    }

    [Fact]
    public void Nothing_read_is_not_ready_with_no_window()
    {
        var report = CheckReport.Format("opera", "10.0.19045.0", new CheckTimeline());
        Assert.Contains("(no marks)", report);
        Assert.Contains("NOT READY: NoWindow ", report);
    }

    [Fact]
    public void A_mark_is_recorded_once_at_its_first_time()
    {
        var t = new CheckTimeline();
        AutoSendCheck.Observe(t, Build(AutoSendReason.NoComposer, "minimized"), 300);
        AutoSendCheck.Observe(t, Build(AutoSendReason.NoComposer, "foreground"), 900);
        Assert.Single(t.Marks, m => m.Name == AutoSendCheck.WindowFound);
        Assert.Equal(300, t.Marks.First(m => m.Name == AutoSendCheck.WindowFound).Ms);
        Assert.Equal("minimized", t.Marks.First(m => m.Name == AutoSendCheck.WindowFound).State);
    }

    [Fact]
    public void Composer_text_compare_ignores_whitespace_but_not_letters()
    {
        Assert.Equal(AutoSendReason.None,
            AutoSendCheck.Evaluate(Build(AutoSendReason.None, composerOverride: "Blueprint  auto-send check.\nDo not send. "), Text));
        Assert.Equal(AutoSendReason.TextMismatch,
            AutoSendCheck.Evaluate(Build(AutoSendReason.None, composerOverride: "blueprint auto-send check. Do not send."), Text));
    }

    [Fact]
    public void Report_holds_no_prompt_text_profile_names_titles_or_page_text()
    {
        var snapshot = new PageSnapshot(true, true, true, "SECRET prompt for acme/secret-repo C-123", true, false,
            "foreground", 10, 10, "Page title: Inbox of Bob");
        var t = new CheckTimeline();
        AutoSendCheck.Observe(t, snapshot, 1234);
        var report = CheckReport.Format(@"C:\Users\bob\Profile 3 (Work)", "Windows 10 Bob's PC", t);

        foreach (var forbidden in new[] { "SECRET", "acme", "secret-repo", "C-123", "Inbox", "Bob", "bob", "Profile 3", "Work", "Do not send.", "claude.ai", "http" })
        {
            Assert.DoesNotContain(forbidden, report);
        }
        Assert.All(Lines(report), l => Assert.DoesNotContain("\\", l));
    }

    [Fact]
    public void Unknown_window_states_are_written_as_unknown()
    {
        var t = new CheckTimeline();
        AutoSendCheck.Observe(t, Build(AutoSendReason.NoDocument, "Some Window Title"), 10);
        Assert.Contains("windowFound=10(unknown)", CheckReport.Format("edge", "10.0", t));
    }

    [Fact]
    public void CheckMode_source_never_mentions_PressSend()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        string? path = null;
        while (dir is not null && path is null)
        {
            var candidate = Path.Combine(dir.FullName, "launcher", "App", "CheckMode.cs");
            if (File.Exists(candidate)) path = candidate;
            dir = dir.Parent;
        }
        Assert.True(path is not null, "launcher/App/CheckMode.cs was not found above the test folder");
        Assert.DoesNotContain("PressSend", File.ReadAllText(path!), StringComparison.Ordinal);
    }
}
