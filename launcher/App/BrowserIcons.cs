using System.ComponentModel;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

namespace BlueprintLauncher.App;

/// <summary>Real browser icons taken from the browser exe, cached. Falls back to a neutral square.</summary>
internal static class BrowserIcons
{
    private const int IconSize = 32;
    private static readonly Dictionary<string, Bitmap> Cache = new();

    /// <summary>32x32 icon for a browser id. Never null; the caller must not dispose it.</summary>
    public static Bitmap Get(string browser)
    {
        lock (Cache)
        {
            if (Cache.TryGetValue(browser, out var hit)) return hit;
            var bmp = Extract(browser) ?? Neutral();
            Cache[browser] = bmp;
            return bmp;
        }
    }

    private static Bitmap? Extract(string browser)
    {
        try
        {
            var exe = Program.FindBrowser(browser);
            if (exe is null) return null;
            using var icon = Icon.ExtractAssociatedIcon(exe);
            if (icon is null) return null;
            using var source = icon.ToBitmap();
            var bmp = new Bitmap(IconSize, IconSize, PixelFormat.Format32bppArgb);
            using var g = Graphics.FromImage(bmp);
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.DrawImage(source, new Rectangle(0, 0, IconSize, IconSize));
            return bmp;
        }
        catch (Exception e) when (e is ArgumentException or IOException or UnauthorizedAccessException or Win32Exception or InvalidOperationException)
        {
            return null;
        }
    }

    private static Bitmap Neutral()
    {
        var bmp = new Bitmap(IconSize, IconSize, PixelFormat.Format32bppArgb);
        using var g = Graphics.FromImage(bmp);
        using var brush = new SolidBrush(Theme.Muted3);
        g.FillRectangle(brush, 4, 4, IconSize - 8, IconSize - 8);
        return bmp;
    }
}
