using BlueprintLauncher.Core;

namespace BlueprintLauncher.Core.Tests;

public class AutoSendResultTests
{
    private static AutoSendResult R(AutoSendOutcome o, AutoSendReason r = AutoSendReason.None) => new(o, r, 10, "background");

    [Fact]
    public void Sent_text()
        => Assert.Equal("Sent.", R(AutoSendOutcome.Sent).PlainText());

    [Fact]
    public void NotConfirmed_text()
        => Assert.Equal("Send was pressed but the chat did not confirm it. Look at the chat window.", R(AutoSendOutcome.NotConfirmed).PlainText());

    [Fact]
    public void Cancelled_text()
        => Assert.Equal("Cancelled. Press Send yourself if you still want it.", R(AutoSendOutcome.Cancelled).PlainText());

    [Theory]
    [InlineData(AutoSendReason.RepoNotAllowed, "Auto-send is not allowed for this repo on this PC. Press Send yourself.")]
    [InlineData(AutoSendReason.RateLimited, "Too many auto-sends in 10 minutes. Press Send yourself.")]
    [InlineData(AutoSendReason.NoWindow, "The browser window was not found. Press Send yourself.")]
    [InlineData(AutoSendReason.NoDocument, "This browser does not show the page to Windows UI Automation. Press Send yourself.")]
    [InlineData(AutoSendReason.NoComposer, "The prompt box was not found. Press Send yourself.")]
    [InlineData(AutoSendReason.TextMismatch, "The prompt was changed. Press Send yourself.")]
    [InlineData(AutoSendReason.SendNotFound, "The Send button was not available. Press Send yourself.")]
    [InlineData(AutoSendReason.SendDisabled, "The Send button was not available. Press Send yourself.")]
    [InlineData(AutoSendReason.PageChanged, "The page changed during the countdown. Press Send yourself.")]
    [InlineData(AutoSendReason.Refused, "Windows refused the click. Press Send yourself.")]
    public void NotSent_text_per_reason(AutoSendReason reason, string expected)
        => Assert.Equal(expected, R(AutoSendOutcome.NotSent, reason).PlainText());

    [Fact]
    public void Every_reason_has_a_text_that_tells_the_teammate_what_to_do()
    {
        foreach (var reason in Enum.GetValues<AutoSendReason>())
        {
            var text = R(AutoSendOutcome.NotSent, reason).PlainText();
            Assert.False(string.IsNullOrWhiteSpace(text));
            Assert.Contains("Press Send yourself", text);
        }
    }

    [Fact]
    public void Reason_is_ignored_for_sent_and_cancelled()
    {
        Assert.Equal("Sent.", R(AutoSendOutcome.Sent, AutoSendReason.Refused).PlainText());
        Assert.Equal("Cancelled. Press Send yourself if you still want it.", R(AutoSendOutcome.Cancelled, AutoSendReason.NoWindow).PlainText());
    }
}
