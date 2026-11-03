namespace BlueprintLauncher.Core.Tests;

/// <summary>The launcher opens no network connection: scan every launcher source file.</summary>
public class NoNetworkTests
{
    // Built by concatenation so this file does not match its own scan.
    private static readonly string[] Forbidden =
    {
        "System" + ".Net",
        "Http" + "Client",
        "Sock" + "et",
        "Web" + "Client",
    };

    private static string FindLauncherDir()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, "launcher");
            if (Directory.Exists(Path.Combine(candidate, "Core"))) return candidate;
            dir = dir.Parent;
        }
        throw new DirectoryNotFoundException("launcher directory not found above " + AppContext.BaseDirectory);
    }

    private static bool IsBuildOutput(string path)
    {
        var sep = Path.DirectorySeparatorChar;
        return path.Contains(sep + "obj" + sep) || path.Contains(sep + "bin" + sep);
    }

    [Fact]
    public void NoLauncherSourceUsesNetworkApis()
    {
        var launcher = FindLauncherDir();
        var files = Directory.EnumerateFiles(launcher, "*.cs", SearchOption.AllDirectories)
            .Where(f => !IsBuildOutput(f))
            .ToList();
        Assert.Contains(files, f => f.EndsWith("ProtocolParser.cs", StringComparison.Ordinal));
        var hits = new List<string>();
        foreach (var file in files)
        {
            var text = File.ReadAllText(file);
            foreach (var token in Forbidden)
            {
                if (text.Contains(token, StringComparison.Ordinal)) hits.Add(file + ": " + token);
            }
        }
        Assert.True(hits.Count == 0, string.Join(Environment.NewLine, hits));
    }

    [Fact]
    public void CoreProjectHasNoPackageReferences()
    {
        var csproj = File.ReadAllText(Path.Combine(FindLauncherDir(), "Core", "Core.csproj"));
        Assert.DoesNotContain("PackageReference", csproj);
    }
}
