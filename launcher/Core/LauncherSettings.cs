using System.Text.Json;

namespace BlueprintLauncher.Core;

/// <summary>%LOCALAPPDATA%\BlueprintLauncher\settings.json. Keys autoSend, autoSendEngine and allowedRepos are read; everything else is ignored.</summary>
public sealed class LauncherSettings
{
    public const string FileName = "settings.json";
    private const long MaxBytes = 64 * 1024;
    private const string AutoSendKey = "autoSend";
    private const string EngineKey = "autoSendEngine";
    private const string ReposKey = "allowedRepos";
    private const string TemplateCellKey = "promptTemplateCell";
    private const string TemplateStewardKey = "promptTemplateSteward";
    public const int MaxTemplateLength = 1500;

    public const string EngineNative = "native";
    public const string EngineUserscript = "userscript";
    public const int MaxAllowedRepos = 50;

    private string _engine = EngineNative;
    private readonly List<string> _repos = new();
    private string? _templateCell;
    private string? _templateSteward;

    /// <summary>Opt-in auto-send of the pre-filled prompt. Default false.</summary>
    public bool AutoSend { get; set; }

    /// <summary>'native' (default) or 'userscript'. Any other value becomes 'native'.</summary>
    public string Engine
    {
        get => _engine;
        set => _engine = NormalizeEngine(value);
    }

    /// <summary>Lowercase owner/name repos the teammate allowed for auto-send on this PC. No duplicates, at most 50.</summary>
    public IReadOnlyList<string> AllowedRepos => _repos.AsReadOnly();

    /// <summary>Edited cell prompt template, or null when unset. Null, blank or longer than 1500 characters gives null.</summary>
    public string? PromptTemplateCell
    {
        get => _templateCell;
        set => _templateCell = NormalizeTemplate(value);
    }

    /// <summary>Edited Steward prompt template with the placeholder {code} (never a real code), or null when unset. Same limits as the cell template.</summary>
    public string? PromptTemplateSteward
    {
        get => _templateSteward;
        set => _templateSteward = NormalizeTemplate(value);
    }

    private static string? NormalizeTemplate(string? value)
        => string.IsNullOrWhiteSpace(value) || value.Length > MaxTemplateLength ? null : value;

    /// <summary>
    /// Cell needs {cell} and next_cell; Steward needs {code} and steward_next; both allow only the placeholders
    /// {repo}, {cell} and {code} in braces. reason is a short plain sentence, empty when ok.
    /// </summary>
    public static bool ValidTemplate(PromptKind kind, string? t, out string reason)
    {
        reason = string.Empty;
        if (string.IsNullOrWhiteSpace(t))
        {
            reason = "The template is empty.";
            return false;
        }
        if (t.Length > MaxTemplateLength)
        {
            reason = "The template is longer than " + MaxTemplateLength + " characters.";
            return false;
        }
        if (kind == PromptKind.Cell)
        {
            if (!t.Contains("{cell}", StringComparison.Ordinal))
            {
                reason = "The template must contain {cell}.";
                return false;
            }
            if (!t.Contains("next_cell", StringComparison.Ordinal))
            {
                reason = "The template must mention next_cell.";
                return false;
            }
        }
        else if (kind == PromptKind.Steward)
        {
            if (!t.Contains("{code}", StringComparison.Ordinal))
            {
                reason = "The template must contain {code}.";
                return false;
            }
            if (!t.Contains("steward_next", StringComparison.Ordinal))
            {
                reason = "The template must mention steward_next.";
                return false;
            }
        }
        else
        {
            reason = "Unknown prompt kind.";
            return false;
        }
        var rest = t.Replace("{repo}", "").Replace("{cell}", "").Replace("{code}", "");
        if (rest.IndexOfAny(new[] { '{', '}' }) >= 0)
        {
            reason = "Only {repo}, {cell} and {code} may appear in braces.";
            return false;
        }
        return true;
    }

    /// <summary>Case-insensitive. False for invalid input.</summary>
    public bool IsRepoAllowed(string? repo)
        => ProtocolParser.IsValidRepo(repo) && _repos.Contains(repo!.ToLowerInvariant());

    /// <summary>False when the repo is invalid or the list is full; true when added or already present.</summary>
    public bool AllowRepo(string? repo)
    {
        if (!ProtocolParser.IsValidRepo(repo)) return false;
        var key = repo!.ToLowerInvariant();
        if (_repos.Contains(key)) return true;
        if (_repos.Count >= MaxAllowedRepos) return false;
        _repos.Add(key);
        return true;
    }

    private static string NormalizeEngine(string? value)
        => string.Equals(value, EngineUserscript, StringComparison.OrdinalIgnoreCase) ? EngineUserscript : EngineNative;

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
                if (string.Equals(prop.Name, EngineKey, StringComparison.OrdinalIgnoreCase))
                {
                    if (prop.Value.ValueKind == JsonValueKind.String) settings.Engine = prop.Value.GetString() ?? EngineNative;
                    continue;
                }
                if (string.Equals(prop.Name, ReposKey, StringComparison.OrdinalIgnoreCase))
                {
                    if (prop.Value.ValueKind != JsonValueKind.Array) continue;
                    foreach (var item in prop.Value.EnumerateArray())
                    {
                        if (item.ValueKind == JsonValueKind.String) settings.AllowRepo(item.GetString());
                    }
                    continue;
                }
                if (string.Equals(prop.Name, TemplateCellKey, StringComparison.OrdinalIgnoreCase))
                {
                    if (prop.Value.ValueKind == JsonValueKind.String) settings.PromptTemplateCell = prop.Value.GetString();
                    continue;
                }
                if (string.Equals(prop.Name, TemplateStewardKey, StringComparison.OrdinalIgnoreCase))
                {
                    if (prop.Value.ValueKind == JsonValueKind.String) settings.PromptTemplateSteward = prop.Value.GetString();
                    continue;
                }
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
            var data = new Dictionary<string, object>
            {
                [AutoSendKey] = AutoSend,
                [EngineKey] = Engine,
                [ReposKey] = _repos.ToArray(),
            };
            if (_templateCell is not null) data[TemplateCellKey] = _templateCell;
            if (_templateSteward is not null) data[TemplateStewardKey] = _templateSteward;
            var json = JsonSerializer.Serialize(data, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(tmp, json);
            File.Move(tmp, path, true);
        }
        finally
        {
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }
}
