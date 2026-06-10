using games_vault.Nosebleed;

namespace games_vault.Models.ViewModels;

public class ArcadeIndexViewModel
{
    public Arcade? Arcade { get; set; }
    public IReadOnlyList<ArcadeCabinetViewModel> Cabinets { get; set; } = Array.Empty<ArcadeCabinetViewModel>();
    public ArcadeGamePickerViewModel GamePicker { get; set; } = new();
    public bool CanPlay { get; set; }
    public bool CanManage { get; set; }
    public bool NosebleedEnabled { get; set; }
}

public class ArcadeCabinetViewModel
{
    public int Id { get; set; }
    public string DisplayName { get; set; } = "Cabinet";
    public int GameId { get; set; }
    public string GameName { get; set; } = "Game";
    public string SystemName { get; set; } = "";
    public bool IsEnabled { get; set; }
    public bool AutoRestart { get; set; }
    public string CreditMode { get; set; } = "Free Play";
    public string? RuntimeSessionId { get; set; }
    public DateTimeOffset? LastStartedUtc { get; set; }
    public DateTimeOffset? LastSeenAliveUtc { get; set; }
    public string? LastError { get; set; }
    public NosebleedSessionSnapshot? Session { get; set; }
    public bool IsRunning => Session is not null && !Session.HasExited;
}

public class ArcadeGameOptionViewModel
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public string SystemName { get; set; } = "";
}
