using games_vault.Data;
using games_vault.Models;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;

namespace games_vault.Profiles;

public sealed class ProfileInviteService(AppDbContext db)
{
    public async Task<ProfileInviteCode> GenerateAsync(CancellationToken ct)
    {
        string code;
        do
        {
            var bytes = new byte[18];
            System.Security.Cryptography.RandomNumberGenerator.Fill(bytes);
            code = WebEncoders.Base64UrlEncode(bytes);
        }
        while (await db.ProfileInviteCodes.AnyAsync(x => x.Code == code, ct));

        var invite = new ProfileInviteCode
        {
            Code = code,
            CreatedUtc = DateTime.UtcNow
        };
        db.ProfileInviteCodes.Add(invite);
        await db.SaveChangesAsync(ct);
        return invite;
    }

    public async Task<IReadOnlyList<ProfileInviteCode>> ListRecentAsync(CancellationToken ct)
    {
        return await db.ProfileInviteCodes
            .AsNoTracking()
            .Include(x => x.UsedByProfile)
            .OrderByDescending(x => x.CreatedUtc)
            .Take(50)
            .ToListAsync(ct);
    }

    public async Task<ProfileInviteCode> ConsumeAsync(string? code, int profileId, CancellationToken ct)
    {
        var normalized = NormalizeCode(code);
        var invite = await db.ProfileInviteCodes.FirstOrDefaultAsync(x => x.Code == normalized, ct)
            ?? throw new InvalidOperationException("Invite code not found. Ask an admin for a fresh invite link.");

        if (invite.IsUsed)
        {
            throw new InvalidOperationException("That invite code has already been used. Ask an admin for a fresh invite link.");
        }

        invite.UsedUtc = DateTime.UtcNow;
        invite.UsedByProfileId = profileId;
        return invite;
    }

    public static string NormalizeCode(string? code)
    {
        var normalized = (code ?? "").Trim();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            throw new InvalidOperationException("An invite code is required to create a profile.");
        }

        return normalized;
    }
}
