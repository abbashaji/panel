using System.Diagnostics;
using System.Windows.Forms;
using BlueprintLauncher.Core;

namespace BlueprintLauncher.App;

/// <summary>Entry point and small helpers. Opens no network connection.</summary>
internal static class Program
{
    private const string LastChoiceFile = "last-choice.txt";

    [STAThread]
    private static int Main(string[] args)
    {
        ApplicationConfiguration.Initialize();

        var parsed = ProtocolParser.Parse(args.Length == 1 ? args[0] : null);
        if (!parsed.Ok)
        {
            MessageBox.Show(
                "This link was rejected and nothing was launched.\r\n\r\nReason: " + parsed.Reason,
                "Blueprint launcher", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }

        var records = new CellRecords(DataDirectory);
        switch (parsed.Kind)
        {
            case CommandKind.Sync:
                try
                {
                    records.Sync(parsed.Repo, parsed.Merged);
                    records.Cleanup();
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException)
                {
                    return 2; // silent by design
                }
                return 0;
            case CommandKind.Open:
                Application.Run(new OpenForm(parsed, records));
                return 0;
            case CommandKind.StartMany:
                Application.Run(new StartManyForm(parsed, records));
                return 0;
            default:
                Application.Run(new StartForm(parsed, records));
                return 0;
        }
    }

    internal static string LocalAppData => Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

    internal static string AppData => Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);

    internal static string DataDirectory => CellRecords.DefaultDirectory(LocalAppData);

    /// <summary>Full path of the browser exe, or null when it is not installed.</summary>
    internal static string? FindBrowser(string browser)
    {
        if (!BrowserCatalog.IsKnown(browser)) return null;
        var roots = new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
            LocalAppData,
        }.Where(r => !string.IsNullOrEmpty(r));
        return new BrowserExeLocator(roots).Find(browser);
    }

    /// <summary>Starts the browser with an argument list. Never a shell string.</summary>
    internal static void Run(LaunchCommand cmd)
    {
        var psi = new ProcessStartInfo(cmd.Exe) { UseShellExecute = false };
        foreach (var arg in cmd.Arguments) psi.ArgumentList.Add(arg);
        Process.Start(psi)?.Dispose();
    }

    internal static string DisplayBrowser(string browser)
        => browser.Length == 0 ? browser : char.ToUpperInvariant(browser[0]) + browser[1..];

    /// <summary>Last browser and profile folder picked, or null.</summary>
    internal static (string Browser, string Folder)? LoadLastChoice()
    {
        try
        {
            var lines = File.ReadAllLines(Path.Combine(DataDirectory, LastChoiceFile));
            if (lines.Length < 2) return null;
            if (!BrowserCatalog.IsKnown(lines[0])) return null;
            if (!BrowserProfiles.IsValidFolder(lines[1])) return null;
            return (lines[0], lines[1]);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    internal static void SaveLastChoice(string browser, string folder)
    {
        try
        {
            Directory.CreateDirectory(DataDirectory);
            File.WriteAllLines(Path.Combine(DataDirectory, LastChoiceFile), new[] { browser, folder });
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // Remembering the choice is a convenience only.
        }
    }
}
