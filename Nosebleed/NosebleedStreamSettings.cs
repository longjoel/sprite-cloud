using System.Text.Json;
using Microsoft.AspNetCore.Hosting;

namespace games_vault.Nosebleed;

public sealed class NosebleedStreamSettings
{
    public const string TransportWebRtcTrack = "webrtc-track";

    public const string MediaBackendGstreamer = "gstreamer";

    public string PreferredVideoTransport { get; set; } = TransportWebRtcTrack;
    public string MediaBackend { get; set; } = MediaBackendGstreamer;

    public static IReadOnlySet<string> AllowedMediaBackends { get; } = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        MediaBackendGstreamer
    };

    public void Normalize()
    {
        PreferredVideoTransport = NormalizeVideoTransport(PreferredVideoTransport);
        MediaBackend = NormalizeMediaBackend(MediaBackend);
    }

    public static string NormalizeVideoTransport(string? value)
    {
        return TransportWebRtcTrack;
    }

    public static string NormalizeMediaBackend(string? _)
    {
        return MediaBackendGstreamer;
    }
}

public sealed class NosebleedStreamSettingsStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true
    };

    private readonly string _settingsPath;
    private readonly object _lock = new();

    public NosebleedStreamSettingsStore(IWebHostEnvironment environment)
        : this(Path.Combine("/var/lib/games-vault", "nosebleed-stream-settings.json"))
    {
        _ = environment;
    }

    public NosebleedStreamSettingsStore(string settingsPath)
    {
        _settingsPath = settingsPath;
    }

    public NosebleedStreamSettings Get()
    {
        lock (_lock)
        {
            return ReadUnsafe();
        }
    }

    public NosebleedStreamSettings Save(NosebleedStreamSettings settings)
    {
        if (settings is null) throw new ArgumentNullException(nameof(settings));

        lock (_lock)
        {
            settings.Normalize();
            Directory.CreateDirectory(Path.GetDirectoryName(_settingsPath) ?? ".");
            File.WriteAllText(_settingsPath, JsonSerializer.Serialize(settings, JsonOptions));
            return Clone(settings);
        }
    }

    private NosebleedStreamSettings ReadUnsafe()
    {
        if (!File.Exists(_settingsPath))
        {
            return new NosebleedStreamSettings();
        }

        try
        {
            var settings = JsonSerializer.Deserialize<NosebleedStreamSettings>(File.ReadAllText(_settingsPath), JsonOptions)
                ?? new NosebleedStreamSettings();
            settings.Normalize();
            return settings;
        }
        catch (JsonException)
        {
            return new NosebleedStreamSettings();
        }
        catch (IOException)
        {
            return new NosebleedStreamSettings();
        }
    }

    private static NosebleedStreamSettings Clone(NosebleedStreamSettings settings) => new()
    {
        PreferredVideoTransport = settings.PreferredVideoTransport,
        MediaBackend = settings.MediaBackend
    };
}
