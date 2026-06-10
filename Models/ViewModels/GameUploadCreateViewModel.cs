using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Http;

namespace games_vault.Models.ViewModels;

public sealed class GameUploadCreateViewModel
{
    public bool LibretroAvailable { get; set; }

    [Required]
    [Display(Name = "Files")]
    public IFormFile[] Files { get; set; } = [];

    public IReadOnlyList<games_vault.Models.NetworkShare> NetworkShares { get; set; } = [];
    public int? SelectedNetworkShareId { get; set; }
    public string? NetworkQuery { get; set; }

    public Guid NetworkScanSessionId { get; set; } = Guid.Empty;
    public int? NetworkScanJobId { get; set; }

    public IReadOnlyList<games_vault.Models.WebSource> WebSources { get; set; } = [];
    public int? SelectedWebSourceId { get; set; }
    public string? WebQuery { get; set; }

    public Guid WebScanSessionId { get; set; } = Guid.Empty;

    public IReadOnlyList<games_vault.Models.LocalFolder> LocalFolders { get; set; } = [];
    public int? SelectedLocalFolderId { get; set; }
    public string? LocalQuery { get; set; }

    public Guid LocalScanSessionId { get; set; } = Guid.Empty;
}
