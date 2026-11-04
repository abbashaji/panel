using System.ComponentModel;
using System.Drawing;
using System.Windows.Forms;
using BlueprintLauncher.Core;

namespace BlueprintLauncher.App;

/// <summary>Confirm window for 'start many'. Nothing runs until the person clicks the button; no prompt is sent.</summary>
internal sealed class StartManyForm : Form
{
    private const int Pad = 32;
    private const int ContentWidth = 716;
    private const int LaunchDelayMs = 1500;

    private readonly ParseResult _req;
    private readonly CellRecords _records;
    private readonly IReadOnlyList<string> _cells;
    private readonly FlowLayoutPanel _cards = new() { BackColor = Theme.Window, AutoScroll = true, WrapContents = true, FlowDirection = FlowDirection.LeftToRight };
    private readonly ToolTip _tip = new();
    private readonly Label _counter;
    private readonly Label _skipped;
    private readonly AccentButton _confirm = new();
    private readonly SecondaryButton _cancel = new() { Text = "Cancel", DialogResult = DialogResult.Cancel };

    public StartManyForm(ParseResult req, CellRecords records)
    {
        _req = req;
        _records = records;
        _cells = req.Cells.ToList();

        Text = "Blueprint Launcher \u00B7 local window on your PC";
        BackColor = Theme.Window;
        ForeColor = Theme.Text;
        DoubleBuffered = true;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(780, 626);
        CancelButton = _cancel;

        Controls.Add(Labels.Create("Start " + _cells.Count + " cells", Theme.Ui(22, FontStyle.Bold), Theme.Text, Pad, 32, ContentWidth, 32));
        Controls.Add(Labels.Create(req.Repo + " \u00B7 reserved for you for 10 minutes", Theme.Ui(13), Theme.Muted, Pad, 68, ContentWidth, 20));

        var chips = new FlowLayoutPanel { BackColor = Theme.Window, AutoScroll = true, WrapContents = true, Bounds = new Rectangle(Pad, 98, ContentWidth, 56) };
        foreach (var id in _cells)
            chips.Controls.Add(new PillLabel { Text = id, Accent = Theme.Ready, Margin = new Padding(0, 0, 8, 6) });
        Controls.Add(chips);

        Controls.Add(new StepCaption { Number = 1, Text = "CHOOSE BROWSER PROFILES (ONE CELL EACH, IN ORDER)", Location = new Point(Pad, 168) });
        _cards.Bounds = new Rectangle(Pad, 202, ContentWidth, 172);
        Controls.Add(_cards);

        _counter = Labels.Create("", Theme.Ui(13.5f, FontStyle.Bold), Theme.Text, Pad, 386, ContentWidth, 22);
        _skipped = Labels.Create("", Theme.Ui(12.5f), Theme.Muted, Pad, 412, ContentWidth, 40);
        Controls.Add(_counter);
        Controls.Add(_skipped);
        Controls.Add(Labels.Create(
            "Works offline. Reads only profile names and colors from your browsers. Sends nothing anywhere. You press Send in each chat.",
            Theme.Ui(12.5f), Theme.Done, Pad, 480, ContentWidth, 36));

        _confirm.Bounds = new Rectangle(Pad + ContentWidth - 260, 566, 260, 44);
        _cancel.Bounds = new Rectangle(_confirm.Left - 12 - 120, 566, 120, 44);
        Controls.Add(_cancel);
        Controls.Add(_confirm);

        LoadProfiles();
        UpdateState();
        _confirm.Click += (_, _) => Confirm();
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        Theme.DarkTitleBar(Handle);
    }

    /// <summary>Cell i goes to item i. Stops at the shorter list.</summary>
    internal static IReadOnlyList<(string Cell, T Item)> Pair<T>(IReadOnlyList<string> cells, IReadOnlyList<T> chosen)
    {
        var n = Math.Min(cells.Count, chosen.Count);
        var list = new List<(string, T)>(n);
        for (var i = 0; i < n; i++) list.Add((cells[i], chosen[i]));
        return list;
    }

    /// <summary>The cells that get no profile when k profiles are chosen.</summary>
    internal static IReadOnlyList<string> Unstarted(IReadOnlyList<string> cells, int k)
        => cells.Skip(Math.Max(0, k)).ToList();

    internal static string UnstartedText(IReadOnlyList<string> rest)
        => rest.Count == 0 ? "" : string.Join(", ", rest) + (rest.Count == 1 ? " stays" : " stay") + " reserved for 10 minutes";

    private List<ProfileTile> Chosen()
        => _cards.Controls.OfType<ProfileTile>().Where(t => t.Selected).OrderBy(t => t.Top).ThenBy(t => t.Left).ToList();

    private void UpdateState()
    {
        var k = Chosen().Count;
        _counter.Text = k + " of " + _cells.Count + " selected";
        _skipped.Text = k >= 1 && k < _cells.Count ? UnstartedText(Unstarted(_cells, k)) : "";
        _confirm.Text = "Open " + k + (k == 1 ? " chat" : " chats");
        _confirm.Enabled = k >= 1 && k <= _cells.Count;
    }

    private void LoadProfiles()
    {
        var last = Program.LoadLastChoice();
        var list = BrowserProfiles.List(Program.LocalAppData, Program.AppData).Where(p => Program.FindBrowser(p.Browser) is not null).ToList();
        if (list.Count == 0)
        {
            _cards.Controls.Add(Labels.Create("No browser profile found on this PC.", Theme.Ui(13.5f), Theme.Muted, 0, 12, ContentWidth, 24));
            return;
        }

        ProfileTile? pick = null;
        ProfileTile? first = null;
        foreach (var p in list)
        {
            var tile = new ProfileTile
            {
                Text = p.Name,
                Tag = p,
                Multi = true,
                BrowserIcon = BrowserIcons.Get(p.Browser),
                ThemeColor = ParseColor(p.ThemeColor),
                AvatarFile = p.AvatarFile?.ToString(),
                Margin = new Padding(0, 0, 8, 8),
            };
            tile.SelectedChanged += (_, _) => UpdateState();
            _tip.SetToolTip(tile, Program.DisplayBrowser(p.Browser));
            _cards.Controls.Add(tile);
            first ??= tile;
            if (last is { } l && l.Browser == p.Browser && l.Folder == p.Folder) pick = tile;
        }
        (pick ?? first)!.Selected = true;
    }

    private static Color? ParseColor(object? value)
    {
        try
        {
            return value switch
            {
                Color c => c,
                string s when s.Length > 0 => ColorTranslator.FromHtml(s.StartsWith('#') ? s : "#" + s),
                int i => Color.FromArgb(255, Color.FromArgb(i)),
                uint u => Color.FromArgb(255, Color.FromArgb(unchecked((int)u))),
                long l => Color.FromArgb(255, Color.FromArgb(unchecked((int)l))),
                _ => null,
            };
        }
        catch (Exception e) when (e is ArgumentException or FormatException)
        {
            return null;
        }
    }

    private async void Confirm()
    {
        var profiles = Chosen().Select(t => t.Tag).OfType<Profile>().ToList();
        if (profiles.Count == 0) return;
        var pairs = Pair(_cells, profiles);
        _confirm.Enabled = false;
        _cancel.Enabled = false;
        var errors = new List<string>();
        for (var i = 0; i < pairs.Count; i++)
        {
            if (i > 0) await Task.Delay(LaunchDelayMs);
            var (cell, p) = pairs[i];
            try
            {
                var exe = Program.FindBrowser(p.Browser);
                if (exe is null)
                {
                    errors.Add(cell + ": the browser was not found.");
                    continue;
                }
                var cmd = LaunchCommand.Build(exe, p.Browser, p.Folder, PromptBuilder.BuildUrl(_req.Repo, cell));
                _records.Upsert(_req.Repo, cell, p.Browser, p.Folder, p.Name);
                Program.Run(cmd);
            }
            catch (Exception e) when (e is ArgumentException or IOException or UnauthorizedAccessException or Win32Exception)
            {
                errors.Add(cell + ": " + e.Message);
            }
        }
        Program.SaveLastChoice(profiles[0].Browser, profiles[0].Folder);
        if (errors.Count > 0)
            MessageBox.Show("Some chats could not be started:\r\n\r\n" + string.Join("\r\n", errors), Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        Close();
    }
}
