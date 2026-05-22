using games_vault.Data;
using games_vault.Models;
using games_vault.Models.ViewModels;
using games_vault.Profiles;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Controllers;

public sealed class ProfilesController(
    AppDbContext db,
    CurrentProfileService currentProfile,
    CurrentAccessService currentAccess,
    LocalProfileService localProfiles,
    ProfileInviteService invites) : Controller
{
    public async Task<IActionResult> Index(CancellationToken cancellationToken = default)
    {
        var current = await currentProfile.GetCurrentAsync(cancellationToken);
        var mode = await currentAccess.GetAccessModeAsync(cancellationToken);
        var now = DateTime.UtcNow;
        var profiles = await db.UserProfiles.AsNoTracking().Where(x => !x.IsArchived).OrderBy(x => x.DisplayName).ToListAsync(cancellationToken);
        var rows = await db.GamePlaySessions.AsNoTracking().Where(x => x.ProfileId != null).Select(x => new { x.ProfileId, x.StartedUtc, x.EndedUtc, x.DurationSeconds }).ToListAsync(cancellationToken);
        return View(new ProfilesIndexViewModel
        {
            CurrentProfileId = current?.Id,
            AccessMode = mode.ToString(),
            Profiles = profiles.Select(p =>
            {
                var mine = rows.Where(x => x.ProfileId == p.Id).ToList();
                return new ProfileSummaryViewModel
                {
                    Id = p.Id,
                    DisplayName = p.DisplayName,
                    Color = p.Color,
                    IsCurrent = current?.Id == p.Id,
                    IsAdmin = p.IsAdmin,
                    SessionCount = mine.Count,
                    TotalPlayTime = TimeSpan.FromSeconds(mine.Sum(x => x.EndedUtc.HasValue ? x.DurationSeconds : (int)Math.Max(0, Math.Round((now - x.StartedUtc).TotalSeconds)))),
                    LastPlayedUtc = mine.Count == 0 ? null : mine.Max(x => x.StartedUtc)
                };
            }).ToList()
        });
    }

    public IActionResult Create(string? invite = null)
    {
        return View(new ProfileEditViewModel { InviteCode = invite });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Create(ProfileEditViewModel model, CancellationToken cancellationToken = default)
    {
        if (!ModelState.IsValid)
        {
            return View(model);
        }

        try
        {
            var profile = await localProfiles.CreateWithInviteAsync(model.DisplayName, model.Color, model.InviteCode, cancellationToken);
            TempData["Message"] = $"Created profile for {profile.DisplayName}. The starter PIN is 0000.";
            return RedirectToAction(nameof(Details), new { id = profile.Id });
        }
        catch (ArgumentException ex)
        {
            ModelState.AddModelError(string.Empty, ex.Message);
            return View(model);
        }
        catch (InvalidOperationException ex)
        {
            ModelState.AddModelError(string.Empty, ex.Message);
            return View(model);
        }
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> SignIn(int profileId, string pin, CancellationToken cancellationToken = default)
    {
        if (await localProfiles.SignInAsync(profileId, pin, cancellationToken))
        {
            TempData["Message"] = "Profile selected.";
            return RedirectToAction(nameof(Index));
        }

        TempData["Error"] = "Invalid PIN.";
        return RedirectToAction(nameof(Index));
    }

    public async Task<IActionResult> Invites(CancellationToken cancellationToken = default)
    {
        if (!await currentAccess.IsAdminAsync(cancellationToken))
        {
            return Forbid();
        }

        return View(await BuildInvitesViewModelAsync(null, cancellationToken));
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> GenerateInvite(CancellationToken cancellationToken = default)
    {
        if (!await currentAccess.IsAdminAsync(cancellationToken))
        {
            return Forbid();
        }

        var invite = await invites.GenerateAsync(cancellationToken);
        TempData["Message"] = "Invite link generated.";
        return View("Invites", await BuildInvitesViewModelAsync(invite, cancellationToken));
    }

    public async Task<IActionResult> Details(int id, CancellationToken cancellationToken = default)
    {
        var profile = await db.UserProfiles.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id && !x.IsArchived, cancellationToken);
        if (profile is null) return NotFound();
        var current = await currentProfile.GetCurrentAsync(cancellationToken);
        var now = DateTime.UtcNow;
        var sessions = await db.GamePlaySessions.AsNoTracking()
            .Where(x => x.ProfileId == id)
            .Select(x => new { x.GameId, GameName = x.Game.Name, x.Mode, x.StartedUtc, x.EndedUtc, x.DurationSeconds, x.EndReason })
            .ToListAsync(cancellationToken);
        var recent = sessions.OrderByDescending(x => x.StartedUtc).Take(25).Select(x => new ProfileRecentSessionViewModel
        {
            GameId = x.GameId,
            GameName = x.GameName,
            Mode = x.Mode,
            StartedUtc = x.StartedUtc,
            EndedUtc = x.EndedUtc,
            EndReason = x.EndReason,
            Duration = TimeSpan.FromSeconds(x.EndedUtc.HasValue ? x.DurationSeconds : (int)Math.Max(0, Math.Round((now - x.StartedUtc).TotalSeconds)))
        }).ToList();
        var top = sessions.GroupBy(x => new { x.GameId, x.GameName }).Select(g => new ProfileTopGameViewModel
        {
            GameId = g.Key.GameId,
            GameName = g.Key.GameName,
            SessionCount = g.Count(),
            TotalPlayTime = TimeSpan.FromSeconds(g.Sum(x => x.EndedUtc.HasValue ? x.DurationSeconds : (int)Math.Max(0, Math.Round((now - x.StartedUtc).TotalSeconds))))
        }).OrderByDescending(x => x.TotalPlayTime).Take(10).ToList();

        return View(new ProfileDetailsViewModel
        {
            Id = profile.Id,
            DisplayName = profile.DisplayName,
            Color = profile.Color,
            IsCurrent = current?.Id == profile.Id,
            SessionCount = sessions.Count,
            TotalPlayTime = TimeSpan.FromSeconds(recent.Sum(x => (int)x.Duration.TotalSeconds)),
            LastPlayedGame = recent.FirstOrDefault()?.GameName,
            RecentSessions = recent,
            TopGames = top
        });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public IActionResult Clear()
    {
        currentProfile.ClearCurrent();
        TempData["Message"] = "Returned to viewer mode.";
        return RedirectToAction(nameof(Index));
    }

    private async Task<ProfileInvitesViewModel> BuildInvitesViewModelAsync(ProfileInviteCode? newInvite, CancellationToken ct)
    {
        var rows = await invites.ListRecentAsync(ct);
        return new ProfileInvitesViewModel
        {
            NewInviteLink = newInvite is null ? null : BuildInviteLink(newInvite.Code),
            Invites = rows.Select(x => new ProfileInviteRowViewModel
            {
                Code = x.Code,
                InviteLink = BuildInviteLink(x.Code),
                CreatedUtc = x.CreatedUtc,
                UsedUtc = x.UsedUtc,
                UsedByProfileName = x.UsedByProfile?.DisplayName
            }).ToList()
        };
    }

    private string BuildInviteLink(string code)
    {
        return Url.Action(nameof(Create), "Profiles", new { invite = code }, Request.Scheme) ?? $"/Profiles/Create?invite={Uri.EscapeDataString(code)}";
    }
}
