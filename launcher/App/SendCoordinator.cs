using System.Globalization;
using System.Runtime.InteropServices;
using BlueprintLauncher.App.Native;
using BlueprintLauncher.Core;

namespace BlueprintLauncher.App;

/// <summary>One cell to launch and send.</summary>
internal sealed record SendJob(string Repo, string Cell, string Browser, string ProfileFolder, string Exe);

/// <summary>
/// Runs auto-send jobs one after another: launch, park, engine, restore. Called on the UI thread and never blocks it.
/// The engine and every UI Automation call run on thread-pool threads. Opens no network connection.
/// </summary>
internal static class SendCoordinator
{
    private const int WindowWaitMs = 8000;
    private const int PauseAfterFailureMs = 3000;
    private const string LogFile = "autosend.log";
    private const int MaxLogBytes = 64 * 1024;

    public static async Task<IReadOnlyList<AutoSendResult>> RunAsync(
        IReadOnlyList<SendJob> jobs, LauncherSettings settings, string dataDirectory, CancellationToken stopAll)
    {
        var results = new List<AutoSendResult>();
        try
        {
            using var batch = CancellationTokenSource.CreateLinkedTokenSource(stopAll);
            SendStatusForm? previous = null;
            for (var i = 0; i < jobs.Count; i++)
            {
                var job = jobs[i];
                if (batch.IsCancellationRequested)
                {
                    results.Add(Failed(AutoSendReason.Refused));
                    continue;
                }
                CloseQuietly(previous);
                var label = jobs.Count > 1 ? job.Cell + " (" + (i + 1).ToString(CultureInfo.InvariantCulture) + " of " + jobs.Count.ToString(CultureInfo.InvariantCulture) + ")" : job.Cell;
                AutoSendResult result;
                SendStatusForm? form = null;
                try
                {
                    using var jobCts = CancellationTokenSource.CreateLinkedTokenSource(batch.Token);
                    form = new SendStatusForm(label);
                    var shown = form;
                    form.CancelRequested += () => jobCts.Cancel();
                    // Closing the window before a result stops this job and the rest of the batch.
                    form.FormClosed += (_, _) =>
                    {
                        if (!shown.HasResult) batch.Cancel();
                    };
                    form.Show();
                    result = await RunOneAsync(job, form, settings, dataDirectory, jobCts.Token);
                }
                catch (Exception e)
                {
                    LogException(dataDirectory, e);
                    result = Failed(AutoSendReason.Refused);
                }
                results.Add(result);
                try
                {
                    form?.ShowResult(result);
                }
                catch (Exception e)
                {
                    LogException(dataDirectory, e);
                }
                previous = form;
                if (result.Outcome != AutoSendOutcome.Sent && i < jobs.Count - 1 && !batch.IsCancellationRequested)
                {
                    try
                    {
                        await Task.Delay(PauseAfterFailureMs, batch.Token);
                    }
                    catch (OperationCanceledException)
                    {
                        // Stopped while waiting.
                    }
                }
            }
        }
        catch (Exception e)
        {
            LogException(dataDirectory, e);
            while (results.Count < jobs.Count) results.Add(Failed(AutoSendReason.Refused));
        }
        return results;
    }

    private static async Task<AutoSendResult> RunOneAsync(
        SendJob job, SendStatusForm form, LauncherSettings settings, string dataDirectory, CancellationToken ct)
    {
        try
        {
            if (!settings.IsRepoAllowed(job.Repo)) return Failed(AutoSendReason.Refused);

            var names = BrowserWindows.BrowserProcessNames;
            var before = BrowserWindows.Snapshot(names);
            var url = PromptBuilder.BuildUrl(job.Repo, job.Cell);
            Program.Run(LaunchCommand.Build(job.Exe, job.Browser, job.ProfileFolder, url, true));

            var hwnd = await BrowserWindows.WaitForNewAsync(before, names, WindowWaitMs, ct);
            if (hwnd == IntPtr.Zero) return Failed(AutoSendReason.NoWindow);

            // Park at once, before any page is read; the window must be visible to finish loading.
            var token = WindowPlacer.Park(hwnd);
            try
            {
                GetWindowThreadProcessId(hwnd, out var pid);
                var request = new AutoSendRequest(job.Repo, job.Cell, PromptBuilder.BuildPrompt(job.Repo, job.Cell));
                var progress = new Progress<AutoSendProgress>(form.Update); // created on the UI thread
                return await Task.Run(() =>
                {
                    var page = new UiaChatPage(hwnd, (int)pid);
                    var engine = new AutoSendEngine(
                        page, new SystemClock(), settings, new AutoSendGuard(dataDirectory), new FileAutoSendLog(dataDirectory));
                    return engine.RunAsync(request, progress, ct);
                });
            }
            finally
            {
                try
                {
                    WindowPlacer.Restore(token);
                }
                catch (Exception e)
                {
                    LogException(dataDirectory, e);
                }
            }
        }
        catch (Exception e)
        {
            LogException(dataDirectory, e);
            return Failed(AutoSendReason.Refused);
        }
    }

    private static AutoSendResult Failed(AutoSendReason reason)
        => new(AutoSendOutcome.NotSent, reason, 0, default);

    private static void CloseQuietly(SendStatusForm? form)
    {
        try
        {
            if (form is { IsDisposed: false }) form.Close();
        }
        catch (Exception)
        {
            // Already closing.
        }
    }

    /// <summary>One line with the exception type only: never a message, prompt, URL or repo name.</summary>
    private static void LogException(string dataDirectory, Exception e)
    {
        try
        {
            Directory.CreateDirectory(dataDirectory);
            var path = Path.Combine(dataDirectory, LogFile);
            var line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture)
                + " coordinator error: " + e.GetType().Name + Environment.NewLine;
            File.AppendAllText(path, line);
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
