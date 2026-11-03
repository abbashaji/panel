namespace BlueprintLauncher.Core.Tests;

internal sealed class TempDir : IDisposable
{
    public string Dir { get; } = Path.Combine(Path.GetTempPath(), "bp-" + Guid.NewGuid().ToString("N"));

    public TempDir()
    {
        Directory.CreateDirectory(Dir);
    }

    public void Dispose()
    {
        try { Directory.Delete(Dir, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
}
