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
    private readonly CellRecords _records;
    private readonly Panel _cards = new() { BackColor = Theme.Window, AutoScroll = true };
    private readonly AccentButton _confirm = new() { Text = "Open chat with this prompt" };
    private readonly SecondaryButton _cancel = new() { Text = "Cancel", DialogResult = DialogResult.Cancel };

    public StartForm(ParseResult req, CellRecords records)
    {
        _req = req;
        _records = records;

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
        Controls.Add(Labels.Create(req.Cell, idFont, Theme.Ready, Pad, 32, idWidth, 20));
        var pill = new PillLabel { Text = "Ready", Accent = Theme.Ready, Location = new Point(Pad + idWidth, 30) };
        Controls.Add(pill);

        Controls.Add(Labels.Create("Start " + req.Cell, Theme.Ui(22, FontStyle.Bold), Theme.Text, Pad, 64, ContentWidth, 32));
        Controls.Add(Labels.Create(req.Repo + " \u00B7 reserved for you for 10 minutes", Theme.Ui(13), Theme.Muted, Pad, 100, ContentWidth, 20));

        Controls.Add(new StepCaption { Number = 1, Text = "OPEN IN WHICH BROWSER PROFILE?", Location = new Point(Pad, 142) });
        _cards.Bounds = new Rectangle(Pad, 176, ContentWidth, 172);
        Controls.Add(_cards);

        Controls.Add(new StepCaption { Number = 2, Text = "PROMPT THAT WILL BE PRE-FILLED (YOU REVIEW IT)", Location = new Point(Pad, 364) });
        var promptBox = new MonoTextBox(true)
        {
            Bounds = new Rectangle(Pad, 398, ContentWidth, 100),
            ReadOnly = true,
            Text = PromptBuilder.BuildPrompt(req.Repo, req.Cell).Replace("\r\n", "\n").Replace("\n", "\r\n"),
        };
        Controls.Add(promptBox);

        Controls.Add(Labels.Create(
            "Works offline. Reads only profile names from Chrome. Sends nothing anywhere. You press Send in the chat.",
            Theme.Ui(12.5f), Theme.Done, Pad, 512, ContentWidth, 36));

        _confirm.Bounds = new Rectangle(Pad + ContentWidth - 260, 566, 260, 44);
        _cancel.Bounds = new Rectangle(_confirm.Left - 12 - 120, 566, 120, 44);
        Controls.Add(_cancel);
        Controls.Add(_confirm);

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
        var list = BrowserProfiles.List(Program.LocalAppData).Where(p => Program.FindBrowser(p.Browser) is not null).ToList();
        if (list.Count == 0)
        {
            _confirm.Enabled = false;
            _cards.Controls.Add(Labels.Create("No Chrome or Edge profile found on this PC.", Theme.Ui(13.5f), Theme.Muted, 0, 12, ContentWidth, 24));
            return;
        }

        var width = list.Count > 3 ? ContentWidth - 18 : ContentWidth;
        RadioCard? pick = null;
        var y = 0;
        foreach (var p in list)
        {
            var card = new RadioCard
            {
                Text = Program.DisplayBrowser(p.Browser) + " \u00B7 " + p.Name,
                Detail = "Profile folder: " + p.Folder,
                Tag = p,
                Bounds = new Rectangle(0, y, width, 52),
            };
            _cards.Controls.Add(card);
            y += 60;
            if (last is { } l && l.Browser == p.Browser && l.Folder == p.Folder) pick = card;
            pick ??= card;
        }
        if (pick is not null) pick.Selected = true;
    }

    private void Confirm()
    {
        var card = _cards.Controls.OfType<RadioCard>().FirstOrDefault(c => c.Selected);
        if (card?.Tag is not Profile p) return;
        var exe = Program.FindBrowser(p.Browser);
        if (exe is null)
        {
            MessageBox.Show("The browser was not found.", Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        try
        {
            var cmd = LaunchCommand.Build(exe, p.Folder, PromptBuilder.BuildUrl(_req.Repo, _req.Cell));
            _records.Upsert(_req.Repo, _req.Cell, p.Browser, p.Folder, p.Name);
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
