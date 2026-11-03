using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace BlueprintLauncher.App;

/// <summary>Colors, fonts and painting helpers from docs/panel-design.md. Draws only; opens no network connection.</summary>
internal static class Theme
{
    private static Color Hex(int rgb) => Color.FromArgb((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255);

    public static readonly Color Window = Hex(0x0F1424);
    public static readonly Color Bg = Hex(0x0C101C);
    public static readonly Color Line = Hex(0x1E2740);
    public static readonly Color Raised = Hex(0x18213A);
    public static readonly Color RaisedBorder = Hex(0x2A3553);
    public static readonly Color SelectedCard = Hex(0x16213D);
    public static readonly Color Text = Hex(0xE8ECF5);
    public static readonly Color Text2 = Hex(0xC6CDDD);
    public static readonly Color Muted = Hex(0xA9B2C6);
    public static readonly Color Muted2 = Hex(0x9AA3B8);
    public static readonly Color Muted3 = Hex(0x8A93A8);
    public static readonly Color Accent = Hex(0x5B9DFF);
    public static readonly Color OnAccent = Hex(0x06142B);
    public static readonly Color Ready = Hex(0xFFC857);
    public static readonly Color Running = Hex(0x5B9DFF);
    public static readonly Color Done = Hex(0x3DD6A3);

    private static string? _family;

    private static string Family => _family ??= DetectFamily();

    /// <summary>Inter when installed, else Segoe UI.</summary>
    private static string DetectFamily()
    {
        try
        {
            using var fonts = new InstalledFontCollection();
            foreach (var f in fonts.Families)
                if (f.Name == "Inter") return "Inter";
        }
        catch (Exception)
        {
            // Fall back below.
        }
        return "Segoe UI";
    }

    /// <summary>Size is given in CSS pixels as in the design doc; stored in points so it follows the screen DPI.</summary>
    public static Font Ui(float px, FontStyle style = FontStyle.Regular)
        => new(Family, px * 0.75f, style, GraphicsUnit.Point);

    public static Font Mono(float px, FontStyle style = FontStyle.Regular)
        => new("Consolas", px * 0.75f, style, GraphicsUnit.Point);

    public static GraphicsPath RoundedRect(RectangleF r, float radius)
    {
        var path = new GraphicsPath();
        var d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
        if (d <= 0)
        {
            path.AddRectangle(r);
            return path;
        }
        path.AddArc(r.X, r.Y, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    public static void PaintRounded(Graphics g, Rectangle bounds, int radius, Color fill, Color? border)
    {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var r = new RectangleF(bounds.X + 0.5f, bounds.Y + 0.5f, bounds.Width - 1, bounds.Height - 1);
        using var path = RoundedRect(r, radius);
        using (var brush = new SolidBrush(fill)) g.FillPath(brush, path);
        if (border is { } c)
        {
            using var pen = new Pen(c);
            g.DrawPath(pen, path);
        }
    }

    public static void DrawText(Graphics g, string text, Font font, Color color, Rectangle bounds, TextFormatFlags flags)
        => TextRenderer.DrawText(g, text, font, bounds, color,
            flags | TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis | TextFormatFlags.SingleLine);

    /// <summary>Asks Windows for a dark title bar. Ignored on versions that do not support it.</summary>
    public static void DarkTitleBar(IntPtr handle)
    {
        try
        {
            var on = 1;
            DwmSetWindowAttribute(handle, 20, ref on, sizeof(int));
        }
        catch (Exception)
        {
            // Cosmetic only.
        }
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
}
