using System.ComponentModel;
using System.Drawing;
using System.Globalization;
using System.Windows.Forms;
using BlueprintLauncher.Core;

namespace BlueprintLauncher.App;

/// <summary>'My cell' window: reopens claude.ai in the profile saved for this cell. Chat link is optional.</summary>
internal sealed class OpenForm : Form
{
    private const string HomeUrl = "https://claude.ai/";
    private const int Pad = 32;
    private const int ContentWidth = 716;

    private readonly ParseResult _req;
    private readonly CellRecords _records;
    private readonly CellRecord? _record;
    private readonly MonoTextBox _chat = new(false);
    private readonly SecondaryButton _save = new() { Text = "Save" };
    private string? _savedUrl;

    public OpenForm(ParseResult req, CellRecords records)
    {
        _req = req;
        _records = records;
        _record = records.Load().TryGetValue(CellRecords.Key(req.Repo, req.Cell), out var r) ? r : null;
        _savedUrl = _record?.ChatUrl;

        Text = "Blueprint Launcher \u00B7 local window on your PC";
        BackColor = Theme.Window;
        ForeColor = Theme.Text;
        DoubleBuffered = true;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(780, 356);

        var idFont = Theme.Mono(13, FontStyle.Bold);
        var idWidth = TextRenderer.MeasureText(req.Cell, idFont, Size.Empty, TextFormatFlags.NoPadding).Width + 14;
        Controls.Add(Labels.Create(req.Cell, idFont, Theme.Running, Pad, 32, idWidth, 20));

        if (_record is null)
        {
            ClientSize = new Size(780, 250);
            Controls.Add(Labels.Create("No saved record", Theme.Ui(22, FontStyle.Bold), Theme.Text, Pad, 64, ContentWidth, 32));
            Controls.Add(Labels.Create(
                "There is no saved record for " + req.Repo + " " + req.Cell + " on this computer. Start the cell from the panel first.",
                Theme.Ui(13), Theme.Muted, Pad, 104, ContentWidth, 40));
            var close = new SecondaryButton { Text = "Close", DialogResult = DialogResult.Cancel, Bounds = new Rectangle(Pad + ContentWidth - 120, 176, 120, 44) };
            CancelButton = close;
            Controls.Add(close);
            return;
        }

        var where = Program.DisplayBrowser(_record.Browser) + " \u00B7 " + _record.ProfileName;

        Controls.Add(new PillLabel { Text = "Running \u00B7 yours", Accent = Theme.Running, Location = new Point(Pad + idWidth, 30) });
        Controls.Add(Labels.Create(req.Repo, Theme.Ui(22, FontStyle.Bold), Theme.Text, Pad, 64, ContentWidth, 32));
        Controls.Add(Labels.Create("Started " + Ago(_record.StartedAt) + " in " + where, Theme.Ui(13), Theme.Muted, Pad, 100, ContentWidth, 20));

        var open = new AccentButton { Text = "Open claude.ai in " + where, Bounds = new Rectangle(Pad, 140, ContentWidth, 48) };
        open.Click += (_, _) => OpenBrowser();
        Controls.Add(open);

        Controls.Add(Labels.Create("CHAT LINK (OPTIONAL, PASTE ONCE TO JUMP STRAIGHT TO THE CHAT)", Theme.Ui(11.5f, FontStyle.Bold), Theme.Muted2, Pad, 214, ContentWidth, 20));
        _chat.Bounds = new Rectangle(Pad, 240, ContentWidth - 116, 44);
        _chat.Inner.PlaceholderText = "https://claude.ai/chat/...";
        _chat.Text = _savedUrl ?? "";
        _chat.Inner.TextChanged += (_, _) => _save.Text = "Save";
        Controls.Add(_chat);

        _save.Bounds = new Rectangle(Pad + ContentWidth - 104, 240, 104, 44);
        _save.Click += (_, _) => SaveLink();
        Controls.Add(_save);

        Controls.Add(Labels.Create(
            "Saved only on this PC. Deleted when " + req.Cell + " turns green, or after 14 days.",
            Theme.Ui(12.5f), Theme.Done, Pad, 306, ContentWidth, 20));
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        Theme.DarkTitleBar(Handle);
    }

    protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
    {
        if (keyData == Keys.Escape)
        {
            Close();
            return true;
        }
        return base.ProcessCmdKey(ref msg, keyData);
    }

    private static string Ago(object? started)
    {
        DateTimeOffset t;
        switch (started)
        {
            case DateTimeOffset o:
                t = o;
                break;
            case DateTime d:
                t = new DateTimeOffset(d.Kind == DateTimeKind.Unspecified ? DateTime.SpecifyKind(d, DateTimeKind.Utc) : d.ToUniversalTime());
                break;
            default:
                if (!DateTimeOffset.TryParse(started?.ToString(), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out t))
                    return "earlier";
                break;
        }
        var minutes = (int)Math.Max(0, (DateTimeOffset.UtcNow - t).TotalMinutes);
        if (minutes < 1) return "just now";
        if (minutes < 60) return minutes == 1 ? "1 minute ago" : minutes + " minutes ago";
        var hours = minutes / 60;
        if (hours < 24) return hours == 1 ? "1 hour ago" : hours + " hours ago";
        var days = hours / 24;
        return days == 1 ? "1 day ago" : days + " days ago";
    }

    private void SaveLink()
    {
        var link = _chat.Text.Trim();
        if (link.Length == 0 || !CellRecords.IsValidChatUrl(link))
        {
            MessageBox.Show("That is not a claude.ai chat link.", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        try
        {
            if (link != _savedUrl) _records.SetChatUrl(_req.Repo, _req.Cell, link);
            _savedUrl = link;
            _save.Text = "Saved";
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            MessageBox.Show("Could not save the link: " + e.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void OpenBrowser()
    {
        if (_record is null) return;
        var link = _chat.Text.Trim();
        var url = HomeUrl;
        if (link.Length > 0)
        {
            if (!CellRecords.IsValidChatUrl(link))
            {
                MessageBox.Show("That is not a claude.ai chat link.", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            url = link;
        }
        else if (_savedUrl is not null)
        {
            url = _savedUrl;
        }

        var exe = Program.FindBrowser(_record.Browser);
        if (exe is null || !BrowserProfiles.IsValidFolder(_record.ProfileFolder))
        {
            MessageBox.Show("The browser or profile was not found.", Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        try
        {
            if (link.Length > 0 && link != _savedUrl)
            {
                _records.SetChatUrl(_req.Repo, _req.Cell, link);
                _savedUrl = link;
            }
            // LaunchCommand.Build only accepts the pre-filled prompt URL, so build the argument list directly.
            Program.Run(new LaunchCommand(exe, new[] { "--profile-directory=" + _record.ProfileFolder, url }));
            Close();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or Win32Exception)
        {
            MessageBox.Show("Could not start the browser: " + e.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
