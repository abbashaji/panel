using System.Text.Json;
using BlueprintLauncher.Core;
using Xunit;

namespace BlueprintLauncher.Core.Tests;

public sealed class AutoSendGuardTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "bp-guard-" + Guid.NewGuid().ToString("N"));
    private DateTimeOffset _clock = new(2026, 11, 27, 12, 0, 0, TimeSpan.Zero);

    public void Dispose()
    {
        try { Directory.Delete(_dir, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    private AutoSendGuard NewGuard() => new(_dir, () => _clock);
    private string SendsFile => Path.Combine(_dir, "autosend-sends.json");

    [Fact]
    public void EmptyDirectoryAllowsSend()
    {
        Assert.True(NewGuard().CanSend(out var reason));
        Assert.Equal("", reason);
    }

    [Fact]
    public void ElevenSendsAllowTwelveBlock()
    {
        var g = NewGuard();
        for (var i = 0; i < 11; i++) { g.RecordSend(); _clock = _clock.AddSeconds(1); }
        Assert.True(g.CanSend(out _));
        g.RecordSend();
        _clock = _clock.AddSeconds(1);
        Assert.False(g.CanSend(out var reason));
        Assert.Equal("rate limit", reason);
    }

    [Fact]
    public void SendsExpireAfterTenMinutes()
    {
        var g = NewGuard();
        for (var i = 0; i < 12; i++) g.RecordSend();
        Assert.False(g.CanSend(out _));
        _clock = _clock.AddMinutes(9);
        Assert.False(g.CanSend(out _));
        _clock = _clock.AddMinutes(1).AddSeconds(1);
        Assert.True(g.CanSend(out var reason));
        Assert.Equal("", reason);
    }

    [Fact]
    public void PersistsAcrossInstances()
    {
        var first = NewGuard();
        for (var i = 0; i < 12; i++) first.RecordSend();
        Assert.False(NewGuard().CanSend(out var reason));
        Assert.Equal("rate limit", reason);
        Assert.True(File.Exists(SendsFile));
    }

    [Fact]
    public void CorruptFileIsToleratedAndReplaced()
    {
        Directory.CreateDirectory(_dir);
        File.WriteAllText(SendsFile, "{ not json");
        var g = NewGuard();
        Assert.True(g.CanSend(out _));
        g.RecordSend();
        using var doc = JsonDocument.Parse(File.ReadAllText(SendsFile));
        Assert.Equal(1, doc.RootElement.GetArrayLength());

        File.WriteAllText(SendsFile, "{\"a\":1}");
        Assert.True(g.CanSend(out _));
        File.WriteAllText(SendsFile, "[\"x\",null,true]");
        Assert.True(g.CanSend(out _));
    }

    [Fact]
    public void OversizedFileIsIgnored()
    {
        Directory.CreateDirectory(_dir);
        var ms = _clock.ToUnixTimeMilliseconds();
        var json = "[" + string.Join(",", Enumerable.Repeat(ms.ToString(), 20)) + "]" + new string(' ', 70 * 1024);
        File.WriteAllText(SendsFile, json);
        Assert.True(NewGuard().CanSend(out _));
    }

    [Fact]
    public void FutureTimestampsDoNotCount()
    {
        Directory.CreateDirectory(_dir);
        var future = _clock.AddHours(1).ToUnixTimeMilliseconds();
        File.WriteAllText(SendsFile, "[" + string.Join(",", Enumerable.Repeat(future.ToString(), 20)) + "]");
        var g = NewGuard();
        Assert.True(g.CanSend(out _));
        g.RecordSend();
        using var doc = JsonDocument.Parse(File.ReadAllText(SendsFile));
        Assert.Equal(1, doc.RootElement.GetArrayLength());
    }

    [Fact]
    public void AtMostFiftyEntriesAreKept()
    {
        var g = NewGuard();
        for (var i = 0; i < 70; i++) { g.RecordSend(); _clock = _clock.AddMilliseconds(100); }
        using var doc = JsonDocument.Parse(File.ReadAllText(SendsFile));
        Assert.Equal(50, doc.RootElement.GetArrayLength());
        Assert.Empty(Directory.GetFiles(_dir, "*.tmp"));
    }

    [Fact]
    public void NeverThrowsWhenDirectoryIsUnusable()
    {
        Directory.CreateDirectory(_dir);
        var blocker = Path.Combine(_dir, "blocker");
        File.WriteAllText(blocker, "x");
        var g = new AutoSendGuard(blocker, () => _clock);
        var ex = Record.Exception(() =>
        {
            g.RecordSend();
            g.CanSend(out _);
        });
        Assert.Null(ex);
        Assert.True(g.CanSend(out _));
    }
}
