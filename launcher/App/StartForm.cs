using System.ComponentModel;
using System.Drawing;
using System.Windows.Forms;
using BlueprintLauncher.Core;

namespace BlueprintLauncher.App;

/// <summary>Confirm window for 'start'. Nothing runs until the person clicks the button; the prompt is never sent.</summary>
internal sealed class StartForm : Form
{
    private sealed class Item
    {
        public Item(Profile profile) { Profile = profile; }
        public Profile Profile { get; }
        public override string ToString()
            => Program.DisplayBrowser(Profile.Browser) + " - " + Profile.Name + " (" + Profile.Folder + ")";
    }

    private readonly ParseResult _req;
    private readonly CellRecords _records;
    private readonly ComboBox _picker = new() { DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Fill };
    private readonly Button _confirm = new() { Text = "Open claude.ai with this prompt", AutoSize = true };
    private readonly Button _cancel = new() { Text = "Cancel", AutoSize = true, DialogResult = DialogResult.Cancel };

    public StartForm(ParseResult req, CellRecords records)
    {
        _req = req;
        _records = records;

        Text = "Blueprint: start cell " + req.Cell;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(600, 420);
        CancelButton = _cancel;

        var prompt = PromptBuilder.BuildPrompt(req.Repo, req.Cell).Replace("\n", "\r\n");
        var promptBox = new TextBox
        {
            Multiline = true, ReadOnly = true, Dock = DockStyle.Fill, Text = prompt, ScrollBars = ScrollBars.Vertical,
        };

        var grid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 7, Padding = new Padding(12) };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        for (var i = 0; i < 7; i++) grid.RowStyles.Add(new RowStyle(i == 5 ? SizeType.Percent : SizeType.AutoSize, i == 5 ? 100 : 0));

        AddRow(grid, 0, "Repo", Value(req.Repo));
        AddRow(grid, 1, "Cell", Value(req.Cell));
        AddRow(grid, 2, "Who", Value(req.Who));
        AddRow(grid, 3, "Browser profile", _picker);
        var promptLabel = new Label
        {
            Text = "This exact prompt will be pre-filled. It is not sent; you press Enter yourself.",
            AutoSize = true, UseMnemonic = false, Margin = new Padding(0, 8, 0, 4),
        };
        grid.Controls.Add(promptLabel, 0, 4);
        grid.SetColumnSpan(promptLabel, 2);
        grid.Controls.Add(promptBox, 0, 5);
        grid.SetColumnSpan(promptBox, 2);

        var buttons = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, AutoSize = true };
        buttons.Controls.Add(_cancel);
        buttons.Controls.Add(_confirm);
        grid.Controls.Add(buttons, 0, 6);
        grid.SetColumnSpan(buttons, 2);
        Controls.Add(grid);

        LoadProfiles();
        _confirm.Click += (_, _) => Confirm();
    }

    private static Label Value(string text)
        => new() { Text = text, AutoSize = true, UseMnemonic = false, Anchor = AnchorStyles.Left };

    private static void AddRow(TableLayoutPanel grid, int row, string label, Control control)
    {
        grid.Controls.Add(new Label { Text = label, AutoSize = true, UseMnemonic = false, Anchor = AnchorStyles.Left, Margin = new Padding(0, 6, 12, 6) }, 0, row);
        grid.Controls.Add(control, 1, row);
    }

    private void LoadProfiles()
    {
        var last = Program.LoadLastChoice();
        var selected = -1;
        foreach (var p in BrowserProfiles.List(Program.LocalAppData))
        {
            if (Program.FindBrowser(p.Browser) is null) continue;
            var index = _picker.Items.Add(new Item(p));
            if (last is { } l && l.Browser == p.Browser && l.Folder == p.Folder) selected = index;
        }
        if (_picker.Items.Count == 0)
        {
            _confirm.Enabled = false;
            _picker.Items.Add("No Chrome or Edge profile found");
            _picker.SelectedIndex = 0;
            return;
        }
        _picker.SelectedIndex = selected >= 0 ? selected : 0;
    }

    private void Confirm()
    {
        if (_picker.SelectedItem is not Item item) return;
        var p = item.Profile;
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
