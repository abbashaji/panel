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
