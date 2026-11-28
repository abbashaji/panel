using System.Text.Json;

namespace BlueprintLauncher.Core.Tests;

public class ProfileSelectionTests
{
    private static Profile P(string browser, string folder) => new(browser, folder, folder);

    private static readonly Profile[] Detected = { P("chrome", "Default"), P("chrome", "Profile 1"), P("edge", "Default") };

    private static string PathIn(TempDir t) => Path.Combine(t.Dir, "BlueprintLauncher", "profiles.json");

    private static (string, string)[] Keys(params Profile[] ps) => ps.Select(p => (p.Browser, p.Folder)).ToArray();

    private static void WriteRaw(string path, string text)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, text);
    }

    [Fact]
    public void NoFileMeansAllDetectedAndNothingNewOrMissing()
    {
        using var t = new TempDir();
        var s = ProfileSelection.Load(PathIn(t));
        Assert.False(s.HasSavedList);
        Assert.Equal(Detected, s.Filter(Detected));
        Assert.Empty(s.NewSinceSaved(Detected));
        Assert.Empty(s.Missing(Detected));
    }

    [Fact]
    public void SavedListFiltersInDetectedOrder()
    {
        using var t = new TempDir();
        var ticked = new[] { ("edge", "Default"), ("chrome", "Profile 1") };
        Assert.True(ProfileSelection.Save(PathIn(t), Detected, ticked));
        var s = ProfileSelection.Load(PathIn(t));
        Assert.True(s.HasSavedList);
        Assert.Equal(new[] { Detected[1], Detected[2] }, s.Filter(Detected));
    }

    [Fact]
    public void SavedListCanBeEmpty()
    {
        using var t = new TempDir();
        Assert.True(ProfileSelection.Save(PathIn(t), Detected, Array.Empty<(string, string)>()));
        var s = ProfileSelection.Load(PathIn(t));
        Assert.True(s.HasSavedList);
        Assert.Empty(s.Filter(Detected));
    }

    [Fact]
    public void NewProfileIsNewUntilSaved()
    {
        using var t = new TempDir();
        var first = Detected.Take(2).ToList();
        Assert.True(ProfileSelection.Save(PathIn(t), first, Keys(first.ToArray())));
        var s = ProfileSelection.Load(PathIn(t));
        Assert.Equal(new[] { Detected[2] }, s.NewSinceSaved(Detected));
        Assert.Equal(first, s.Filter(Detected));
        Assert.True(ProfileSelection.Save(PathIn(t), Detected, Keys(Detected)));
        var again = ProfileSelection.Load(PathIn(t));
        Assert.Empty(again.NewSinceSaved(Detected));
        Assert.Equal(Detected, again.Filter(Detected));
    }

    [Fact]
    public void RemovedProfileIsMissingAndDroppedOnSave()
    {
        using var t = new TempDir();
        Assert.True(ProfileSelection.Save(PathIn(t), Detected, Keys(Detected)));
        var now = Detected.Take(2).ToList();
        var s = ProfileSelection.Load(PathIn(t));
        Assert.Equal(new[] { ("edge", "Default") }, s.Missing(now));
        Assert.True(ProfileSelection.Save(PathIn(t), now, Keys(Detected)));
        var after = ProfileSelection.Load(PathIn(t));
        Assert.Empty(after.Missing(now));
        Assert.Empty(after.Missing(Detected));
        Assert.Equal(now, after.Filter(Detected));
    }

    [Fact]
    public void TickedButNotDetectedIsIgnored()
    {
        using var t = new TempDir();
        Assert.True(ProfileSelection.Save(PathIn(t), Detected, new[] { ("brave", "Default"), ("chrome", "Default") }));
        var s = ProfileSelection.Load(PathIn(t));
        Assert.Empty(s.Missing(Detected));
        Assert.Equal(new[] { Detected[0] }, s.Filter(Detected));
    }

    [Fact]
    public void FileHasTheDocumentedShape()
    {
        using var t = new TempDir();
        Assert.True(ProfileSelection.Save(PathIn(t), Detected, new[] { ("chrome", "Profile 1") }));
        using var doc = JsonDocument.Parse(File.ReadAllText(PathIn(t)));
        var root = doc.RootElement;
        Assert.Equal(1, root.GetProperty("version").GetInt32());
        var sel = root.GetProperty("selected");
        Assert.Equal(1, sel.GetArrayLength());
        Assert.Equal("chrome", sel[0].GetProperty("browser").GetString());
        Assert.Equal("Profile 1", sel[0].GetProperty("folder").GetString());
        Assert.Equal(3, root.GetProperty("seen").GetArrayLength());
    }

    [Theory]
    [InlineData("")]
    [InlineData("not json at all")]
    [InlineData("[]")]
    [InlineData("null")]
    [InlineData("{\"version\":1")]
    [InlineData("{\"version\":2,\"selected\":[],\"seen\":[]}")]
    [InlineData("{\"selected\":[],\"seen\":[]}")]
    [InlineData("{\"version\":1}")]
    [InlineData("{\"version\":1,\"selected\":{},\"seen\":[]}")]
    [InlineData("{\"version\":1,\"selected\":[1],\"seen\":[]}")]
    public void CorruptFileMeansNoSavedList(string text)
    {
        using var t = new TempDir();
        WriteRaw(PathIn(t), text);
        var s = ProfileSelection.Load(PathIn(t));
        Assert.False(s.HasSavedList);
        Assert.Equal(Detected, s.Filter(Detected));
    }

    [Fact]
    public void InvalidEntriesAreSkipped()
    {
        using var t = new TempDir();
        WriteRaw(PathIn(t), """
        {"version":1,"selected":[
          {"browser":"chrome","folder":"Default"},
          {"browser":"safari","folder":"Default"},
          {"browser":"chrome","folder":"../x"},
          {"browser":"firefox","folder":"-P"},
          {"browser":"chrome"}
        ],"seen":[]}
        """);
        var s = ProfileSelection.Load(PathIn(t));
        Assert.True(s.HasSavedList);
        Assert.Equal(new[] { Detected[0] }, s.Filter(Detected));
    }

    private static string ListJson(int count) =>
        "{\"version\":1,\"selected\":[" +
        string.Join(",", Enumerable.Range(1, count).Select(i => "{\"browser\":\"chrome\",\"folder\":\"Profile " + i + "\"}")) +
        "],\"seen\":[]}";

    [Fact]
    public void TwoHundredEntriesAreFineTwoHundredAndOneIsNot()
    {
        using var t = new TempDir();
        WriteRaw(PathIn(t), ListJson(200));
        Assert.True(ProfileSelection.Load(PathIn(t)).HasSavedList);
        WriteRaw(PathIn(t), ListJson(201));
        Assert.False(ProfileSelection.Load(PathIn(t)).HasSavedList);
    }

    [Fact]
    public void OversizedFileMeansNoSavedList()
    {
        using var t = new TempDir();
        WriteRaw(PathIn(t), ListJson(1) + new string(' ', 300_000));
        Assert.False(ProfileSelection.Load(PathIn(t)).HasSavedList);
    }

    [Fact]
    public void SaveWritesAtMost200EntriesEach()
    {
        using var t = new TempDir();
        var many = Enumerable.Range(1, 250).Select(i => P("chrome", "Profile " + i)).ToList();
        Assert.True(ProfileSelection.Save(PathIn(t), many, Keys(many.ToArray())));
        using var doc = JsonDocument.Parse(File.ReadAllText(PathIn(t)));
        Assert.Equal(200, doc.RootElement.GetProperty("selected").GetArrayLength());
        Assert.Equal(200, doc.RootElement.GetProperty("seen").GetArrayLength());
        Assert.True(ProfileSelection.Load(PathIn(t)).HasSavedList);
    }

    [Fact]
    public void SaveReplacesTheOldFileAndLeavesNoTempFile()
    {
        using var t = new TempDir();
        Assert.True(ProfileSelection.Save(PathIn(t), Detected, Keys(Detected)));
        Assert.True(ProfileSelection.Save(PathIn(t), Detected, new[] { ("edge", "Default") }));
        Assert.Equal(new[] { Detected[2] }, ProfileSelection.Load(PathIn(t)).Filter(Detected));
        var files = Directory.GetFiles(Path.GetDirectoryName(PathIn(t))!);
        Assert.Equal(new[] { PathIn(t) }, files);
    }

    [Fact]
    public void SaveOnAnUnwritableLocationReturnsFalse()
    {
        using var t = new TempDir();
        var blocker = Path.Combine(t.Dir, "blocker");
        File.WriteAllText(blocker, "");
        Assert.False(ProfileSelection.Save(Path.Combine(blocker, "sub", "profiles.json"), Detected, Keys(Detected)));
    }
}
