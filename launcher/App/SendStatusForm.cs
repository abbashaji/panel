using System.Drawing;
using System.Text;
using System.Windows.Forms;
using BlueprintLauncher.Core;

namespace BlueprintLauncher.App;

/// <summary>
/// Small borderless always-on-top window that shows auto-send progress without ever taking focus.
/// Draws only; opens no network connection.
/// </summary>
internal sealed class SendStatusForm : Form
{
    private const int WsExNoActivate = 0x08000000;
    private const int WsExToolWindow = 0x00000080;
    private const int WmMouseActivate = 0x0021;
    private const int MaNoActivate = 3;
    private const int Margin = 16;
    // Assumed height of the parked browser box (WindowPlacer) that this window sits above.
    private const int ParkedBoxHeight = 320;

    private readonly Label _status;
    private readonly Label _countdown;
    private readonly Button _cancel;
    private readonly Button _close;
    private readonly System.Windows.Forms.Timer _autoClose = new();

    /// <summary>Raised when the teammate presses Cancel.</summary>
    public event Action? CancelRequested;

    /// <summary>True once ShowResult was called.</summary>
    public bool HasResult { get; private set; }

    public SendStatusForm(string label)
    {
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        TopMost = true;
        BackColor = Theme.Window;
        ClientSize = new Size(340, 132);
        var wa = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1280, 720);
        Location = new Point(wa.Right - Width - Margin, Math.Max(wa.Top, wa.Bottom - Margin - ParkedBoxHeight - Height - 8));

        var title = new Label
        {
            Text = "Blueprint auto-send",
            Font = Theme.Ui(13, FontStyle.Bold),
            ForeColor = Theme.Text,
            BackColor = Theme.Window,
            AutoSize = false,
            Bounds = new Rectangle(14, 10, 200, 20),
        };
        var cell = new Label
        {
            Text = label,
            Font = Theme.Mono(12),
            ForeColor = Theme.Accent,
            BackColor = Theme.Window,
            AutoSize = false,
            TextAlign = ContentAlignment.TopRight,
            Bounds = new Rectangle(190, 11, 136, 20),
        };
        _status = new Label
        {
            Text = "Starting...",
            Font = Theme.Ui(12),
            ForeColor = Theme.Text2,
            BackColor = Theme.Window,
            AutoSize = false,
            Bounds = new Rectangle(14, 38, 312, 40),
        };
        _countdown = new Label
        {
            Text = string.Empty,
            Font = Theme.Ui(12, FontStyle.Bold),
            ForeColor = Theme.Ready,
            BackColor = Theme.Window,
            AutoSize = false,
            Bounds = new Rectangle(14, 82, 180, 20),
        };
        _cancel = MakeButton("Cancel", new Rectangle(246, 94, 80, 28));
        _cancel.Click += (_, _) =>
        {
            _cancel.Enabled = false;
            CancelRequested?.Invoke();
        };
        _close = MakeButton("Close", new Rectangle(246, 94, 80, 28));
        _close.Visible = false;
        _close.Click += (_, _) => Close();
        Controls.AddRange(new Control[] { title, cell, _status, _countdown, _cancel, _close });

        _autoClose.Tick += (_, _) =>
        {
            _autoClose.Stop();
            Close();
        };
        Disposed += (_, _) => _autoClose.Dispose();
    }

    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= WsExNoActivate | WsExToolWindow;
            return cp;
        }
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WmMouseActivate)
        {
            // Clicks reach the buttons but never activate this window.
            m.Result = (IntPtr)MaNoActivate;
            return;
        }
        base.WndProc(ref m);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        using var pen = new Pen(Theme.RaisedBorder);
        e.Graphics.DrawRectangle(pen, 0, 0, Width - 1, Height - 1);
    }

    /// <summary>Shows the current phase. Safe to call from any thread.</summary>
    public void Update(AutoSendProgress p)
    {
        OnUi(() =>
        {
            if (HasResult || IsDisposed) return;
            _status.Text = Humanize(p.Phase.ToString());
            _countdown.Text = p.SecondsLeft > 0 ? "Sending in " + p.SecondsLeft + " s" : string.Empty;
        });
    }

    /// <summary>Shows the final result. Sent closes by itself after 4 seconds; anything else stays until closed or 60 seconds.</summary>
    public void ShowResult(AutoSendResult r)
    {
        OnUi(() =>
        {
            if (IsDisposed) return;
            HasResult = true;
            _countdown.Text = string.Empty;
            _cancel.Visible = false;
            var sent = r.Outcome == AutoSendOutcome.Sent;
            _status.ForeColor = sent ? Theme.Done : Theme.Text;
            _status.Text = r.PlainText();
            _close.Visible = !sent;
            _autoClose.Stop();
            _autoClose.Interval = sent ? 4000 : 60000;
            _autoClose.Start();
        });
    }

    private void OnUi(Action action)
    {
        if (IsDisposed) return;
        if (!InvokeRequired)
        {
            action();
            return;
        }
        try
        {
            BeginInvoke(action);
        }
        catch (Exception e) when (e is InvalidOperationException or ObjectDisposedException)
        {
            // The window is already gone.
        }
    }

    private static Button MakeButton(string text, Rectangle bounds)
    {
        var b = new Button
        {
            Text = text,
            Bounds = bounds,
            FlatStyle = FlatStyle.Flat,
            BackColor = Theme.Raised,
            ForeColor = Theme.Text,
            Font = Theme.Ui(12),
            TabStop = false,
            UseVisualStyleBackColor = false,
        };
        b.FlatAppearance.BorderColor = Theme.RaisedBorder;
        return b;
    }

    private static string Humanize(string name)
    {
        var sb = new StringBuilder();
        for (var i = 0; i < name.Length; i++)
        {
            var c = name[i];
            if (i > 0 && char.IsUpper(c)) sb.Append(' ').Append(char.ToLowerInvariant(c));
            else sb.Append(i == 0 ? char.ToUpperInvariant(c) : c);
        }
        return sb.ToString();
    }
}
