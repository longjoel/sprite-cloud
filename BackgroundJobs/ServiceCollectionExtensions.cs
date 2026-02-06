using System.Reflection;
using Microsoft.Extensions.DependencyInjection;

namespace games_vault.BackgroundJobs;

public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddBackgroundJobs(this IServiceCollection services, params Assembly[] assembliesToScan)
    {
        if (assembliesToScan.Length == 0)
        {
            assembliesToScan = [Assembly.GetExecutingAssembly()];
        }

        var map = new Dictionary<string, Type>(StringComparer.OrdinalIgnoreCase);

        foreach (var assembly in assembliesToScan)
        {
            foreach (var type in assembly.DefinedTypes)
            {
                if (type.IsAbstract || type.IsInterface)
                {
                    continue;
                }

                if (!typeof(IBackgroundJobCommand).IsAssignableFrom(type))
                {
                    continue;
                }

                var attr = type.GetCustomAttribute<BackgroundJobCommandAttribute>();
                if (attr is null)
                {
                    continue;
                }

                map[attr.Name] = type.AsType();
                services.AddScoped(type.AsType());
            }
        }

        services.AddSingleton(new BackgroundJobCommandRegistry(map));
        services.AddScoped<IBackgroundJobClient, BackgroundJobClient>();
        services.AddScoped<IInternalJobsClient, InternalJobsClient>();
        services.AddHostedService<BackgroundJobWorker>();

        return services;
    }
}
