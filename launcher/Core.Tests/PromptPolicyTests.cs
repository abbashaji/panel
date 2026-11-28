using BlueprintLauncher.Core;
using Xunit;

namespace BlueprintLauncher.Core.Tests;

public class PromptPolicyTests
{
    private const string Repo = "abbashaji/panel";
    private const string CellId = "C-102";
    private const string Code = "AbCdEf0123456789_-xy";

    private static string CellText() => PromptBuilder.BuildPrompt(Repo, CellId);

    [Fact]
    public void FixedCellPromptIsSendable()
    {
        Assert.True(PromptPolicy.IsSendable(PromptKind.Cell, Repo, CellId, CellText(), out var reason));
        Assert.Equal(string.Empty, reason);
    }

    [Fact]
    public void EditedCellPromptIsSendable()
    {
        var text = CellText() + "\nRun the tests twice.\tThanks.\r\n";
        Assert.True(PromptPolicy.IsSendable(PromptKind.Cell, Repo, CellId, text, out var reason));
        Assert.Equal(string.Empty, reason);
        Assert.True(PromptPolicy.IsSendable(PromptKind.Cell, Repo, CellId, "Please call next_cell cell_id=C-102.", out _));
        Assert.True(PromptPolicy.IsSendable(PromptKind.Cell, Repo, CellId, "next_cell\ncell_id=C-102", out _));
    }

    [Theory]
    [InlineData("", "The prompt is empty.")]
    [InlineData("  \n\t ", "The prompt is empty.")]
    [InlineData("<>", "The prompt is empty.")]
    [InlineData("Repo: abbashaji/panel cell_id=C-102", "The prompt must still mention next_cell.")]
    [InlineData("Call next_cell for me.", "The prompt must still mention cell_id=C-102.")]
    [InlineData("Call next_cell with cell_id=C-103.", "The prompt must still mention cell_id=C-102.")]
    [InlineData("Call next_cell with cell_id=C-1023.", "The prompt must still mention cell_id=C-102.")]
    [InlineData("Call next_cell with cell_id=C-102-x.", "The prompt must still mention cell_id=C-102.")]
    [InlineData("Call next_cell with xcell_id=C-102.", "The prompt must still mention cell_id=C-102.")]
    [InlineData("Call next_cell with cell_id = C-102.", "The prompt must still mention cell_id=C-102.")]
    public void CellPromptRejects(string text, string expectedReason)
    {
        Assert.False(PromptPolicy.IsSendable(PromptKind.Cell, Repo, CellId, text, out var reason));
        Assert.Equal(expectedReason, reason);
    }

    [Fact]
    public void StewardKindNeedsStewardNext()
    {
        Assert.True(PromptPolicy.IsSendable(PromptKind.Steward, Repo, null, PromptBuilder.BuildStewardPrompt(Repo, Code), out var ok));
        Assert.Equal(string.Empty, ok);
        Assert.True(PromptPolicy.IsSendable(PromptKind.Steward, Repo, null, "Edited: call steward_next now.", out _));
        Assert.False(PromptPolicy.IsSendable(PromptKind.Steward, Repo, null, CellText(), out var reason));
        Assert.Equal("The prompt must still mention steward_next.", reason);
        Assert.False(PromptPolicy.IsSendable(PromptKind.Cell, Repo, CellId, PromptBuilder.BuildStewardPrompt(Repo, Code), out _));
    }

    [Fact]
    public void InvalidRepoOrCellIsRejected()
    {
        foreach (var repo in new[] { "", "bad", "a/b/c", "with space/x" })
        {
            Assert.False(PromptPolicy.IsSendable(PromptKind.Cell, repo, CellId, CellText(), out var r1));
            Assert.Equal("The repo name is not valid.", r1);
            Assert.False(PromptPolicy.IsSendable(PromptKind.Steward, repo, null, "steward_next", out var r2));
            Assert.Equal("The repo name is not valid.", r2);
        }
        foreach (var cell in new string?[] { null, "", "C-1", "X-102" })
        {
            Assert.False(PromptPolicy.IsSendable(PromptKind.Cell, Repo, cell, CellText(), out var reason));
            Assert.Equal("The cell id is not valid.", reason);
        }
    }

    [Fact]
    public void LengthLimitIs1500()
    {
        var head = "next_cell cell_id=C-102 ";
        var ok = head + new string('a', 1500 - head.Length);
        Assert.Equal(1500, ok.Length);
        Assert.True(PromptPolicy.IsSendable(PromptKind.Cell, Repo, CellId, ok, out _));
        Assert.False(PromptPolicy.IsSendable(PromptKind.Cell, Repo, CellId, ok + "a", out var reason));
        Assert.Equal("The prompt is longer than 1500 characters.", reason);
    }

    [Theory]
    [InlineData("\u0000")]
    [InlineData("\u0007")]
    [InlineData("\u001b")]
    [InlineData("\u007f")]
    public void ControlCharactersAreRejected(string bad)
    {
        var text = CellText() + bad + "x";
        Assert.False(PromptPolicy.IsSendable(PromptKind.Cell, Repo, CellId, text, out var reason));
        Assert.Equal("The prompt contains a control character.", reason);
    }

    [Fact]
    public void SanitizeStripsAngleBracketsAndNormalizesLineEnds()
    {
        Assert.Equal("abc", PromptPolicy.Sanitize("a<b>c"));
        Assert.Equal("a\nb\nc", PromptPolicy.Sanitize("a\r\nb\rc\n"));
        Assert.Equal("x", PromptPolicy.Sanitize("  \n x \r\n "));
        Assert.Equal(string.Empty, PromptPolicy.Sanitize(null!));
        Assert.True(PromptPolicy.IsSendable(PromptKind.Cell, Repo, CellId, "next_cell cell_id=<C-102>", out _));
    }

    [Fact]
    public void BuildUrlFromTextMatchesTheFixedUrls()
    {
        Assert.Equal(PromptBuilder.BuildUrl(Repo, CellId), PromptBuilder.BuildUrlFromText(CellText()));
        Assert.Equal(PromptBuilder.BuildStewardUrl(Repo, Code), PromptBuilder.BuildUrlFromText(PromptBuilder.BuildStewardPrompt(Repo, Code)));
        Assert.Equal(PromptBuilder.BaseUrl + "ab", PromptBuilder.BuildUrlFromText(" a<b>\r\n"));
    }

    [Fact]
    public void BuildUrlFromTextLimitsTheEscapedLength()
    {
        Assert.Equal(PromptBuilder.BaseUrl.Length + 6000, PromptBuilder.BuildUrlFromText(new string('a', 6000)).Length);
        Assert.Throws<ArgumentException>(() => PromptBuilder.BuildUrlFromText(new string('a', 6001)));
        Assert.Throws<ArgumentException>(() => PromptBuilder.BuildUrlFromText(string.Concat(Enumerable.Repeat("ab\n", 1500))));
    }

    [Fact]
    public void LegacyAutoSendMarkerStillOnlyAcceptsTheFixedCellUrl()
    {
        var url = PromptBuilder.BuildUrlFromText(CellText());
        Assert.Equal(url + PromptBuilder.AutoSendSuffix, PromptBuilder.WithAutoSend(url));
        Assert.Throws<ArgumentException>(() => PromptBuilder.WithAutoSend(PromptBuilder.BuildStewardUrl(Repo, Code)));
        Assert.Throws<ArgumentException>(() => PromptBuilder.WithAutoSend(PromptBuilder.BuildUrlFromText(CellText() + "\nExtra.")));
    }
