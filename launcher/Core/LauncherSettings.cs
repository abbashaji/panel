using System.Text.Json;

namespace BlueprintLauncher.Core;

/// <summary>%LOCALAPPDATA%\BlueprintLauncher\settings.json. Only AutoSend is read; everything else is ignored.</summary>
public sealed class LauncherSettings
{
    public const string FileName = "settings.json";
    private const long MaxBytes = 64 * 1024;
    private const string AutoSendKey = "autoSend";

    /// <summary>Opt-in auto-send of the pre-filled prompt. Default false.</summary>
    public bool AutoSend { get; set; }

    public static string DefaultPath(string localAppData)
        => Path.Combine(localAppData, "BlueprintLauncher", FileName);

    /// <summary>Missing, corrupt or oversized file gives the defaults.</summary>
    public static LauncherSettings Load(string path)
    {
        var settings = new LauncherSettings();
        try
        {
            var info = new FileInfo(path);
            if (!info.Exists || info.Length > MaxBytes) return settings;
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return settings;
            foreach (var prop in doc.RootElement.EnumerateObject())
            {
                if (!string.Equals(prop.Name, AutoSendKey, StringComparison.OrdinalIgnoreCase)) continue;
                if (prop.Value.ValueKind == JsonValueKind.True) settings.AutoSend = true;
                else if (prop.Value.ValueKind == JsonValueKind.False) settings.AutoSend = false;
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException or ArgumentException or InvalidOperationException or NotSupportedException)
        {
            return new LauncherSettings();
        }
        return settings;
    }

    /// <summary>Atomic: temp file in the same directory, then replace.</summary>
    public void Save(string path)
    {
        var dir = Path.GetDirectoryName(Path.GetFullPath(path))!;
        Directory.CreateDirectory(dir);
        var tmp = Path.Combine(dir, FileName + "." + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            var json = JsonSerializer.Serialize(new Dictionary<string, bool> { [AutoSendKey] = AutoSend }, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(tmp, json);
            File.Move(tmp, path, true);
        }
        finally
        {
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }
}
