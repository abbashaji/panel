namespace BlueprintLauncher.Core.Tests;

public class BrowserCatalogTests
{
    private static readonly string Url = PromptBuilder.BaseUrl + "abc";

    [Fact]
    public void AllIsInFixedOrderWithDisplayNames()
    {
        Assert.Equal(new[] { "chrome", "edge", "brave", "yandex", "opera", "firefox", "firefox-dev" }, BrowserCatalog.All.Select(b => b.Id));
        Assert.Equal(
            new[] { "Google Chrome", "Microsoft Edge", "Brave", "Yandex Browser", "Opera", "Firefox", "Firefox Developer Edition" },
            BrowserCatalog.All.Select(b => b.Display));
        Assert.Equal(
            new[] { BrowserFamily.Chromium, BrowserFamily.Chromium, BrowserFamily.Chromium, BrowserFamily.Chromium, BrowserFamily.Opera, BrowserFamily.Firefox, BrowserFamily.Firefox },
            BrowserCatalog.All.Select(b => b.Family));
    }

    [Theory]
    [InlineData("chrome", true)]
    [InlineData("firefox-dev", true)]
    [InlineData("Chrome", false)]
    [InlineData("chrome ", false)]
    [InlineData("safari", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void IsKnownIsExact(string? id, bool expected) => Assert.Equal(expected, BrowserCatalog.IsKnown(id));

    [Fact]
    public void GetReturnsInfoOrThrows()
    {
        Assert.Equal("Brave", BrowserCatalog.Get("brave").Display);
        Assert.Throws<ArgumentException>(() => BrowserCatalog.Get("safari"));
    }

    [Theory]
    [InlineData("chrome", "Google/Chrome/Application/chrome.exe")]
    [InlineData("edge", "Microsoft/Edge/Application/msedge.exe")]
    [InlineData("brave", "BraveSoftware/Brave-Browser/Application/brave.exe")]
    [InlineData("yandex", "Yandex/YandexBrowser/Application/browser.exe")]
    [InlineData("opera", "Programs/Opera/opera.exe")]
    [InlineData("opera", "Opera/opera.exe")]
    [InlineData("firefox", "Mozilla Firefox/firefox.exe")]
    [InlineData("firefox-dev", "Firefox Developer Edition/firefox.exe")]
    public void LocatorFindsStandardDirs(string id, string rel)
    {
        using var t = new TempDir();
        var file = Path.Combine(t.Dir, rel);
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllText(file, "");
        var loc = new BrowserExeLocator(new[] { t.Dir }, _ => null);
        Assert.Equal(Path.Combine(t.Dir, Path.Combine(rel.Split('/'))), loc.Find(id));
    }

    [Fact]
    public void LocatorUnknownOrMissingIsNull()
    {
        using var t = new TempDir();
        var loc = new BrowserExeLocator(new[] { t.Dir }, _ => null);
        Assert.Null(loc.Find("safari"));
        foreach (var b in BrowserCatalog.All) Assert.Null(loc.Find(b.Id));
    }

    [Fact]
    public void LocatorPrefersRegistryAndAsksForTheRightExeName()
    {
        using var t = new TempDir();
        var custom = Path.Combine(t.Dir, "custom", "brave.exe");
        Directory.CreateDirectory(Path.GetDirectoryName(custom)!);
        File.WriteAllText(custom, "");
        var asked = new List<string>();
        var loc = new BrowserExeLocator(Array.Empty<string>(), exe => { asked.Add(exe); return exe == "brave.exe" ? "\"" + custom + "\"" : null; });
        Assert.Equal(custom, loc.Find("brave"));
        Assert.Equal(new[] { "brave.exe" }, asked);
    }

    [Fact]
    public void FirefoxEditionsDoNotShareARegistryPath()
    {
        using var t = new TempDir();
        var release = Path.Combine(t.Dir, "Mozilla Firefox", "firefox.exe");
        Directory.CreateDirectory(Path.GetDirectoryName(release)!);
        File.WriteAllText(release, "");
        var loc = new BrowserExeLocator(Array.Empty<string>(), _ => release);
        Assert.Equal(release, loc.Find("firefox"));
        Assert.Null(loc.Find("firefox-dev"));
    }

    [Theory]
    [InlineData("chrome")]
    [InlineData("edge")]
    [InlineData("brave")]
    [InlineData("yandex")]
    public void ChromiumArguments(string id)
    {
        var cmd = LaunchCommand.Build("b.exe", id, "Profile 1", Url);
        Assert.Equal("b.exe", cmd.Exe);
        Assert.Equal(new[] { "--profile-directory=Profile 1", Url }, cmd.Arguments);
    }

    [Fact]
    public void OperaGetsOnlyTheUrl()
    {
        Assert.Equal(new[] { Url }, LaunchCommand.Build("opera.exe", "opera", "Opera Stable", Url).Arguments);
        Assert.Equal(new[] { Url }, LaunchCommand.Build("opera.exe", "opera", "--anything", Url).Arguments);
    }

    [Theory]
    [InlineData("firefox")]
    [InlineData("firefox-dev")]
    public void FirefoxGetsSeparateArguments(string id)
    {
        var cmd = LaunchCommand.Build("firefox.exe", id, "work profile", Url);
        Assert.Equal(new[] { "-P", "work profile", Url }, cmd.Arguments);
    }

    [Theory]
    [InlineData("firefox", "-profile x")]
    [InlineData("firefox-dev", "-P")]
    [InlineData("firefox", "a/b")]
    [InlineData("firefox", "")]
    [InlineData("chrome", "../x")]
    [InlineData("brave", "Default;calc")]
    [InlineData("safari", "Default")]
    public void BadProfileOrBrowserIsRejected(string id, string profile)
    {
        Assert.Throws<ArgumentException>(() => LaunchCommand.Build("b.exe", id, profile, Url));
    }

    [Theory]
    [InlineData("chrome")]
    [InlineData("opera")]
    [InlineData("firefox")]
    public void BadUrlOrExeIsRejectedForEveryFamily(string id)
    {
        Assert.Throws<ArgumentException>(() => LaunchCommand.Build("b.exe", id, "Default", "https://evil.example/"));
        Assert.Throws<ArgumentException>(() => LaunchCommand.Build("b.exe", id, "Default", Url + " --x"));
        Assert.Throws<ArgumentException>(() => LaunchCommand.Build("b\n.exe", id, "Default", Url));
        Assert.Throws<ArgumentException>(() => LaunchCommand.Build("", id, "Default", Url));
    }

    [Fact]
    public void OldChromiumOverloadStillWorks()
    {
        Assert.Equal(new[] { "--profile-directory=Default", Url }, LaunchCommand.Build("c.exe", "Default", Url).Arguments);
        Assert.Throws<ArgumentException>(() => LaunchCommand.Build("c.exe", "..", Url));
    }
}
