using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using BlueprintLauncher.App.Native;
using BlueprintLauncher.Core;

namespace BlueprintLauncher.App;

/// <summary>
/// blueprint-launcher.exe --check-autosend [browser] [profile-folder]: opens one new window with a fixed harmless text,
/// watches the page through UI Automation and reports when auto-send would be possible. Read-only: the Send button
/// is never pressed. Started only by this command line switch, never by a link. Opens no network connection.
/// </summary>
internal static class CheckMode
{
    internal const string Switch = "--check-autosend";
    private const int WindowWaitMs = 8000;
    private const int PollMs = 250;
    private const int TimeoutMs = 60000;
    private const string LogFile = "autosend.log";
    private const int MaxLogBytes = 64 * 1024;
    private const string Title = "Blueprint auto-send check";

    internal static bool IsSwitch(string[] args)
        => args.Length > 0 && string.Equals(args[0], Switch, StringComparison.OrdinalIgnoreCase);

    internal static int Run(string[] args)
    {
        var choice = Resolve(args);
        if (choice is null)
        {
            Show("Usage: blueprint-launcher.exe --check-autosend [browser] [profile-folder]\r\n\r\n"
                + "Without arguments the last browser and profile you picked are used. "
                + "Give the profile folder (for example Default) when you name a browser that is not the last choice.",
                MessageBoxIcon.Warning);
            return 2;
        }
        var (browser, folder) = choice.Value;
        var exe = Program.FindBrowser(browser);
        if (exe is null)
        {
            Show("The browser " + browser + " was not found on this PC.", MessageBoxIcon.Warning);
            return 2;
        }

        string report;
        var ready = false;
        try
        {
            // UI Automation must not run on the STA UI thread.
            var timeline = Task.Run(() => CheckAsync(browser, folder, exe)).GetAwaiter().GetResult();
            report = CheckReport.Format(browser, Environment.OSVersion.Version.ToString(), timeline, TimeoutMs)
                .Replace("\n", "\r\n");
            ready = timeline.IsReady;
        }
        catch (Exception e)
        {
            report = "Blueprint auto-send check (read-only, nothing was sent)\r\ncheck error: " + e.GetType().Name + "\r\n";
        }

        var logPath = Path.Combine(Program.DataDirectory, LogFile);
        AppendLog(logPath, report);
        Show(report + "\r\nLog: " + logPath, ready ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
        return ready ? 0 : 1;
    }

    private static (string Browser, string Folder)? Resolve(string[] args)
    {
        var last = Program.LoadLastChoice();
        string browser;
        string folder;
        if (args.Length >= 2)
        {
            browser = args[1].Trim().ToLowerInvariant();
            if (args.Length >= 3) folder = args[2];
            else if (last is not null && last.Value.Browser == browser) folder = last.Value.Folder;
            else return null;
        }
        else if (last is not null)
        {
            browser = last.Value.Browser;
            folder = last.Value.Folder;
        }
        else
        {
            return null;
        }
        if (!BrowserCatalog.IsKnown(browser) || !BrowserProfiles.IsValidFolder(folder)) return null;
        return (browser, folder);
    }

    private static async Task<CheckTimeline> CheckAsync(string browser, string folder, string exe)
    {
        var timeline = new CheckTimeline();
        var names = BrowserWindows.BrowserProcessNames;
        var before = BrowserWindows.Snapshot(names);
        var url = "https://claude.ai/new?q=" + Uri.EscapeDataString(AutoSendCheck.CheckText);
        var clock = Stopwatch.StartNew();
        Program.Run(LaunchCommand.Build(exe, browser, folder, url, true));

        var hwnd = await BrowserWindows.WaitForNewAsync(before, names, WindowWaitMs, CancellationToken.None);
        if (hwnd == IntPtr.Zero) return timeline;

        // Park at once: the window must be visible to finish loading.
        var token = WindowPlacer.Park(hwnd);
        try
        {
            GetWindowThreadProcessId(hwnd, out var pid);
            var page = new UiaChatPage(hwnd, (int)pid);
            while (true)
            {
                var snapshot = SafeRead(page);
                AutoSendCheck.Observe(timeline, snapshot, clock.ElapsedMilliseconds);
                if (timeline.IsReady || clock.ElapsedMilliseconds >= TimeoutMs) break;
                await Task.Delay(PollMs);
            }
        }
        finally
        {
            try
            {
                WindowPlacer.Restore(token);
            }
            catch (Exception)
            {
                // Restoring is best effort.
            }
        }
        return timeline;
    }

    private static PageSnapshot SafeRead(IChatPage page)
    {
        try
        {
            return page.Read() ?? Failed;
        }
        catch (Exception)
        {
            return Failed;
        }
    }

    private static readonly PageSnapshot Failed = new(false, false, false, null, false, false, "unknown", 0, 0, "read failed");

    private static void Show(string text, MessageBoxIcon icon)
        => MessageBox.Show(text, Title, MessageBoxButtons.OK, icon);

    /// <summary>Appends the report with a time stamp; keeps the file under 64 KB by dropping the oldest half.</summary>
    private static void AppendLog(string path, string report)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var stamp = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture);
            File.AppendAllText(path, stamp + " check-autosend" + Environment.NewLine + report + Environment.NewLine);
            if (new FileInfo(path).Length > MaxLogBytes)
            {
                var bytes = File.ReadAllBytes(path);
                var start = bytes.Length / 2;
                var nl = Array.IndexOf(bytes, (byte)'\n', start);
                if (nl >= 0 && nl + 1 < bytes.Length) start = nl + 1;
                File.WriteAllBytes(path, bytes[start..]);
            }
        }
        catch (Exception)
        {
            // Logging is best effort.
        }
    }

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
