using System.Reflection;

namespace BlueprintLauncher.Core.Tests;

public class BrowserProfilesTests
{
    private static void WriteState(string root, string relative, string json)
    {
        var path = Path.Combine(root, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, json);
    }

    private static readonly string ChromeState = Path.Combine("Google", "Chrome", "User Data", "Local State");
    private static readonly string EdgeState = Path.Combine("Microsoft", "Edge", "User Data", "Local State");

    [Fact]
    public void ReturnsOnlyFolderAndName()
    {
        using var t = new TempDir();
        WriteState(t.Dir, ChromeState, """
        {"profile":{"info_cache":{
          "Default":{"name":"Personal","user_name":"secret@example.com","gaia_name":"Secret Person"},
          "Profile 1":{"name":"Work","user_name":"boss@example.com"}
        }}}
        """);
        var list = BrowserProfiles.List(t.Dir);
        Assert.Equal(2, list.Count);
        Assert.Equal(new Profile("chrome", "Default", "Personal"), list[0]);
        Assert.Equal(new Profile("chrome", "Profile 1", "Work"), list[1]);
        Assert.DoesNotContain(list, p => p.ToString().Contains("example.com") || p.ToString().Contains("Secret"));
        var props = typeof(Profile).GetProperties(BindingFlags.Public | BindingFlags.Instance).Select(p => p.Name).OrderBy(n => n);
        Assert.Equal(new[] { "AvatarFile", "Browser", "Folder", "Name", "ThemeColor" }, props);
    }

    [Fact]
    public void ReadsChromeAndEdge()
    {
        using var t = new TempDir();
        WriteState(t.Dir, ChromeState, "{\"profile\":{\"info_cache\":{\"Default\":{\"name\":\"A\"}}}}");
        WriteState(t.Dir, EdgeState, "{\"profile\":{\"info_cache\":{\"Default\":{\"name\":\"B\"}}}}");
        var list = BrowserProfiles.List(t.Dir);
        Assert.Equal(new[] { "chrome", "edge" }, list.Select(p => p.Browser));
        Assert.Equal(new[] { "A", "B" }, list.Select(p => p.Name));
    }

    [Fact]
    public void MissingFilesGiveEmptyList()
    {
        using var t = new TempDir();
        Assert.Empty(BrowserProfiles.List(t.Dir));
        Assert.Empty(BrowserProfiles.List(Path.Combine(t.Dir, "does-not-exist")));
    }

    [Theory]
    [InlineData("not json at all")]
    [InlineData("{\"profile\":{\"info_cache\":")]
    [InlineData("")]
    [InlineData("[]")]
    [InlineData("null")]
    [InlineData("{\"profile\":[]}")]
    [InlineData("{\"profile\":{\"info_cache\":[1,2]}}")]
    [InlineData("{\"profile\":{\"info_cache\":{\"Default\":5}}}")]
    public void CorruptOrOddFilesGiveEmptyList(string json)
    {
        using var t = new TempDir();
        WriteState(t.Dir, ChromeState, json);
        Assert.Empty(BrowserProfiles.List(t.Dir));
    }

    [Fact]
    public void SkipsUnsafeFolderNamesAndFixesNames()
    {
        using var t = new TempDir();
        WriteState(t.Dir, ChromeState, """
        {"profile":{"info_cache":{
          "..":{"name":"Up"},
          "a\" --evil":{"name":"Quote"},
          "Profile 2":{"name":""},
          "Profile 3":{"name":42},
          "Profile 4":{"name":"Tab\there"}
        }}}
        """);
        var list = BrowserProfiles.List(t.Dir);
        Assert.Equal(new[] { "Profile 2", "Profile 3", "Profile 4" }, list.Select(p => p.Folder));
        Assert.Equal(new[] { "Profile 2", "Profile 3", "Tabhere" }, list.Select(p => p.Name));
    }

    [Fact]
    public void LocatorPrefersRegistryThenStandardDirs()
    {
        using var t = new TempDir();
        var chromeDir = Path.Combine(t.Dir, "pf", "Google", "Chrome", "Application");
        Directory.CreateDirectory(chromeDir);
        var chrome = Path.Combine(chromeDir, "chrome.exe");
        File.WriteAllText(chrome, "");
        var reg = Path.Combine(t.Dir, "reg-chrome.exe");
        File.WriteAllText(reg, "");

        var viaDirs = new BrowserExeLocator(new[] { Path.Combine(t.Dir, "pf") }, _ => null);
        Assert.Equal(chrome, viaDirs.Find("chrome"));
        Assert.Null(viaDirs.Find("edge"));
        Assert.Null(viaDirs.Find("firefox"));

        var viaRegistry = new BrowserExeLocator(new[] { Path.Combine(t.Dir, "pf") }, exe => exe == "chrome.exe" ? "\"" + reg + "\"" : null);
        Assert.Equal(reg, viaRegistry.Find("chrome"));

        var staleRegistry = new BrowserExeLocator(new[] { Path.Combine(t.Dir, "pf") }, _ => Path.Combine(t.Dir, "gone.exe"));
        Assert.Equal(chrome, staleRegistry.Find("chrome"));
    }
}
