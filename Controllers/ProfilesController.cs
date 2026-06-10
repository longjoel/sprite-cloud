using games_vault.Data;
using games_vault.Models;
using games_vault.Models.ViewModels;
using games_vault.Profiles;
using games_vault.Web;
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
        var profileStats = await db.GamePlaySessions
            .AsNoTracking()
            .Where(x => x.ProfileId != null)
            .GroupBy(x => x.ProfileId!.Value)
            .Select(g => new
            {
                ProfileId = g.Key,
                SessionCount = g.Count(),
                TotalSeconds = g.Sum(x => x.EndedUtc != null ? x.DurationSeconds : 0),
                LastPlayedUtc = g.Max(x => x.StartedUtc)
            })
            .ToListAsync(cancellationToken);
        var statsMap = profileStats.ToDictionary(x => x.ProfileId);
        return View(new ProfilesIndexViewModel
        {
            CurrentProfileId = current?.Id,
            AccessMode = mode.ToString(),
            CurrentProfileDashboard = current is null ? null : await BuildCurrentProfileDashboard(current, now),
            Profiles = profiles.Select(p =>
            {
                var stat = statsMap.GetValueOrDefault(p.Id);
                return new ProfileSummaryViewModel
                {
                    Id = p.Id,
                    DisplayName = p.DisplayName,
                    Username = p.Username,
                    Color = p.Color,
                    IsCurrent = current?.Id == p.Id,
                    IsAdmin = p.IsAdmin,
                    SessionCount = stat?.SessionCount ?? 0,
                    TotalPlayTime = TimeSpan.FromSeconds(stat?.TotalSeconds ?? 0),
                    LastPlayedUtc = stat?.LastPlayedUtc
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
            var profile = await localProfiles.CreateWithInviteAsync(model.DisplayName, model.Username, model.Password, model.Color, model.InviteCode, cancellationToken);
            if (!string.IsNullOrWhiteSpace(model.AvatarKey) || !string.IsNullOrWhiteSpace(model.Bio))
            {
                profile.AvatarKey = model.AvatarKey;
                profile.Bio = model.Bio;
                await db.SaveChangesAsync(cancellationToken);
            }
            TempData["Message"] = $"Created profile for {profile.DisplayName}. You are now signed in as @{profile.Username}.";
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
    [RateLimit(permitLimit: 10, windowSeconds: 60)]
    public async Task<IActionResult> SignIn(string username, string password, string? returnUrl, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(username))
        {
            TempData["Error"] = "Invalid username or password.";
            return RedirectToLocalOrIndex(returnUrl);
        }

        if (await localProfiles.SignInAsync(username, password, cancellationToken))
        {
            TempData["Message"] = "Profile selected.";
            return RedirectToLocalOrIndex(returnUrl);
        }

        TempData["Error"] = "Invalid username or password.";
        return RedirectToLocalOrIndex(returnUrl);
    }

    private static IActionResult RedirectToLocalOrIndex(string? returnUrl)
    {
        if (!string.IsNullOrWhiteSpace(returnUrl) && Uri.TryCreate(returnUrl, UriKind.Relative, out var uri))
        {
            return new RedirectResult(returnUrl);
        }
        return new RedirectToActionResult("Index", "Home", null);
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
        var current = await currentProfile.GetCurrentAsync(cancellationToken);
        var isAdmin = await currentAccess.IsAdminAsync(cancellationToken);
        if (current?.Id != id && !isAdmin)
        {
            return NotFound();
        }

        var model = await BuildDetailsViewModelAsync(id, null, cancellationToken);
        if (model is null) return NotFound();
        return View(model);
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> ChangePassword(ProfileChangePasswordViewModel model, CancellationToken cancellationToken = default)
    {
        var profile = await db.UserProfiles.AsNoTracking().FirstOrDefaultAsync(x => x.Id == model.ProfileId && !x.IsArchived, cancellationToken);
        if (profile is null)
        {
            return NotFound();
        }

        var current = await currentProfile.GetCurrentAsync(cancellationToken);
        if (current?.Id != model.ProfileId)
        {
            return Forbid();
        }

        if (!ModelState.IsValid)
        {
            var invalidModel = await BuildDetailsViewModelAsync(model.ProfileId, model, cancellationToken);
            return View(nameof(Details), invalidModel!);
        }

        if (!await localProfiles.ChangePasswordAsync(model.ProfileId, model.CurrentPassword, model.NewPassword, cancellationToken))
        {
            ModelState.AddModelError(string.Empty, "Current password was incorrect.");
            var failedModel = await BuildDetailsViewModelAsync(model.ProfileId, model, cancellationToken);
            return View(nameof(Details), failedModel!);
        }

        TempData["Message"] = "Password updated.";
        return RedirectToAction(nameof(Details), new { id = model.ProfileId });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public IActionResult Clear()
    {
        currentProfile.ClearCurrent();
        TempData["Message"] = "Signed out.";
        return RedirectToAction(nameof(Index));
    }

    [ServiceFilter(typeof(AdminOnlyFilter))]
    public async Task<IActionResult> Edit(int id, CancellationToken cancellationToken = default)
    {
        var current = await currentProfile.GetCurrentAsync(cancellationToken);
        var isAdmin = await currentAccess.IsAdminAsync(cancellationToken);
        if (current?.Id != id && !isAdmin)
        {
            return NotFound();
        }

        var profile = await db.UserProfiles.AsNoTracking()
            .FirstOrDefaultAsync(x => x.Id == id && !x.IsArchived, cancellationToken);
        if (profile is null) return NotFound();

        return View(new ProfileSettingsViewModel
        {
            Id = profile.Id,
            DisplayName = profile.DisplayName,
            Color = profile.Color,
            AvatarKey = profile.AvatarKey,
            Bio = profile.Bio
        });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Edit(ProfileSettingsViewModel model, CancellationToken cancellationToken = default)
    {
        var current = await currentProfile.GetCurrentAsync(cancellationToken);
        var isAdmin = await currentAccess.IsAdminAsync(cancellationToken);
        if (current?.Id != model.Id && !isAdmin)
        {
            return Forbid();
        }

        if (!ModelState.IsValid)
        {
            return View(model);
        }

        var profile = await db.UserProfiles.FirstOrDefaultAsync(x => x.Id == model.Id && !x.IsArchived, cancellationToken);
        if (profile is null) return NotFound();

        var normalizedName = PasskeyService.NormalizeDisplayName(model.DisplayName);
        var normalizedColor = PasskeyService.NormalizeColor(model.Color);

        profile.DisplayName = normalizedName;
        profile.Color = normalizedColor;
        profile.AvatarKey = model.AvatarKey;
        profile.Bio = model.Bio;
        profile.UpdatedUtc = DateTime.UtcNow;

        await db.SaveChangesAsync(cancellationToken);
        TempData["Message"] = "Profile updated.";
        return RedirectToAction(nameof(Details), new { id = model.Id });
    }

    [ServiceFilter(typeof(AdminOnlyFilter))]
    public async Task<IActionResult> Delete(int id, CancellationToken cancellationToken = default)
    {
        var profile = await db.UserProfiles.AsNoTracking()
            .FirstOrDefaultAsync(x => x.Id == id && !x.IsArchived, cancellationToken);
        if (profile is null) return NotFound();

        var current = await currentProfile.GetCurrentAsync(cancellationToken);
        var (saveCount, sessionCount, authCount) = await CountAssociatedDataAsync(id, cancellationToken);

        return View(new ProfileDeleteViewModel
        {
            Id = profile.Id,
            DisplayName = profile.DisplayName,
            Username = profile.Username,
            Color = profile.Color,
            IsCurrent = current?.Id == profile.Id,
            GameSaveCount = saveCount,
            GameSessionCount = sessionCount,
            AuthSessionCount = authCount
        });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    [ServiceFilter(typeof(AdminOnlyFilter))]
    public async Task<IActionResult> DeleteConfirmed(int id, CancellationToken cancellationToken = default)
    {
        var profile = await db.UserProfiles
            .FirstOrDefaultAsync(x => x.Id == id && !x.IsArchived, cancellationToken);
        if (profile is null) return NotFound();

        // If admin is deleting their own active profile, sign them out first.
        var current = await currentProfile.GetCurrentAsync(cancellationToken);
        if (current?.Id == id)
        {
            currentProfile.ClearCurrent();
        }

        // Remove all associated data in a single transaction.
        await using var tx = await db.Database.BeginTransactionAsync(cancellationToken);
        try
        {
            // Auth sessions
            await db.ProfileAuthSessions
                .Where(x => x.ProfileId == id)
                .ExecuteDeleteAsync(cancellationToken);

            // Game saves + revisions (cascade handles revisions)
            var saves = await db.ProfileGameSaves
                .Include(x => x.Revisions)
                .Where(x => x.ProfileId == id)
                .ToListAsync(cancellationToken);
            db.ProfileGameSaves.RemoveRange(saves);

            // Share link redemptions
            var redemptions = await db.ProfileShareLinks
                .Where(x => x.RedeemedByProfileId == id)
                .ToListAsync(cancellationToken);
            db.ProfileShareLinks.RemoveRange(redemptions);

            // Game play sessions (set profile reference to null instead of deleting history)
            await db.GamePlaySessions
                .Where(x => x.ProfileId == id)
                .ExecuteUpdateAsync(
                    s => s.SetProperty(x => x.ProfileId, (int?)null),
                    cancellationToken);

            // Invite codes used by this profile
            var invites = await db.ProfileInviteCodes
                .Where(x => x.UsedByProfileId == id)
                .ToListAsync(cancellationToken);
            foreach (var invite in invites)
            {
                invite.UsedByProfileId = null;
                invite.UsedUtc = null;
            }

            // Passkeys
            var passkeys = await db.UserProfilePasskeys
                .Where(x => x.ProfileId == id)
                .ToListAsync(cancellationToken);
            db.UserProfilePasskeys.RemoveRange(passkeys);

            // Finally, archive (not hard-delete) the profile
            profile.IsArchived = true;
            await db.SaveChangesAsync(cancellationToken);
            await tx.CommitAsync(cancellationToken);

            TempData["Message"] = $"Profile '{profile.DisplayName}' has been archived and all associated data removed.";
        }
        catch
        {
            await tx.RollbackAsync(cancellationToken);
            throw;
        }

        return RedirectToAction(nameof(Index));
    }

    private async Task<(int SaveCount, int SessionCount, int AuthCount)> CountAssociatedDataAsync(int profileId, CancellationToken ct)
    {
        var saveCount = await db.ProfileGameSaves.CountAsync(x => x.ProfileId == profileId, ct);
        var sessionCount = await db.GamePlaySessions.CountAsync(x => x.ProfileId == profileId, ct);
        var authCount = await db.ProfileAuthSessions.CountAsync(x => x.ProfileId == profileId, ct);
        return (saveCount, sessionCount, authCount);
    }

    private async Task<ProfileDetailsViewModel?> BuildDetailsViewModelAsync(int id, ProfileChangePasswordViewModel? changePasswordModel, CancellationToken cancellationToken)
    {
        var profile = await db.UserProfiles.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id && !x.IsArchived, cancellationToken);
        if (profile is null) return null;

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

        return new ProfileDetailsViewModel
        {
            Id = profile.Id,
            DisplayName = profile.DisplayName,
            Username = profile.Username,
            AvatarKey = profile.AvatarKey,
            Bio = profile.Bio,
            Color = profile.Color,
            IsCurrent = current?.Id == profile.Id,
            SessionCount = sessions.Count,
            TotalPlayTime = TimeSpan.FromSeconds(recent.Sum(x => (int)x.Duration.TotalSeconds)),
            LastPlayedGame = recent.FirstOrDefault()?.GameName,
            ChangePassword = changePasswordModel ?? new ProfileChangePasswordViewModel { ProfileId = profile.Id },
            RecentSessions = recent,
            TopGames = top
        };
    }

    private async Task<CurrentProfileDashboardViewModel?> BuildCurrentProfileDashboard(UserProfile profile, DateTime now)
    {
        var sessions = await db.GamePlaySessions.AsNoTracking()
            .Where(x => x.ProfileId == profile.Id)
            .Select(x => new { x.GameId, GameName = x.Game.Name, x.Mode, x.StartedUtc, x.EndedUtc, x.DurationSeconds, x.EndReason })
            .ToListAsync();
        var ordered = sessions.OrderByDescending(x => x.StartedUtc).ToList();
        var recent = ordered.Take(5).Select(x => new ProfileRecentSessionViewModel
        {
            GameId = x.GameId,
            GameName = x.GameName,
            Mode = x.Mode,
            StartedUtc = x.StartedUtc,
            EndedUtc = x.EndedUtc,
            EndReason = x.EndReason,
            Duration = TimeSpan.FromSeconds(x.EndedUtc.HasValue ? x.DurationSeconds : (int)Math.Max(0, Math.Round((now - x.StartedUtc).TotalSeconds)))
        }).ToList();
        var top = ordered.GroupBy(x => new { x.GameId, x.GameName }).Select(g => new ProfileTopGameViewModel
        {
            GameId = g.Key.GameId,
            GameName = g.Key.GameName,
            SessionCount = g.Count(),
            TotalPlayTime = TimeSpan.FromSeconds(g.Sum(x => x.EndedUtc.HasValue ? x.DurationSeconds : (int)Math.Max(0, Math.Round((now - x.StartedUtc).TotalSeconds))))
        }).OrderByDescending(x => x.TotalPlayTime).Take(3).ToList();

        return new CurrentProfileDashboardViewModel
        {
            Id = profile.Id,
            DisplayName = profile.DisplayName,
            Username = profile.Username,
            Color = profile.Color,
            IsAdmin = profile.IsAdmin,
            SessionCount = ordered.Count,
            TotalPlayTime = TimeSpan.FromSeconds(ordered.Sum(x => x.EndedUtc.HasValue ? x.DurationSeconds : (int)Math.Max(0, Math.Round((now - x.StartedUtc).TotalSeconds)))),
            LastPlayedGame = recent.FirstOrDefault()?.GameName,
            RecentSessions = recent,
            TopGames = top
        };
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
