namespace BlueprintLauncher.Core;

/// <summary>Executable plus argument list. Never a shell string.</summary>
public sealed record LaunchCommand(string Exe, IReadOnlyList<string> Arguments)
{
    public static LaunchCommand Build(string exe, string profileFolder, string url)
    {
        if (string.IsNullOrWhiteSpace(exe) || exe.Any(c => c < ' ')) throw new ArgumentException("invalid executable", nameof(exe));
        if (!BrowserProfiles.IsValidFolder(profileFolder)) throw new ArgumentException("invalid profile folder", nameof(profileFolder));
        if (string.IsNullOrEmpty(url)
            || !url.StartsWith(PromptBuilder.BaseUrl, StringComparison.Ordinal)
            || url.Any(c => c <= ' ' || c >= (char)0x7F))
        {
            throw new ArgumentException("invalid url", nameof(url));
        }
        return new LaunchCommand(exe, new[] { "--profile-directory=" + profileFolder, url });
    }
}
