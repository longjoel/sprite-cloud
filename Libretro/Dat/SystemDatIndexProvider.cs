using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Caching.Memory;

namespace games_vault.Libretro.Dat;

public sealed class SystemDatIndexProvider(IWebHostEnvironment env, IMemoryCache cache)
{
    private const string CacheKey = "libretro.systemdat.index.v1";

    public SystemDatIndex Get()
    {
        return cache.GetOrCreate(CacheKey, entry =>
        {
            entry.SlidingExpiration = TimeSpan.FromMinutes(10);

            var path = Path.Combine(env.ContentRootPath, "App_Data", "libretro-database", "dat", "System.dat");
            if (!System.IO.File.Exists(path))
            {
                return SystemDatIndex.Parse("");
            }

            var content = System.IO.File.ReadAllText(path);
            return SystemDatIndex.Parse(content);
        })!;
    }
}

