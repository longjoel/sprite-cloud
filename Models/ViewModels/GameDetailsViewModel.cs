namespace games_vault.Models.ViewModels;

public sealed class GameDetailsViewModel
{
    public required games_vault.Models.Game Game { get; init; }
    public required IReadOnlyList<games_vault.Models.GameFile> Files { get; init; }

    public int FilePage { get; init; }
    public int FilePageSize { get; init; }
    public int FileTotalCount { get; init; }

    public int FilePageCount => FilePageSize <= 0 ? 0 : (int)Math.Ceiling(FileTotalCount / (double)FilePageSize);
    public bool FileHasPrevious => FilePage > 1;
    public bool FileHasNext => FilePage < FilePageCount;

    /// <summary>Save artifacts (battery saves, save states) for this game, across all profiles.</summary>
    public IReadOnlyList<GameDetailsArtifact> SaveArtifacts { get; init; } = [];
}

/// <summary>A single save artifact displayed on the game Details page.</summary>
public sealed record GameDetailsArtifact
{
    /// <summary>Profile display name (or "Deleted profile").</summary>
    public required string ProfileName { get; init; }

    /// <summary>Profile ID for linking.</summary>
    public required int ProfileId { get; init; }

    /// <summary>The ROM file this save belongs to.</summary>
    public required string GameFileName { get; init; }

    /// <summary>Save slot key ("default", or a named slot).</summary>
    public required string Key { get; init; }

    /// <summary>"battery" or "state".</summary>
    public required string Kind { get; init; }

    /// <summary>Display-friendly kind label.</summary>
    public string KindLabel => Kind switch
    {
        "battery" => "Battery save",
        "state" => "Save state",
        _ => Kind
    };

    /// <summary>The revision size (bytes).</summary>
    public required long SizeBytes { get; init; }

    /// <summary>When the latest revision was created.</summary>
    public required DateTime CreatedUtc { get; init; }

    /// <summary>Revision source ("runtime", "upload", …).</summary>
    public required string Source { get; init; }

    /// <summary>Internal save ID for linking to history page.</summary>
    public required int ProfileGameSaveId { get; init; }

    /// <summary>ROM file ID for linking to history page.</summary>
    public required int GameFileId { get; init; }
}
