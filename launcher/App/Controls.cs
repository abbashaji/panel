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

/// <summary>Small rounded status label such as 'Ready' or 'Running · yours'.</summary>
internal sealed class PillLabel : Control
{
    private Color _accent = Theme.Accent;

    public Color Accent
    {
        get => _accent;
        set { _accent = value; Invalidate(); }
    }

    public PillLabel()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                 | ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor, true);
        BackColor = Color.Transparent;
        TabStop = false;
        Font = Theme.Ui(11.5f, FontStyle.Bold);
    }

    private void Fit()
    {
        var size = TextRenderer.MeasureText(Text, Font, Size.Empty, TextFormatFlags.NoPadding | TextFormatFlags.SingleLine);
        Size = new Size(size.Width + 24, 24);
    }

    protected override void OnTextChanged(EventArgs e) { base.OnTextChanged(e); Fit(); Invalidate(); }
    protected override void OnFontChanged(EventArgs e) { base.OnFontChanged(e); Fit(); Invalidate(); }

    protected override void OnPaint(PaintEventArgs e)
    {
        Theme.PaintRounded(e.Graphics, ClientRectangle, Height / 2, Color.FromArgb(40, _accent), Color.FromArgb(150, _accent));
        Theme.DrawText(e.Graphics, Text, Font, _accent, ClientRectangle,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
    }
}

/// <summary>Numbered circle followed by an uppercase step caption.</summary>
internal sealed class StepCaption : Control
{
    public int Number { get; set; } = 1;

    public StepCaption()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                 | ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor, true);
        BackColor = Color.Transparent;
        TabStop = false;
        Font = Theme.Ui(11.5f, FontStyle.Bold);
        Size = new Size(716, 22);
    }

    protected override void OnTextChanged(EventArgs e) { base.OnTextChanged(e); Invalidate(); }

    protected override void OnPaint(PaintEventArgs e)
    {
        var circle = new Rectangle(0, 0, 22, 22);
        Theme.PaintRounded(e.Graphics, circle, 11, Color.FromArgb(40, Theme.Accent), Color.FromArgb(150, Theme.Accent));
        Theme.DrawText(e.Graphics, Number.ToString(), Font, Theme.Accent, circle,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
        Theme.DrawText(e.Graphics, Text, Font, Theme.Muted2, new Rectangle(32, 0, Width - 32, Height),
            TextFormatFlags.VerticalCenter);
    }
}

/// <summary>Radio choice drawn as a card. Selected card gets the accent border. Siblings are deselected automatically.</summary>
internal sealed class RadioCard : Control
{
    private bool _selected;

    public string Detail { get; set; } = "";

    public event EventHandler? SelectedChanged;

    public bool Selected
    {
        get => _selected;
        set
        {
            if (_selected == value) return;
            _selected = value;
            Invalidate();
            if (value && Parent is not null)
            {
                foreach (var other in Parent.Controls.OfType<RadioCard>())
                    if (!ReferenceEquals(other, this)) other.Selected = false;
            }
            SelectedChanged?.Invoke(this, EventArgs.Empty);
        }
    }

    public RadioCard()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                 | ControlStyles.ResizeRedraw | ControlStyles.Selectable | ControlStyles.SupportsTransparentBackColor, true);
        BackColor = Color.Transparent;
        TabStop = true;
        Cursor = Cursors.Hand;
        Font = Theme.Ui(14, FontStyle.Bold);
        Size = new Size(716, 52);
    }

    protected override void OnClick(EventArgs e)
    {
        Focus();
        Selected = true;
        base.OnClick(e);
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (e.KeyCode is Keys.Space or Keys.Enter)
        {
            e.Handled = true;
            Selected = true;
        }
        base.OnKeyDown(e);
    }

    protected override void OnGotFocus(EventArgs e) { base.OnGotFocus(e); Invalidate(); }
    protected override void OnLostFocus(EventArgs e) { base.OnLostFocus(e); Invalidate(); }
    protected override void OnTextChanged(EventArgs e) { base.OnTextChanged(e); Invalidate(); }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        var border = _selected ? Theme.Accent : Focused ? Theme.Muted2 : Theme.Line;
        Theme.PaintRounded(g, ClientRectangle, 10, _selected ? Theme.SelectedCard : Theme.Bg, border);
        var cy = Height / 2;
        g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        using (var pen = new Pen(_selected ? Theme.Accent : Theme.Muted3, 1.6f))
            g.DrawEllipse(pen, 16, cy - 9, 18, 18);
        if (_selected)
        {
            using var dot = new SolidBrush(Theme.Accent);
            g.FillEllipse(dot, 21, cy - 4, 8, 8);
        }
        const int detailWidth = 230;
        Theme.DrawText(g, Text, Font, Theme.Text, new Rectangle(46, 0, Math.Max(10, Width - 46 - detailWidth - 20), Height),
            TextFormatFlags.VerticalCenter);
        Theme.DrawText(g, Detail, Theme.Mono(12), Theme.Muted, new Rectangle(Width - detailWidth - 16, 0, detailWidth, Height),
            TextFormatFlags.VerticalCenter | TextFormatFlags.Right);
    }
}

/// <summary>Plain transparent labels for the launcher windows.</summary>
internal static class Labels
{
    public static Label Create(string text, Font font, Color color, int x, int y, int width, int height)
        => new()
        {
            Text = text, Font = font, ForeColor = color, BackColor = Color.Transparent,
            AutoSize = false, UseMnemonic = false, Bounds = new Rectangle(x, y, width, height),
            AutoEllipsis = true,
        };
}

/// <summary>Small icon tile for one browser profile: browser icon, profile circle (theme color or avatar), name.</summary>
internal sealed class ProfileTile : Control
{
    private bool _selected;
    private Bitmap? _avatar;

    public Image? BrowserIcon { get; set; }
    public Color? ThemeColor { get; set; }

    public event EventHandler? SelectedChanged;

    public bool Selected
    {
        get => _selected;
        set
        {
            if (_selected == value) return;
            _selected = value;
            Invalidate();
            if (value && Parent is not null)
            {
                foreach (var other in Parent.Controls.OfType<ProfileTile>())
                    if (!ReferenceEquals(other, this)) other.Selected = false;
            }
            SelectedChanged?.Invoke(this, EventArgs.Empty);
        }
    }

    /// <summary>Loads a copy of the picture so the file is never locked. Silently ignored when unreadable.</summary>
    public string? AvatarFile
    {
        set
        {
            _avatar?.Dispose();
            _avatar = null;
            if (string.IsNullOrEmpty(value) || !File.Exists(value)) return;
            try
            {
                using var ms = new MemoryStream(File.ReadAllBytes(value));
                using var img = Image.FromStream(ms);
                _avatar = new Bitmap(img);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException or OutOfMemoryException)
            {
                _avatar = null;
            }
            Invalidate();
        }
    }

    public ProfileTile()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                 | ControlStyles.ResizeRedraw | ControlStyles.Selectable | ControlStyles.SupportsTransparentBackColor, true);
        BackColor = Color.Transparent;
        TabStop = true;
        Cursor = Cursors.Hand;
        Font = Theme.Ui(9f);
        Size = new Size(72, 84);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) _avatar?.Dispose();
        base.Dispose(disposing);
    }

    protected override void OnClick(EventArgs e)
    {
        Focus();
        Selected = true;
        base.OnClick(e);
    }

    protected override bool IsInputKey(Keys keyData)
        => keyData is Keys.Left or Keys.Right or Keys.Up or Keys.Down || base.IsInputKey(keyData);

    protected override void OnKeyDown(KeyEventArgs e)
    {
        switch (e.KeyCode)
        {
            case Keys.Space:
            case Keys.Enter:
                e.Handled = true;
                Selected = true;
                break;
            case Keys.Left or Keys.Right or Keys.Up or Keys.Down:
                e.Handled = true;
                MoveSelection(e.KeyCode);
                break;
        }
        base.OnKeyDown(e);
    }

    private void MoveSelection(Keys key)
    {
        if (Parent is null) return;
        var tiles = Parent.Controls.OfType<ProfileTile>().OrderBy(t => t.Top).ThenBy(t => t.Left).ToList();
        var index = tiles.IndexOf(this);
        ProfileTile? target = null;
        if (key == Keys.Left) target = index > 0 ? tiles[index - 1] : null;
        else if (key == Keys.Right) target = index < tiles.Count - 1 ? tiles[index + 1] : null;
        else if (key == Keys.Down)
            target = tiles.Where(t => t.Top > Top).OrderBy(t => t.Top).ThenBy(t => Math.Abs(t.Left - Left)).FirstOrDefault();
        else
            target = tiles.Where(t => t.Top < Top).OrderByDescending(t => t.Top).ThenBy(t => Math.Abs(t.Left - Left)).FirstOrDefault();
        if (target is null) return;
        target.Focus();
        target.Selected = true;
    }

    protected override void OnGotFocus(EventArgs e) { base.OnGotFocus(e); Invalidate(); }
    protected override void OnLostFocus(EventArgs e) { base.OnLostFocus(e); Invalidate(); }
    protected override void OnTextChanged(EventArgs e) { base.OnTextChanged(e); Invalidate(); }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        var border = _selected ? Theme.Accent : Focused ? Theme.Muted2 : Theme.Line;
        Theme.PaintRounded(g, ClientRectangle, 10, _selected ? Theme.SelectedCard : Theme.Bg, border);
        g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;

        if (BrowserIcon is not null)
            g.DrawImage(BrowserIcon, new Rectangle((Width - 32) / 2, 4, 32, 32));

        var circle = new Rectangle((Width - 26) / 2, 38, 26, 26);
        if (_avatar is not null)
        {
            using var path = new System.Drawing.Drawing2D.GraphicsPath();
            path.AddEllipse(circle);
            var state = g.Save();
            g.SetClip(path);
            g.DrawImage(_avatar, circle);
            g.Restore(state);
        }
        else
        {
            using var brush = new SolidBrush(ThemeColor ?? Theme.Muted3);
            g.FillEllipse(brush, circle);
        }

        Theme.DrawText(g, Text, Font, Theme.Text, new Rectangle(2, 66, Width - 4, 16),
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.SingleLine);
    }
}
