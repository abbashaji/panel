using System.Runtime.InteropServices;

namespace BlueprintLauncher.App.Native;

/// <summary>Opaque handle for a parked window: keeps the placement saved before Park.</summary>
public sealed class ParkToken
{
    internal ParkToken(IntPtr hwnd, NativeMethods.WINDOWPLACEMENT saved, bool hasSaved)
    {
        Hwnd = hwnd;
        Saved = saved;
        HasSaved = hasSaved;
    }

    internal IntPtr Hwnd { get; }
    internal NativeMethods.WINDOWPLACEMENT Saved { get; }
    internal bool HasSaved { get; }
}

/// <summary>
/// Moves a browser window into a small always-on-top box in the bottom-right corner and back,
/// never activating it and never taking focus.
/// </summary>
public static class WindowPlacer
{
    private const int BoxWidth = 480;
    private const int BoxHeight = 360;

    public static ParkToken Park(IntPtr hwnd)
    {
        var saved = NewPlacement();
        var hasSaved = NativeMethods.GetWindowPlacement(hwnd, ref saved);

        var area = NativeMethods.GetWorkArea();
        var width = Math.Min(BoxWidth, area.Width);
        var height = Math.Min(BoxHeight, area.Height);
        var x = area.Right - width;
        var y = area.Bottom - height;

        // Placement rectangles are in work-area coordinates; SetWindowPos below uses screen coordinates and fixes any offset.
        var wp = NewPlacement();
        wp.rcNormalPosition = new NativeMethods.RECT
        {
            Left = x - area.Left,
            Top = y - area.Top,
            Right = x - area.Left + width,
            Bottom = y - area.Top + height,
        };
        NativeMethods.SetWindowPlacement(hwnd, ref wp);
        NativeMethods.SetWindowPos(hwnd, NativeMethods.HWND_TOPMOST, x, y, width, height, NativeMethods.SWP_NOACTIVATE);
        return new ParkToken(hwnd, saved, hasSaved);
    }

    public static void Restore(ParkToken? token)
    {
        if (token == null) return;
        var hwnd = token.Hwnd;
        if (!NativeMethods.IsWindow(hwnd)) return;

        NativeMethods.SetWindowPos(hwnd, NativeMethods.HWND_NOTOPMOST, 0, 0, 0, 0,
            NativeMethods.SWP_NOMOVE | NativeMethods.SWP_NOSIZE | NativeMethods.SWP_NOACTIVATE);

        if (!token.HasSaved) return;
        var wp = token.Saved;
        var rc = wp.rcNormalPosition;
        if (rc.Right <= rc.Left || rc.Bottom <= rc.Top) return;
        wp.length = Marshal.SizeOf<NativeMethods.WINDOWPLACEMENT>();
        wp.flags = 0;
        wp.showCmd = NativeMethods.SW_SHOWNOACTIVATE;
        wp.ptMinPosition = new NativeMethods.POINT { X = -1, Y = -1 };
        wp.ptMaxPosition = new NativeMethods.POINT { X = -1, Y = -1 };
        NativeMethods.SetWindowPlacement(hwnd, ref wp);
    }

    private static NativeMethods.WINDOWPLACEMENT NewPlacement()
    {
        return new NativeMethods.WINDOWPLACEMENT
        {
            length = Marshal.SizeOf<NativeMethods.WINDOWPLACEMENT>(),
            flags = 0,
            showCmd = NativeMethods.SW_SHOWNOACTIVATE,
            ptMinPosition = new NativeMethods.POINT { X = -1, Y = -1 },
            ptMaxPosition = new NativeMethods.POINT { X = -1, Y = -1 },
        };
    }
}
