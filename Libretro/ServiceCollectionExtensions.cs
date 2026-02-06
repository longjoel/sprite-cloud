using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace games_vault.Libretro;

public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddLibretroDatabase(this IServiceCollection services, IConfiguration configuration)
    {
        services.Configure<LibretroDatabaseOptions>(configuration.GetSection("LibretroDatabase"));
        services.AddSingleton<LibretroDatabaseStore>();
        services.AddSingleton<Dat.LibretroDatParser>();
        services.AddSingleton<Dat.LibretroDatIndexBuilder>();
        services.AddSingleton<Import.UploadFileScanner>();
        services.AddScoped<Import.GameUploadImporter>();
        services.AddSingleton<Import.UploadStagingStore>();
        return services;
    }
}
