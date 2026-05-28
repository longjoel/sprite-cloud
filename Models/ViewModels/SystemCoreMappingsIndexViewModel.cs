namespace games_vault.Models.ViewModels;

public sealed class SystemCoreMappingsIndexViewModel
{
    public IReadOnlyList<SystemCoreMappingRow> Rows { get; init; } = [];
    public IReadOnlyList<string> InstalledNativeCores { get; init; } = [];
    public IReadOnlyList<InstalledCoreInventoryRow> InstalledCoreInventory { get; init; } = [];
}

public sealed class InstalledCoreInventoryRow
{
    public string FileName { get; init; } = "";
    public string DisplayName { get; init; } = "";
    public bool IsKnownToCatalog { get; init; }
    public IReadOnlyList<string> KnownSystemNames { get; init; } = [];
    public IReadOnlyList<string> UsedBySystemNames { get; init; } = [];
}

public sealed class SystemCoreMappingRow
{
    public int? Id { get; init; }
    public string SystemName { get; init; } = "";
    public int GameCount { get; init; }
    public string? NativeCoreFileName { get; init; }
    public string? WebPlayerCoreKey { get; init; }
    public bool IsEnabled { get; init; } = true;
    public bool IsAutoMapped { get; init; }
    public bool HasNativeCoreMapping { get; init; }
    public string? Notes { get; init; }
}
