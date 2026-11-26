using BlueprintLauncher.Core;
using Xunit;

namespace BlueprintLauncher.Core.Tests;

public class NativeLaunchTests
{
    private const string Exe = @"C:\Browsers\browser.exe";
    private static string Url => PromptBuilder.BuildUrl("abbashaji/panel", "C-091");

    [Theory]
    [InlineData("chrome", "Profile 1")]
    [InlineData("edge", "Default")]
    [InlineData("brave", "Default")]
    [InlineData("yandex", "Default")]
    [InlineData("opera", "Default")]
    [InlineData("firefox", "default-release")]
    public void WithoutNewWindowMatchesExistingOverload(string browser, string profile)
    {
        var expected = LaunchCommand.Build(Exe, browser, profile, Url);
        var actual = LaunchCommand.Build(Exe, browser, profile, Url, false);
        Assert.Equal(expected.Exe, actual.Exe);
        Assert.Equal(expected.Arguments, actual.Arguments);
    }

    [Theory]
    [InlineData("chrome")]
    [InlineData("edge")]
    [InlineData("brave")]
    [InlineData("yandex")]
    public void ChromiumNewWindow(string browser)
    {
        var command = LaunchCommand.Build(Exe, browser, "Profile 1", Url, true);
        Assert.Equal(Exe, command.Exe);
        Assert.Equal(new[] { "--profile-directory=Profile 1", "--new-window", Url }, command.Arguments);
    }

    [Fact]
    public void OperaNewWindow()
    {
        var command = LaunchCommand.Build(Exe, "opera", "Default", Url, true);
        Assert.Equal(Exe, command.Exe);
        Assert.Equal(new[] { "--new-window", Url }, command.Arguments);
    }

    [Fact]
    public void FirefoxNewWindow()
    {
        var command = LaunchCommand.Build(Exe, "firefox", "default-release", Url, true);
        Assert.Equal(Exe, command.Exe);
        Assert.Equal(new[] { "-P", "default-release", "-new-window", Url }, command.Arguments);
    }

    [Theory]
    [InlineData("chrome", "")]
    [InlineData("chrome", @"..\x")]
    [InlineData("firefox", "")]
    [InlineData("firefox", "a\nb")]
    public void RejectsInvalidProfile(string browser, string profile)
    {
        Assert.Throws<ArgumentException>(() => LaunchCommand.Build(Exe, browser, profile, Url, true));
        Assert.Throws<ArgumentException>(() => LaunchCommand.Build(Exe, browser, profile, Url, false));
    }

    [Theory]
    [InlineData("chrome")]
    [InlineData("opera")]
    [InlineData("firefox")]
    public void RejectsInvalidUrl(string browser)
    {
        foreach (var url in new[] { "", "https://example.com/?q=x", "https://claude.ai/new?q=a b" })
        {
            Assert.Throws<ArgumentException>(() => LaunchCommand.Build(Exe, browser, "Default", url, true));
            Assert.Throws<ArgumentException>(() => LaunchCommand.Build(Exe, browser, "Default", url, false));
        }
    }

    [Fact]
    public void RejectsInvalidExeAndUnknownBrowser()
    {
        Assert.Throws<ArgumentException>(() => LaunchCommand.Build("", "chrome", "Default", Url, true));
        Assert.Throws<ArgumentException>(() => LaunchCommand.Build(Exe, "netscape", "Default", Url, true));
    }
}
