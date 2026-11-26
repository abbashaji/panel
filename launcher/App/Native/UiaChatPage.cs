using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Automation;
using BlueprintLauncher.Core;

namespace BlueprintLauncher.App.Native;

/// <summary>
/// Reads one browser window through UI Automation and presses Send with InvokePattern only.
/// Every call must run on a thread-pool (MTA) thread, never on the WinForms UI thread.
/// </summary>
public sealed class UiaChatPage : IChatPage
{
    // The single list of accepted Send button names (English UI).
    private static readonly string[] SendButtonNames = { "Send message" };

    private const int MaxNodes = 6000;
    private const int MaxMillis = 4000;
    private const int MaxDepth = 200;
    private const int TextLimit = 4000;

    private readonly IntPtr _hwnd;

    public UiaChatPage(IntPtr hwnd, int processId)
    {
        _hwnd = hwnd;
        ProcessId = processId;
    }

    public int ProcessId { get; }

    private sealed class ScanData
    {
        public bool WindowFound;
        public bool DocumentFound;
        public bool Truncated;
        public int Nodes;
        public string State = "unknown";
        public readonly List<AutomationElement> Edits = new();
        public readonly List<AutomationElement> SendButtons = new();
    }

    public PageSnapshot Read()
    {
        var clock = Stopwatch.StartNew();
        try
        {
            if (IsStaThread()) return Failed("sta thread", clock);
            var data = Scan(clock);
            return ToSnapshot(data, clock);
        }
        catch (Exception ex)
        {
            return Failed(ex.GetType().Name, clock);
        }
    }

    private ScanData Scan(Stopwatch clock)
    {
        var data = new ScanData { State = BrowserWindows.StateOf(_hwnd) };
        if (_hwnd == IntPtr.Zero || !NativeMethods.IsWindow(_hwnd)) return data;

        AutomationElement root;
        try
        {
            root = AutomationElement.FromHandle(_hwnd);
        }
        catch (Exception ex) when (IsGone(ex) || ex is ArgumentException)
        {
            return data;
        }
        data.WindowFound = true;

        var cache = new CacheRequest { TreeScope = TreeScope.Element, AutomationElementMode = AutomationElementMode.Full };
        cache.Add(AutomationElement.ControlTypeProperty);
        cache.Add(AutomationElement.NameProperty);
        cache.Add(AutomationElement.ClassNameProperty);
        cache.Add(AutomationElement.IsEnabledProperty);
        cache.Add(AutomationElement.IsOffscreenProperty);

        Walk(root, 0, false, TreeWalker.ControlViewWalker, cache, data, clock);
        return data;
    }

    private static void Walk(AutomationElement parent, int depth, bool inDocument, TreeWalker walker, CacheRequest cache, ScanData data, Stopwatch clock)
    {
        AutomationElement? child;
        try
        {
            child = walker.GetFirstChild(parent, cache);
        }
        catch (Exception ex) when (IsGone(ex))
        {
            return;
        }

        while (child != null)
        {
            if (data.Nodes >= MaxNodes || clock.ElapsedMilliseconds >= MaxMillis)
            {
                data.Truncated = true;
                return;
            }
            data.Nodes++;
            try
            {
                var type = child.Cached.ControlType;
                var childInDocument = inDocument;
                var descend = true;
                if (type == ControlType.Document)
                {
                    data.DocumentFound = true;
                    childInDocument = true;
                }
                else if (inDocument && type == ControlType.Edit)
                {
                    data.Edits.Add(child);
                    descend = false;
                }
                else if (inDocument && type == ControlType.Button)
                {
                    if (IsSendName(child.Cached.Name)) data.SendButtons.Add(child);
                    descend = false;
                }
                if (descend && depth < MaxDepth) Walk(child, depth + 1, childInDocument, walker, cache, data, clock);
                if (data.Truncated) return;
            }
            catch (Exception ex) when (IsGone(ex))
            {
            }

            try
            {
                child = walker.GetNextSibling(child, cache);
            }
            catch (Exception ex) when (IsGone(ex))
            {
                return;
            }
        }
    }

    private static bool IsSendName(string? name)
    {
        if (string.IsNullOrEmpty(name)) return false;
        foreach (var candidate in SendButtonNames)
        {
            if (string.Equals(candidate, name, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    // Picks the composer among the Edits inside the Document. Never uses the control name.
    private static (AutomationElement? Element, string? Text) PickComposer(List<AutomationElement> edits, string? expected)
    {
        var want = expected == null ? null : Squash(expected);
        AutomationElement? bestElement = null;
        string? bestText = null;
        var bestRank = -1;
        foreach (var edit in edits)
        {
            var text = ReadText(edit);
            if (want != null && text != null && Squash(text) == want) return (edit, text);
            var rank = text == null ? 0 : (Squash(text).Length > 0 ? 2 : 1);
            if (rank > bestRank)
            {
                bestRank = rank;
                bestElement = edit;
                bestText = text;
            }
        }
        return (bestElement, bestText);
    }

    private static string? ReadText(AutomationElement element)
    {
        try
        {
            string? value = null;
            if (element.TryGetCurrentPattern(ValuePattern.Pattern, out var valueObject) && valueObject is ValuePattern valuePattern)
            {
                value = valuePattern.Current.Value ?? string.Empty;
                if (value.Length > 0) return value;
            }
            if (element.TryGetCurrentPattern(TextPattern.Pattern, out var textObject) && textObject is TextPattern textPattern)
            {
                var text = textPattern.DocumentRange.GetText(TextLimit) ?? string.Empty;
                if (text.Length > 0 || value == null) return text;
            }
            return value;
        }
        catch (Exception ex) when (IsGone(ex) || ex is InvalidOperationException)
        {
            return null;
        }
    }

    // A matching Send button counts only when it supports InvokePattern.
    private static AutomationElement? PickSend(List<AutomationElement> buttons)
    {
        foreach (var button in buttons)
        {
            try
            {
                if (button.TryGetCurrentPattern(InvokePattern.Pattern, out _)) return button;
            }
            catch (Exception ex) when (IsGone(ex))
            {
            }
        }
        return null;
    }

    private static PageSnapshot ToSnapshot(ScanData data, Stopwatch clock)
    {
        var (composer, text) = PickComposer(data.Edits, null);
        var send = PickSend(data.SendButtons);
        var sendEnabled = false;
        if (send != null)
        {
            try
            {
                sendEnabled = send.Cached.IsEnabled;
            }
            catch (Exception ex) when (IsGone(ex))
            {
            }
        }

        string? error = null;
        if (!data.WindowFound) error = "window not found";
        else if (data.Truncated && (composer == null || send == null)) error = "scan budget";

        return new PageSnapshot(
            data.WindowFound, data.DocumentFound, composer != null, text,
            send != null, sendEnabled, data.State, data.Nodes, (int)clock.ElapsedMilliseconds, error);
    }

    public bool PressSend(string expectedComposerText)
    {
        var clock = Stopwatch.StartNew();
        try
        {
            if (IsStaThread()) return false;
            if (string.IsNullOrWhiteSpace(expectedComposerText)) return false;
            var want = Squash(expectedComposerText);

            var data = Scan(clock);
            if (!data.WindowFound || !data.DocumentFound) return false;

            var (composer, text) = PickComposer(data.Edits, expectedComposerText);
            if (composer == null || text == null || Squash(text) != want) return false;

            var send = PickSend(data.SendButtons);
            if (send == null || !send.Cached.IsEnabled) return false;

            // Last look, right before the press: live composer text and live enabled state.
            var live = ReadText(composer);
            if (live == null || Squash(live) != want) return false;
            if (!send.Current.IsEnabled) return false;

            if (!send.TryGetCurrentPattern(InvokePattern.Pattern, out var patternObject) || patternObject is not InvokePattern invoke) return false;
            invoke.Invoke();
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static string Squash(string value)
    {
        var builder = new System.Text.StringBuilder(value.Length);
        foreach (var c in value)
        {
            if (!char.IsWhiteSpace(c)) builder.Append(c);
        }
        return builder.ToString();
    }

    private static PageSnapshot Failed(string error, Stopwatch clock)
    {
        return new PageSnapshot(false, false, false, null, false, false, "unknown", 0, (int)clock.ElapsedMilliseconds, error);
    }

    private static bool IsStaThread()
    {
        return Thread.CurrentThread.GetApartmentState() == ApartmentState.STA;
    }

    private static bool IsGone(Exception ex)
    {
        return ex is ElementNotAvailableException || ex is COMException;
    }
}
