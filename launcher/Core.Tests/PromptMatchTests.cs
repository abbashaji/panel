using BlueprintLauncher.Core;
using Xunit;

namespace BlueprintLauncher.Core.Tests;

public class PromptMatchTests
{
    private const string Repo = "abbashaji/panel";
    private const string Cell = "C-091";

    private static string Prompt => PromptBuilder.BuildPrompt(Repo, Cell);
    private static string Flat => Prompt.Replace("\n", " ");

    private static void AssertAccepted(string text)
    {
        Assert.True(PromptBuilder.TryMatchCellPrompt(text, out var repo, out var cell));
        Assert.Equal(Repo, repo);
        Assert.Equal(Cell, cell);
    }

    private static void AssertRejected(string? text)
    {
        Assert.False(PromptBuilder.TryMatchCellPrompt(text, out var repo, out var cell));
        Assert.Equal(string.Empty, repo);
        Assert.Equal(string.Empty, cell);
    }

    [Fact]
    public void AcceptsTemplateWithNewlines() => AssertAccepted(Prompt);

    [Fact]
    public void AcceptsTemplateWithSingleSpaces() => AssertAccepted(Flat);

    [Fact]
    public void AcceptsOtherWhitespaceRunsAndEnds()
        => AssertAccepted("  " + Prompt.Replace("\n", "\r\n\r\n").Replace("Do only", "Do\t\u00A0only") + "\n");

    [Fact]
    public void RejectsExtraWord()
    {
        AssertRejected("Please " + Prompt);
        AssertRejected(Prompt + " Thanks");
        AssertRejected(Flat.Replace("Do only", "Do not only"));
    }

    [Fact]
    public void RejectsMissingWord()
    {
        AssertRejected(Flat.Replace("Do only that", "Do that"));
        AssertRejected(Flat.Replace(" (reserved for me)", ""));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public void RejectsMissingLine(int skip)
    {
        var lines = Prompt.Split('\n').Where((_, i) => i != skip);
        AssertRejected(string.Join("\n", lines));
    }

    [Fact]
    public void RejectsStewardPrompt()
        => AssertRejected("You are the Steward of " + Repo + ".\n"
            + "Call steward_next with repo, who and code=abcd. The code works once and expires in 10 minutes.\n"
            + "You have no admin key and must never ask for one.");

    [Fact]
    public void RejectsAdminKeyPrompt() => AssertRejected(PromptBuilder.BuildStewardPrompt(Repo));

    [Theory]
    [InlineData("owner")]
    [InlineData("a/b/c")]
    [InlineData("own<er>/name")]
    [InlineData("owner/na me")]
    public void RejectsBadRepo(string bad) => AssertRejected(Prompt.Replace(Repo, bad));

    [Theory]
    [InlineData("X-091")]
    [InlineData("C-abc")]
    [InlineData("C-091;x")]
    [InlineData("")]
    public void RejectsBadCell(string bad) => AssertRejected(Prompt.Replace(Cell, bad));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData(" \n ")]
    public void RejectsNullOrEmpty(string? text) => AssertRejected(text);
}
