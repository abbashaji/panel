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

public class BrowserProfilesFamilyTests
{
    private static string UserData(string root, params string[] parts) => Path.Combine(new[] { root }.Concat(parts).ToArray());

    private static string BraveData(string root) => UserData(root, "BraveSoftware", "Brave-Browser", "User Data");

    private static string Ini(string eol, params string[] lines) => string.Join(eol, lines);

    /// <summary>Single quotes in the text become double quotes, so JSON stays readable.</summary>
    private static void Write(string path, string text)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, text.Replace('\'', '"'));
    }

    [Fact]
    public void BraveAndYandexReadLocalState()
    {
        using var l = new TempDir();
        Write(Path.Combine(BraveData(l.Dir), "Local State"), "{'profile':{'info_cache':{'Default':{'name':'B1'},'Profile 1':{'name':'B2'}}}}");
        Write(UserData(l.Dir, "Yandex", "YandexBrowser", "User Data", "Local State"), "{'profile':{'info_cache':{'Default':{'name':'Y1'}}}}");
        var list = BrowserProfiles.List(l.Dir);
        Assert.Equal(new[] { "brave", "brave", "yandex" }, list.Select(p => p.Browser));
        Assert.Equal(new[] { "B1", "B2", "Y1" }, list.Select(p => p.Name));
        Assert.Equal(new[] { "Default", "Profile 1", "Default" }, list.Select(p => p.Folder));
    }

    [Fact]
    public void ColorsAndAvatarAreParsed()
    {
        using var l = new TempDir();
        var data = BraveData(l.Dir);
        Write(Path.Combine(data, "Local State"), "{'profile':{'info_cache':{" +
            "'Default':{'name':'One','default_avatar_fill_color':-14776091,'profile_highlight_color':-16776961,'user_name':'a@b.com'}," +
            "'Profile 1':{'name':'Two','profile_highlight_color':-16776961}," +
            "'Profile 2':{'name':'Three'}," +
            "'Profile 3':{'name':'Four','default_avatar_fill_color':'red','profile_highlight_color':1.5}," +
            "'Profile 4':{'name':'Five','default_avatar_fill_color':99999999999}}}}");
        Write(Path.Combine(data, "Default", "Google Profile Picture.png"), "png");
        var byFolder = BrowserProfiles.ListFor(l.Dir, "brave").ToDictionary(p => p.Folder);
        Assert.Equal(0xFF1E88E5u, byFolder["Default"].ThemeColor);
        Assert.Equal(0xFF0000FFu, byFolder["Profile 1"].ThemeColor);
        Assert.Null(byFolder["Profile 2"].ThemeColor);
        Assert.Null(byFolder["Profile 3"].ThemeColor);
        Assert.Null(byFolder["Profile 4"].ThemeColor);
        Assert.Equal(Path.Combine(data, "Default", "Google Profile Picture.png"), byFolder["Default"].AvatarFile);
        Assert.All(byFolder.Where(kv => kv.Key != "Default"), kv => Assert.Null(kv.Value.AvatarFile));
    }

    [Fact]
    public void NoEmailOrAccountNameInAnyReturnedValue()
    {
        using var l = new TempDir();
        using var a = new TempDir();
        var states = new[]
        {
            UserData(l.Dir, "Google", "Chrome", "User Data", "Local State"),
            UserData(l.Dir, "Microsoft", "Edge", "User Data", "Local State"),
            Path.Combine(BraveData(l.Dir), "Local State"),
            UserData(l.Dir, "Yandex", "YandexBrowser", "User Data", "Local State"),
        };
        foreach (var s in states)
        {
            Write(s, "{'profile':{'info_cache':{'Default':{'name':'Work','user_name':'secret@example.com','gaia_name':'Secret Person','gaia_given_name':'Secret','default_avatar_fill_color':-14776091}}}}");
        }
        Directory.CreateDirectory(UserData(a.Dir, "Opera Software", "Opera Stable"));
        Write(UserData(a.Dir, "Mozilla", "Firefox", "profiles.ini"), Ini("\n", "[Profile0]", "Name=default-release", "Email=secret@example.com", "[Profile1]", "Name=dev-edition-default"));
        var list = BrowserProfiles.List(l.Dir, a.Dir);
        Assert.Equal(new[] { "chrome", "edge", "brave", "yandex", "opera", "firefox", "firefox-dev" }, list.Select(p => p.Browser));
        var props = typeof(Profile).GetProperties(BindingFlags.Public | BindingFlags.Instance);
        foreach (var p in list)
        {
            Assert.DoesNotContain("@", p.ToString());
            Assert.DoesNotContain("ecret", p.ToString());
            foreach (var prop in props)
            {
                var v = prop.GetValue(p)?.ToString() ?? "";
                Assert.DoesNotContain("@", v);
                Assert.DoesNotContain("ecret", v);
            }
        }
    }

    [Fact]
    public void OperaIsASingleEntryWithoutProfileFolderLookup()
    {
        using var l = new TempDir();
        using var a = new TempDir();
        Assert.Empty(BrowserProfiles.ListFor(l.Dir, a.Dir, "opera"));
        Directory.CreateDirectory(UserData(a.Dir, "Opera Software", "Opera Stable"));
        Assert.Equal(new[] { new Profile("opera", "Opera Stable", "Opera") }, BrowserProfiles.ListFor(l.Dir, a.Dir, "opera"));
        Assert.Empty(BrowserProfiles.ListFor(l.Dir, null, "opera"));
        Assert.Empty(BrowserProfiles.List(l.Dir).Where(p => p.Browser == "opera"));
    }

    [Theory]
    [InlineData("\n")]
    [InlineData("\r\n")]
    public void FirefoxAndDeveloperEditionSplitByName(string eol)
    {
        using var l = new TempDir();
        using var a = new TempDir();
        Write(UserData(a.Dir, "Mozilla", "Firefox", "profiles.ini"), Ini(eol,
            "[Install4F96D1932A9F858E]", "Default=Profiles/abc.default-release", "Locked=1", "",
            "[Profile2]", "Name=dev-edition-default", "IsRelative=1", "Path=Profiles/x.dev-edition-default", "",
            "[Profile1]", "Name=work", "IsRelative=1", "Path=Profiles/w.work", "",
            "[Profile0]", "Name=default-release", "IsRelative=1", "Path=Profiles/a.default-release", "Default=1", "",
            "[General]", "StartWithLastProfile=1", "Name=not-a-profile"));
        var ff = BrowserProfiles.ListFor(l.Dir, a.Dir, "firefox");
        var dev = BrowserProfiles.ListFor(l.Dir, a.Dir, "firefox-dev");
        Assert.Equal(new[] { "default-release", "work" }, ff.Select(p => p.Name));
        Assert.Equal(new[] { "dev-edition-default" }, dev.Select(p => p.Name));
        Assert.All(ff.Concat(dev), p => { Assert.Equal(p.Name, p.Folder); Assert.Null(p.ThemeColor); Assert.Null(p.AvatarFile); });
        Assert.Equal(new[] { "firefox", "firefox", "firefox-dev" }, BrowserProfiles.List(l.Dir, a.Dir).Select(p => p.Browser));
    }

    [Fact]
    public void FirefoxNamesThatCouldBecomeArgumentsAreRejected()
    {
        using var l = new TempDir();
        using var a = new TempDir();
        Write(UserData(a.Dir, "Mozilla", "Firefox", "profiles.ini"), Ini("\n",
            "[Profile0]", "Name=-profile x",
            "[Profile1]", "Name=-P other",
            "[Profile2]", "Name=ok name",
            "[Profile3]", "Name=a/b",
            "[Profile4]", "Name=..",
            "[Profile5]", "Name=x\u0022y",
            "[Profile6]", "Name=" + new string('a', 65),
            "[Profile7]", "Name="));
        Assert.Equal(new[] { "ok name" }, BrowserProfiles.ListFor(l.Dir, a.Dir, "firefox").Select(p => p.Name));
        Assert.Empty(BrowserProfiles.ListFor(l.Dir, a.Dir, "firefox-dev"));
    }

    [Fact]
    public void CorruptOrMissingFilesAreTolerated()
    {
        using var l = new TempDir();
        using var a = new TempDir();
        Assert.Empty(BrowserProfiles.List(l.Dir, a.Dir));
        Assert.Empty(BrowserProfiles.List(Path.Combine(l.Dir, "nope"), Path.Combine(a.Dir, "nope")));
        Write(UserData(l.Dir, "Google", "Chrome", "User Data", "Local State"), "{nope");
        Write(Path.Combine(BraveData(l.Dir), "Local State"), "[]");
        Write(UserData(l.Dir, "Yandex", "YandexBrowser", "User Data", "Local State"), "{'profile':{'info_cache':[1,2]}}");
        Write(UserData(l.Dir, "Microsoft", "Edge", "User Data", "Local State"), "{'profile':{'info_cache':{'Default':5,'../evil':{'name':'x'},'Good':{'name':'ok'}}}}");
        Write(UserData(a.Dir, "Opera Software", "Opera Stable"), "a file, not a folder");
        Write(UserData(a.Dir, "Mozilla", "Firefox", "profiles.ini"), "\0\u0001[Profile\u0002\n=\n==Name\n[Profile9]\nName");
        var list = BrowserProfiles.List(l.Dir, a.Dir);
        Assert.Equal(new[] { new Profile("edge", "Good", "ok") }, list);
    }

    [Fact]
    public void ProfileIdRulesDependOnFamily()
    {
        Assert.False(BrowserProfiles.IsValidProfileId("firefox", "-x"));
        Assert.False(BrowserProfiles.IsValidProfileId("firefox-dev", "-profile x"));
        Assert.True(BrowserProfiles.IsValidProfileId("firefox", "x y"));
        Assert.True(BrowserProfiles.IsValidProfileId("opera", "Opera Stable"));
        Assert.True(BrowserProfiles.IsValidProfileId("brave", "Profile 1"));
        Assert.False(BrowserProfiles.IsValidProfileId("brave", "../x"));
    }
}
