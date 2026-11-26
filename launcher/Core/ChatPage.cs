namespace BlueprintLauncher.Core;

/// <summary>
/// One look at the chat page. A failed read has Error text and false flags.
/// WindowState is one of foreground, background, minimized, hidden, unknown.
/// </summary>
public sealed record PageSnapshot(
    bool WindowFound,
    bool DocumentFound,
    bool ComposerFound,
    string? ComposerText,
    bool SendFound,
    bool SendEnabled,
    string WindowState,
    int Nodes,
    int ScanMs,
    string? Error);

/// <summary>Seam between the send engine and the Windows adapter.</summary>
public interface IChatPage
{
    /// <summary>Read-only and never throws.</summary>
    PageSnapshot Read();

    /// <summary>
    /// Re-reads inside the same scan and invokes Send only when the composer text equals expectedComposerText
    /// (whitespace-insensitive) and the button is enabled. True when the click was made, false when refused.
    /// </summary>
    bool PressSend(string expectedComposerText);
}
