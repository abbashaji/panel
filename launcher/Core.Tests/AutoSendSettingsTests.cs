using System.Text.Json;
using BlueprintLauncher.Core;
using Xunit;

namespace BlueprintLauncher.Core.Tests;

public sealed class AutoSendSettingsTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "bp-settings-" + Guid.NewGuid().ToString("N"));

    public AutoSendSettingsTests() => Directory.CreateDirectory(_dir);

    public void Dispose()
    {
        try { Directory.Delete(_dir, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    private string PathFor(string name = "settings.json") => Path.Combine(_dir, name);

    private LauncherSettings LoadJson(string json)
    {
        var p = PathFor();
        File.WriteAllText(p, json);
        return LauncherSettings.Load(p);
    }

    [Fact]
    public void Defaults()
    {
        var s = new LauncherSettings();
        Assert.False(s.AutoSend);
        Assert.Equal("native", s.Engine);
        Assert.Empty(s.AllowedRepos);
        var loaded = LauncherSettings.Load(PathFor("missing.json"));
        Assert.False(loaded.AutoSend);
        Assert.Equal("native", loaded.Engine);
        Assert.Empty(loaded.AllowedRepos);
    }

    [Fact]
    public void RoundTripOfAllThreeKeys()
    {
        var s = new LauncherSettings { AutoSend = true, Engine = "userscript" };
        Assert.True(s.AllowRepo("Owner/Name"));
        Assert.True(s.AllowRepo("abbashaji/panel"));
        s.Save(PathFor());

        var loaded = LauncherSettings.Load(PathFor());
        Assert.True(loaded.AutoSend);
        Assert.Equal("userscript", loaded.Engine);
        Assert.Equal(new[] { "owner/name", "abbashaji/panel" }, loaded.AllowedRepos);

        using var doc = JsonDocument.Parse(File.ReadAllText(PathFor()));
        Assert.Equal(JsonValueKind.True, doc.RootElement.GetProperty("autoSend").ValueKind);
        Assert.Equal("userscript", doc.RootElement.GetProperty("autoSendEngine").GetString());
        Assert.Equal(2, doc.RootElement.GetProperty("allowedRepos").GetArrayLength());
    }

    [Fact]
    public void UnknownEngineGivesNative()
    {
        Assert.Equal("native", LoadJson("{\"autoSendEngine\":\"chrome-extension\"}").Engine);
        Assert.Equal("native", LoadJson("{\"autoSendEngine\":\"\"}").Engine);
        Assert.Equal("userscript", LoadJson("{\"autoSendEngine\":\"userscript\"}").Engine);
        var s = new LauncherSettings { Engine = "nonsense" };
        Assert.Equal("native", s.Engine);
        s.Engine = null!;
        Assert.Equal("native", s.Engine);
    }

    [Fact]
    public void InvalidReposAreDropped()
    {
        var s = LoadJson("{\"allowedRepos\":[\"ok/one\",\"bad\",\"a/b/c\",\"with space/x\",\"\",5,null,\"OK/ONE\",\"two/Two\"]}");
        Assert.Equal(new[] { "ok/one", "two/two" }, s.AllowedRepos);
        var t = new LauncherSettings();
        Assert.False(t.AllowRepo("bad"));
        Assert.False(t.AllowRepo(""));
        Assert.False(t.AllowRepo(null));
        Assert.Empty(t.AllowedRepos);
    }

    [Fact]
    public void FiftyFirstRepoIsRefused()
    {
        var s = new LauncherSettings();
        for (var i = 0; i < 50; i++) Assert.True(s.AllowRepo("owner/repo" + i));
        Assert.False(s.AllowRepo("owner/extra"));
        Assert.Equal(50, s.AllowedRepos.Count);
        Assert.True(s.AllowRepo("OWNER/REPO7"));
        Assert.False(s.IsRepoAllowed("owner/extra"));

        var json = "{\"allowedRepos\":[" + string.Join(",", Enumerable.Range(0, 60).Select(i => "\"o/r" + i + "\"")) + "]}";
        Assert.Equal(50, LoadJson(json).AllowedRepos.Count);
    }

    [Fact]
    public void LookupIsCaseInsensitiveAndFalseForInvalid()
    {
        var s = new LauncherSettings();
        s.AllowRepo("Abbashaji/Panel");
        Assert.True(s.IsRepoAllowed("abbashaji/panel"));
        Assert.True(s.IsRepoAllowed("ABBASHAJI/PANEL"));
        Assert.False(s.IsRepoAllowed("abbashaji/other"));
        Assert.False(s.IsRepoAllowed(""));
        Assert.False(s.IsRepoAllowed(null));
        Assert.False(s.IsRepoAllowed("abbashaji"));
        Assert.False(s.IsRepoAllowed("abbashaji/panel/x"));
    }

    [Fact]
    public void WrongTypeIgnoresOnlyThatKey()
    {
        var a = LoadJson("{\"autoSend\":\"yes\",\"autoSendEngine\":\"userscript\",\"allowedRepos\":[\"a/b\"]}");
        Assert.False(a.AutoSend);
        Assert.Equal("userscript", a.Engine);
        Assert.Equal(new[] { "a/b" }, a.AllowedRepos);

        var b = LoadJson("{\"autoSend\":true,\"autoSendEngine\":5,\"allowedRepos\":[\"a/b\"]}");
        Assert.True(b.AutoSend);
        Assert.Equal("native", b.Engine);
        Assert.Equal(new[] { "a/b" }, b.AllowedRepos);

        var c = LoadJson("{\"autoSend\":true,\"autoSendEngine\":\"userscript\",\"allowedRepos\":\"a/b\"}");
        Assert.True(c.AutoSend);
        Assert.Equal("userscript", c.Engine);
        Assert.Empty(c.AllowedRepos);

        var d = LoadJson("{\"allowedRepos\":{\"a\":\"b\"},\"autoSend\":true}");
        Assert.True(d.AutoSend);
        Assert.Empty(d.AllowedRepos);
    }

    [Fact]
    public void UnknownKeysCorruptAndOversizedFilesGiveDefaults()
    {
        var a = LoadJson("{\"other\":1,\"autoSend\":true}");
        Assert.True(a.AutoSend);
        Assert.Equal("native", a.Engine);

        foreach (var bad in new[] { "not json", "[1,2]", "", "{\"autoSend\":" })
        {
            var s = LoadJson(bad);
            Assert.False(s.AutoSend);
            Assert.Equal("native", s.Engine);
            Assert.Empty(s.AllowedRepos);
        }

        var big = "{\"autoSend\":true,\"pad\":\"" + new string('x', 70 * 1024) + "\"}";
        var o = LoadJson(big);
        Assert.False(o.AutoSend);
        Assert.Empty(o.AllowedRepos);
    }

    [Fact]
    public void SaveLeavesNoTempFileBehind()
    {
        new LauncherSettings { AutoSend = true }.Save(PathFor());
        Assert.Empty(Directory.GetFiles(_dir, "*.tmp"));
        Assert.Single(Directory.GetFiles(_dir));
    }
}
