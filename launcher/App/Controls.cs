using System.Drawing;
using System.Windows.Forms;

namespace BlueprintLauncher.App;

/// <summary>Owner-drawn controls for the dark launcher windows. System.Windows.Forms and System.Drawing only.</summary>
internal class RoundedPanel : Panel
{
    public int Radius { get; set; } = 12;
    public Color Fill { get; set; } = Theme.Bg;
    public Color Border { get; set; } = Theme.Line;

    public RoundedPanel()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                 | ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor, true);
        BackColor = Color.Transparent;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Theme.PaintRounded(e.Graphics, ClientRectangle, Radius, Fill, Border);
        base.OnPaint(e);
    }
}

/// <summary>Mono text box on the dark input color inside a rounded border.</summary>
internal sealed class MonoTextBox : RoundedPanel
{
    private readonly bool _multiline;

    public TextBox Inner { get; }

    public MonoTextBox(bool multiline)
    {
        _multiline = multiline;
        Radius = 10;
        Fill = Theme.Bg;
        Padding = multiline ? new Padding(14, 12, 10, 12) : new Padding(0);
        Inner = new TextBox
        {
            BorderStyle = BorderStyle.None,
            BackColor = Theme.Bg,
            ForeColor = Theme.Text,
            Font = Theme.Mono(13),
            Multiline = multiline,
            ScrollBars = multiline ? ScrollBars.Vertical : ScrollBars.None,
            Dock = multiline ? DockStyle.Fill : DockStyle.None,
        };
        Controls.Add(Inner);
        if (!multiline) Resize += (_, _) => CenterInner();
    }

    private void CenterInner()
    {
        Inner.Width = Math.Max(10, ClientSize.Width - 28);
        Inner.Left = 14;
        Inner.Top = Math.Max(0, (ClientSize.Height - Inner.Height) / 2);
    }

    public bool ReadOnly
    {
        get => Inner.ReadOnly;
        set
        {
            Inner.ReadOnly = value;
            Inner.BackColor = Theme.Bg; // ReadOnly would otherwise switch to the system color
            Inner.ForeColor = Theme.Text;
        }
    }

    public override string Text
    {
        get => Inner.Text;
        set => Inner.Text = value;
    }

    protected override void OnLayout(LayoutEventArgs e)
    {
        base.OnLayout(e);
        if (!_multiline) CenterInner();
    }
}

/// <summary>Rounded button base. Implements IButtonControl so it works as a form's Cancel or Accept button.</summary>
internal class RoundButton : Control, IButtonControl
{
    private bool _hover;
    private bool _down;

    public Color Fill { get; set; } = Theme.Raised;
    public Color Border { get; set; } = Theme.RaisedBorder;
    public Color TextColor { get; set; } = Theme.Text;
    public DialogResult DialogResult { get; set; }

    public RoundButton()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                 | ControlStyles.ResizeRedraw | ControlStyles.Selectable | ControlStyles.SupportsTransparentBackColor, true);
        BackColor = Color.Transparent;
        TabStop = true;
        Cursor = Cursors.Hand;
        Font = Theme.Ui(13.5f, FontStyle.Bold);
        Size = new Size(140, 44);
    }

    public void NotifyDefault(bool value) { }

    public void PerformClick()
    {
        if (Enabled && Visible) OnClick(EventArgs.Empty);
    }

    protected override void OnClick(EventArgs e)
    {
        base.OnClick(e);
        if (DialogResult != DialogResult.None && FindForm() is { } form) form.DialogResult = DialogResult;
    }

    protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { _hover = false; _down = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseDown(MouseEventArgs e) { _down = true; Invalidate(); base.OnMouseDown(e); }
    protected override void OnMouseUp(MouseEventArgs e) { _down = false; Invalidate(); base.OnMouseUp(e); }
    protected override void OnTextChanged(EventArgs e) { base.OnTextChanged(e); Invalidate(); }
    protected override void OnEnabledChanged(EventArgs e) { base.OnEnabledChanged(e); Invalidate(); }
    protected override void OnGotFocus(EventArgs e) { base.OnGotFocus(e); Invalidate(); }
    protected override void OnLostFocus(EventArgs e) { base.OnLostFocus(e); Invalidate(); }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (e.KeyCode is Keys.Space or Keys.Enter)
        {
            e.Handled = true;
            PerformClick();
        }
        base.OnKeyDown(e);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var fill = !Enabled ? Color.FromArgb(110, Fill)
            : _down ? ControlPaint.Dark(Fill, 0.08f)
            : _hover ? ControlPaint.Light(Fill, 0.12f)
            : Fill;
        var border = Focused && Enabled ? Theme.Text : Border;
        Theme.PaintRounded(e.Graphics, ClientRectangle, 10, fill, border);
        var color = Enabled ? TextColor : Color.FromArgb(150, TextColor);
        Theme.DrawText(e.Graphics, Text, Font, color, ClientRectangle,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
    }
}

internal sealed class AccentButton : RoundButton
{
    public AccentButton()
    {
        Fill = Theme.Accent;
        Border = Theme.Accent;
        TextColor = Theme.OnAccent;
    }
}

internal sealed class SecondaryButton : RoundButton
{
    public SecondaryButton()
    {
        Fill = Theme.Raised;
        Border = Theme.RaisedBorder;
        TextColor = Theme.Text;
        Font = Theme.Ui(13.5f, FontStyle.Regular);
    }
}
