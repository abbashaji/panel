using System.Text.RegularExpressions;
using BlueprintLauncher.Core;
using Xunit;

namespace BlueprintLauncher.Core.Tests;

public sealed class AutoSendLogTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "bp-log-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        try { Directory.Delete(_dir, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    private string LogFile => Path.Combine(_dir, "autosend.log");

    [Fact]
    public void LineFormat()
    {
        var log = new FileAutoSendLog(_dir);
        log.Write("sent", ("browser", "chrome"), ("ms", "120"));
        log.Write("cancelled");
        var lines = File.ReadAllLines(LogFile);
        Assert.Equal(2, lines.Length);
        Assert.Matches(new Regex(@"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} sent browser=chrome ms=120$"), lines[0]);
        Assert.Matches(new Regex(@"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} cancelled$"), lines[1]);
    }

    [Fact]
    public void KeysAndValuesAreSanitized()
    {
        var log = new FileAutoSendLog(_dir);
        log.Write("not sent", ("my key", "line one\r\nline two"), ("long", new string('x', 100)));
        var text = File.ReadAllText(LogFile);
        var lines = File.ReadAllLines(LogFile);
        Assert.Single(lines);
        Assert.DoesNotContain('\r', text);
        Assert.Equal(1, text.Count(c => c == '\n'));
        Assert.Contains(" not_sent ", lines[0]);
        Assert.Contains(" my_key=line_oneline_two", lines[0]);
        Assert.Contains(" long=" + new string('x', 40), lines[0]);
        Assert.DoesNotContain(new string('x', 41), lines[0]);
    }

    [Fact]
    public void FileStaysUnder64KbAndKeepsNewestLines()
    {
        var log = new FileAutoSendLog(_dir);
        for (var i = 0; i < 3000; i++) log.Write("tick", ("n", i.ToString()), ("pad", new string('p', 30)));
        var info = new FileInfo(LogFile);
        Assert.True(info.Length < 64 * 1024, "length " + info.Length);
        var lines = File.ReadAllLines(LogFile);
        Assert.True(lines.Length > 100);
        var rx = new Regex(@"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} tick n=\d+ pad=p{30}$");
        Assert.All(lines, l => Assert.Matches(rx, l));
        Assert.EndsWith("n=2999 pad=" + new string('p', 30), lines[^1]);
        Assert.DoesNotContain(lines, l => l.Contains(" n=0 "));
    }

    [Fact]
    public void UnwritableDirectoryDoesNotThrow()
    {
        Directory.CreateDirectory(_dir);
        var blocker = Path.Combine(_dir, "blocker");
        File.WriteAllText(blocker, "x");
        var log = new FileAutoSendLog(blocker);
        var ex = Record.Exception(() => log.Write("sent", ("a", "b")));
        Assert.Null(ex);
    }

    [Fact]
    public void NullLogDoesNothing()
    {
        var ex = Record.Exception(() => NullAutoSendLog.Instance.Write("sent", ("a", "b")));
        Assert.Null(ex);
        IAutoSendLog log = NullAutoSendLog.Instance;
        Assert.NotNull(log);
    }
}
