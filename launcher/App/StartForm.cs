using System.ComponentModel;
using System.Drawing;
using System.Windows.Forms;
using BlueprintLauncher.Core;

namespace BlueprintLauncher.App;

/// <summary>Confirm window for 'start'. Nothing runs until the person clicks the button; the prompt is never sent.</summary>
internal sealed class StartForm : Form
{
    private const int Pad = 32;
    private const int ContentWidth = 716;

    private readonly ParseResult _req;
    private readonly bool _steward;
    private readonly CellRecords _records;
    private readonly FlowLayoutPanel _cards = new() { BackColor = Theme.Window, AutoScroll = true, WrapContents = true, FlowDirection = FlowDirection.LeftToRight };
    private readonly ToolTip _tip = new();
    private readonly AccentButton _confirm = new() { Text = "Open chat with this prompt" };
    private readonly SecondaryButton _cancel = new() { Text = "Cancel", DialogResult = DialogResult.Cancel };

    public StartForm(ParseResult req, CellRecords records)
    {
        _req = req;
        _records = records;
        _steward = req.Kind == CommandKind.Steward;

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

        var idFont = Theme.Mono(13, FontStyle.Bold);
        var idWidth = TextRenderer.MeasureText(req.Cell, idFont, Size.Empty, TextFormatFlags.NoPadding).Width + 14;
        if (!_steward) Controls.Add(Labels.Create(req.Cell, idFont, Theme.Ready, Pad, 32, idWidth, 20));
        var pill = new PillLabel { Text = "Ready", Accent = Theme.Ready, Location = new Point(Pad + idWidth, 30) };
        if (!_steward) Controls.Add(pill);

        Controls.Add(Labels.Create(_steward ? "Start the Steward" : "Start " + req.Cell, Theme.Ui(22, FontStyle.Bold), Theme.Text, Pad, 64, ContentWidth, 32));
        Controls.Add(Labels.Create(_steward ? req.Repo : req.Repo + " \u00B7 reserved for you for 10 minutes", Theme.Ui(13), Theme.Muted, Pad, 100, ContentWidth, 20));

        Controls.Add(new StepCaption { Number = 1, Text = "OPEN IN WHICH BROWSER PROFILE?", Location = new Point(Pad, 142) });
        _cards.Bounds = new Rectangle(Pad, 176, ContentWidth, 172);
        Controls.Add(_cards);

        Controls.Add(new StepCaption { Number = 2, Text = "PROMPT THAT WILL BE PRE-FILLED (YOU REVIEW IT)", Location = new Point(Pad, 364) });
        var promptBox = new MonoTextBox(true)
        {
            Bounds = new Rectangle(Pad, 398, ContentWidth, 100),
            ReadOnly = true,
            Text = (_steward ? PromptBuilder.BuildStewardPrompt(req.Repo) : PromptBuilder.BuildPrompt(req.Repo, req.Cell)).Replace("\r\n", "\n").Replace("\n", "\r\n"),
        };
        Controls.Add(promptBox);

        Controls.Add(Labels.Create(
            _steward
                ? "Works offline. Reads only profile names and colors from your browsers. Sends nothing anywhere. You type the admin key yourself in the chat; it never passes through the launcher."
                : "Works offline. Reads only profile names and colors from your browsers. Sends nothing anywhere. You press Send in the chat.",
            Theme.Ui(12.5f), Theme.Done, Pad, 512, ContentWidth, 36));

        _confirm.Bounds = new Rectangle(Pad + ContentWidth - 260, 566, 260, 44);
        _cancel.Bounds = new Rectangle(_confirm.Left - 12 - 120, 566, 120, 44);
        Controls.Add(_cancel);
        Controls.Add(_confirm);

        if (_steward) _confirm.Text = "Open Steward chat";
        LoadProfiles();
        _confirm.Click += (_, _) => Confirm();
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        Theme.DarkTitleBar(Handle);
    }

    private void LoadProfiles()
    {
        var last = Program.LoadLastChoice();
        var list = BrowserProfiles.List(Program.LocalAppData, Program.AppData).Where(p => Program.FindBrowser(p.Browser) is not null).ToList();
        if (list.Count == 0)
        {
            _confirm.Enabled = false;
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
                BrowserIcon = BrowserIcons.Get(p.Browser),
                ThemeColor = ParseColor(p.ThemeColor),
                AvatarFile = p.AvatarFile?.ToString(),
                Margin = new Padding(0, 0, 8, 8),
            };
            _tip.SetToolTip(tile, Program.DisplayBrowser(p.Browser));
            _cards.Controls.Add(tile);
            first ??= tile;
            if (last is { } l && l.Browser == p.Browser && l.Folder == p.Folder) pick = tile;
        }
        (pick ?? first)!.Selected = true;
    }

    /// <summary>Profile theme color as a Color, or null (neutral grey). Accepts #RRGGBB text or a packed ARGB number.</summary>
    private static Color? ParseColor(object? value)
    {
        try
        {
            switch (value)
            {
                case null:
                    return null;
                case Color c:
                    return c;
                case string s when s.Length > 0:
                    return ColorTranslator.FromHtml(s.StartsWith('#') ? s : "#" + s);
                case int i:
                    return Color.FromArgb(255, Color.FromArgb(i));
                case uint u:
                    return Color.FromArgb(255, Color.FromArgb(unchecked((int)u)));
                case long l:
                    return Color.FromArgb(255, Color.FromArgb(unchecked((int)l)));
                default:
                    return null;
            }
        }
        catch (Exception e) when (e is ArgumentException or FormatException)
        {
            return null;
        }
    }

    private void Confirm()
    {
        var card = _cards.Controls.OfType<ProfileTile>().FirstOrDefault(c => c.Selected);
        if (card?.Tag is not Profile p) return;
        var exe = Program.FindBrowser(p.Browser);
        if (exe is null)
        {
            MessageBox.Show("The browser was not found.", Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        try
        {
            var url = _steward ? PromptBuilder.BuildStewardUrl(_req.Repo) : PromptBuilder.BuildUrl(_req.Repo, _req.Cell);
            var cmd = LaunchCommand.Build(exe, p.Browser, p.Folder, url);
            if (!_steward) _records.Upsert(_req.Repo, _req.Cell, p.Browser, p.Folder, p.Name);
            Program.SaveLastChoice(p.Browser, p.Folder);
            Program.Run(cmd);
            Close();
        }
        catch (Exception e) when (e is ArgumentException or IOException or UnauthorizedAccessException or Win32Exception)
        {
            MessageBox.Show("Could not start the browser: " + e.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
