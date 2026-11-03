using System.ComponentModel;
using System.Drawing;
using System.Windows.Forms;
using BlueprintLauncher.Core;

namespace BlueprintLauncher.App;

/// <summary>'My cell' window: reopens claude.ai in the profile saved for this cell. Chat link is optional.</summary>
internal sealed class OpenForm : Form
{
    private const string HomeUrl = "https://claude.ai/";

    private readonly ParseResult _req;
    private readonly CellRecords _records;
    private readonly CellRecord? _record;
    private readonly TextBox _chat = new() { Dock = DockStyle.Top };

    public OpenForm(ParseResult req, CellRecords records)
    {
        _req = req;
        _records = records;
        _record = records.Load().TryGetValue(CellRecords.Key(req.Repo, req.Cell), out var r) ? r : null;

        Text = "Blueprint: my cell " + req.Cell;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(520, 230);

        var close = new Button { Text = "Close", AutoSize = true, DialogResult = DialogResult.Cancel };
        CancelButton = close;
        var flow = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, Padding = new Padding(12), WrapContents = false };

        if (_record is null)
        {
            flow.Controls.Add(Text_("No saved record for " + req.Repo + " " + req.Cell + " on this computer.\r\nStart the cell from the panel first."));
            flow.Controls.Add(close);
            Controls.Add(flow);
            return;
        }

        flow.Controls.Add(Text_(req.Repo + "  " + req.Cell));
        flow.Controls.Add(Text_("Profile: " + Program.DisplayBrowser(_record.Browser) + " - " + _record.ProfileName + " (" + _record.ProfileFolder + ")"));
        flow.Controls.Add(Text_("Chat link (optional, https://claude.ai/chat/<id>):"));
        _chat.Width = 480;
        _chat.Text = _record.ChatUrl ?? "";
        flow.Controls.Add(_chat);

        var open = new Button { Text = "Open claude.ai", AutoSize = true };
        open.Click += (_, _) => OpenBrowser();
        var buttons = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight };
        buttons.Controls.Add(open);
        buttons.Controls.Add(close);
        flow.Controls.Add(buttons);
        Controls.Add(flow);
    }

    private static Label Text_(string text)
        => new() { Text = text, AutoSize = true, UseMnemonic = false, Margin = new Padding(0, 4, 0, 4) };

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
        else if (_record.ChatUrl is not null)
        {
            url = _record.ChatUrl;
        }

        var exe = Program.FindBrowser(_record.Browser);
        if (exe is null || !BrowserProfiles.IsValidFolder(_record.ProfileFolder))
        {
            MessageBox.Show("The browser or profile was not found.", Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        try
        {
            if (link.Length > 0 && link != _record.ChatUrl) _records.SetChatUrl(_req.Repo, _req.Cell, link);
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
