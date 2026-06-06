using System.Text.Json;
using Microsoft.AspNetCore.Hosting;

namespace games_vault.Nosebleed;

public sealed class NosebleedStreamSettings
{
    public const string TransportWebRtcTrack = "webrtc-track";
    public const string TransportWebRtcDataChannel = "webrtc";
    public const string TransportWebSocket = "websocket";

    public const string CompressionRaw = "raw";
    public const string CompressionCrisp = "crisp";
    public const string CompressionBalanced = "balanced";
    public const string CompressionCompact = "compact";

    public string PreferredVideoTransport { get; set; } = TransportWebRtcTrack;
    public string WebSocketVideoCompression { get; set; } = CompressionBalanced;
    public string WebRtcVideoEncoder { get; set; } = "libvpx";
    public string? WebRtcVideoEncoderArgs { get; set; }
    public string FfmpegBinary { get; set; } = "ffmpeg";

    public static IReadOnlySet<string> AllowedVideoTransports { get; } = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        TransportWebRtcTrack,
        TransportWebRtcDataChannel,
        TransportWebSocket
    };

    public static IReadOnlySet<string> AllowedWebSocketCompressions { get; } = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        CompressionRaw,
        CompressionCrisp,
        CompressionBalanced,
        CompressionCompact
    };

    public void Normalize()
    {
        PreferredVideoTransport = NormalizeVideoTransport(PreferredVideoTransport);
        WebSocketVideoCompression = NormalizeWebSocketCompression(WebSocketVideoCompression);
        WebRtcVideoEncoder = string.IsNullOrWhiteSpace(WebRtcVideoEncoder) ? "libvpx" : WebRtcVideoEncoder.Trim();
        FfmpegBinary = string.IsNullOrWhiteSpace(FfmpegBinary) ? "ffmpeg" : FfmpegBinary.Trim();
        WebRtcVideoEncoderArgs = string.IsNullOrWhiteSpace(WebRtcVideoEncoderArgs) ? null : WebRtcVideoEncoderArgs.Trim();
    }

    public static string NormalizeVideoTransport(string? value)
    {
        value = value?.Trim();
        return !string.IsNullOrWhiteSpace(value) && AllowedVideoTransports.Contains(value)
            ? value
            : TransportWebRtcTrack;
    }

    public static string NormalizeWebSocketCompression(string? value)
    {
        value = value?.Trim();
        return !string.IsNullOrWhiteSpace(value) && AllowedWebSocketCompressions.Contains(value)
            ? value
            : CompressionBalanced;
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
        WebSocketVideoCompression = settings.WebSocketVideoCompression,
        WebRtcVideoEncoder = settings.WebRtcVideoEncoder,
        WebRtcVideoEncoderArgs = settings.WebRtcVideoEncoderArgs,
        FfmpegBinary = settings.FfmpegBinary
    };
}
