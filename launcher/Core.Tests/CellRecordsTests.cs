using System.Text.Json;

namespace BlueprintLauncher.Core.Tests;

public class CellRecordsTests
{
    private const string Chat = "https://claude.ai/chat/123e4567-e89b-12d3-a456-426614174000";
    private static readonly DateTimeOffset T0 = new(2026, 11, 4, 12, 0, 0, TimeSpan.Zero);

    private sealed class Clock
    {
        public DateTimeOffset Now { get; set; } = T0;
    }

    [Fact]
    public void UpsertWritesContractShape()
    {
        using var t = new TempDir();
        var recs = new CellRecords(t.Dir, () => T0);
        recs.Upsert("o/r", "C-001", "chrome", "Profile 1", "Work");
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(t.Dir, "cells.json")));
        var e = doc.RootElement.GetProperty("o/r C-001");
        Assert.Equal("chrome", e.GetProperty("browser").GetString());
        Assert.Equal("Profile 1", e.GetProperty("profileFolder").GetString());
        Assert.Equal("Work", e.GetProperty("profileName").GetString());
        Assert.True(e.TryGetProperty("startedAt", out _));
        Assert.False(e.TryGetProperty("chatUrl", out _));
    }

    [Fact]
    public void SaveLeavesNoTempFiles()
    {
        using var t = new TempDir();
        var recs = new CellRecords(t.Dir, () => T0);
        recs.Upsert("o/r", "C-001", "edge", "Default", "Me");
        recs.Upsert("o/r", "C-002", "edge", "Default", "Me");
        Assert.Equal(new[] { "cells.json" }, Directory.GetFiles(t.Dir).Select(Path.GetFileName));
        Assert.Equal(2, recs.Load().Count);
    }

    [Theory]
    [InlineData("https://claude.ai/chat/123e4567-e89b-12d3-a456-426614174000", true)]
    [InlineData("http://claude.ai/chat/123e4567-e89b-12d3-a456-426614174000", false)]
    [InlineData("https://claude.ai/chat/123e4567-e89b-12d3-a456-42661417400", false)]
    [InlineData("https://claude.ai/chat/123E4567-E89B-12D3-A456-426614174000", false)]
    [InlineData("https://claude.ai/chat/123e4567-e89b-12d3-a456-426614174000/", false)]
    [InlineData("https://claude.ai/chat/123e4567-e89b-12d3-a456-426614174000?x=1", false)]
    [InlineData("https://claude.ai/chat/123e4567-e89b-12d3-a456-426614174000\n", false)]
    [InlineData("https://evil.example/chat/123e4567-e89b-12d3-a456-426614174000", false)]
    [InlineData("https://claude.ai.evil.example/chat/123e4567-e89b-12d3-a456-426614174000", false)]
    [InlineData("javascript:alert(1)", false)]
    [InlineData("", false)]
    public void ChatUrlIsAcceptedOnlyWhenStrict(string url, bool ok)
    {
        using var t = new TempDir();
        var recs = new CellRecords(t.Dir, () => T0);
        recs.Upsert("o/r", "C-001", "chrome", "Default", "Me");
        Assert.Equal(ok, recs.SetChatUrl("o/r", "C-001", url));
        Assert.Equal(ok ? url : null, recs.Load()["o/r C-001"].ChatUrl);
    }

    [Fact]
    public void SetChatUrlNeedsAnExistingRecordAndNullIsRejected()
    {
        using var t = new TempDir();
        var recs = new CellRecords(t.Dir, () => T0);
        Assert.False(recs.SetChatUrl("o/r", "C-009", Chat));
        recs.Upsert("o/r", "C-001", "chrome", "Default", "Me");
        Assert.False(recs.SetChatUrl("o/r", "C-001", null));
        Assert.True(recs.SetChatUrl("o/r", "C-001", Chat));
    }

    [Fact]
    public void SyncDeletesOnlyMergedCellsOfThatRepo()
    {
        using var t = new TempDir();
        var recs = new CellRecords(t.Dir, () => T0);
        recs.Upsert("o/r", "C-001", "chrome", "Default", "Me");
        recs.Upsert("o/r", "C-002", "chrome", "Default", "Me");
        recs.Upsert("o/r", "C-003", "chrome", "Default", "Me");
        recs.Upsert("x/y", "C-001", "chrome", "Default", "Me");
        Assert.Equal(2, recs.Sync("o/r", new[] { "C-001", "C-002", "C-009", "bad" }));
        Assert.Equal(new[] { "o/r C-003", "x/y C-001" }, recs.Load().Keys.OrderBy(k => k, StringComparer.Ordinal));
        Assert.Equal(0, recs.Sync("o/r", new[] { "C-001" }));
        Assert.Equal(0, recs.Sync("not a repo", new[] { "C-003" }));
    }

    [Fact]
    public void CleanupDeletesRecordsOlderThanFourteenDays()
    {
        using var t = new TempDir();
        var clock = new Clock();
        var recs = new CellRecords(t.Dir, () => clock.Now);
        recs.Upsert("o/r", "C-001", "chrome", "Default", "Me");
        clock.Now = T0.AddDays(7);
        recs.Upsert("o/r", "C-002", "chrome", "Default", "Me");

        Assert.Equal(0, recs.Cleanup(T0.AddDays(14)));
        Assert.Equal(1, recs.Cleanup(T0.AddDays(14).AddSeconds(1)));
        Assert.Equal(new[] { "o/r C-002" }, recs.Load().Keys);
        clock.Now = T0.AddDays(21).AddSeconds(1);
        Assert.Equal(1, recs.Cleanup());
        Assert.Empty(recs.Load());
    }

    [Fact]
    public void MissingOrCorruptFileLoadsEmptyAndRecovers()
    {
        using var t = new TempDir();
        var recs = new CellRecords(Path.Combine(t.Dir, "nested"), () => T0);
        Assert.Empty(recs.Load());
        Directory.CreateDirectory(Path.Combine(t.Dir, "nested"));
        File.WriteAllText(recs.FilePath, "{ this is not json");
        Assert.Empty(recs.Load());
        recs.Upsert("o/r", "C-001", "chrome", "Default", "Me");
        Assert.Single(recs.Load());
    }

    [Fact]
    public void LoadDropsTamperedEntries()
    {
        using var t = new TempDir();
        var recs = new CellRecords(t.Dir, () => T0);
        File.WriteAllText(recs.FilePath, """
        {
          "o/r C-001": {"browser":"chrome","profileFolder":"Default","profileName":"Me","startedAt":"2026-11-04T12:00:00+00:00","chatUrl":"https://evil.example/x"},
          "o/r C-002": {"browser":"firefox","profileFolder":"Default","profileName":"Me","startedAt":"2026-11-04T12:00:00+00:00"},
          "o/r C-003": {"browser":"edge","profileFolder":"..","profileName":"Me","startedAt":"2026-11-04T12:00:00+00:00"},
          "bad key": {"browser":"edge","profileFolder":"Default","profileName":"Me","startedAt":"2026-11-04T12:00:00+00:00"},
          "o/r C-004": null
        }
        """);
        var all = recs.Load();
        Assert.Equal(new[] { "o/r C-001" }, all.Keys);
        Assert.Null(all["o/r C-001"].ChatUrl);
    }

    [Fact]
    public void UpsertRejectsInvalidValues()
    {
        using var t = new TempDir();
        var recs = new CellRecords(t.Dir, () => T0);
        Assert.Throws<ArgumentException>(() => recs.Upsert("bad repo", "C-001", "chrome", "Default", "Me"));
        Assert.Throws<ArgumentException>(() => recs.Upsert("o/r", "C-1", "chrome", "Default", "Me"));
        Assert.Throws<ArgumentException>(() => recs.Upsert("o/r", "C-001", "firefox", "Default", "Me"));
        Assert.Throws<ArgumentException>(() => recs.Upsert("o/r", "C-001", "chrome", "..", "Me"));
    }
}
