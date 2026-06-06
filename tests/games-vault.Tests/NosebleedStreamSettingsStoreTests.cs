using games_vault.Nosebleed;

namespace games_vault.Tests;

public sealed class NosebleedStreamSettingsStoreTests
{
    [Fact]
    public void Store_Normalizes_And_Persists_Stream_Settings()
    {
        var tempDir = Path.Combine(Path.GetTempPath(), $"games-vault-stream-settings-{Guid.NewGuid():N}");
        try
        {
            var store = new NosebleedStreamSettingsStore(Path.Combine(tempDir, "settings.json"));

            var saved = store.Save(new NosebleedStreamSettings
            {
                PreferredVideoTransport = "websocket",
                WebSocketVideoCompression = "raw",
                WebRtcVideoEncoder = " vp8_vaapi ",
                WebRtcVideoEncoderArgs = " -vaapi_device /dev/dri/renderD128 ",
                FfmpegBinary = " /usr/local/bin/ffmpeg "
            });
            var loaded = store.Get();

            Assert.Equal("websocket", saved.PreferredVideoTransport);
            Assert.Equal("raw", loaded.WebSocketVideoCompression);
            Assert.Equal("vp8_vaapi", loaded.WebRtcVideoEncoder);
            Assert.Equal("-vaapi_device /dev/dri/renderD128", loaded.WebRtcVideoEncoderArgs);
            Assert.Equal("/usr/local/bin/ffmpeg", loaded.FfmpegBinary);
        }
        finally
        {
            if (Directory.Exists(tempDir))
            {
                Directory.Delete(tempDir, recursive: true);
            }
        }
    }

    [Fact]
    public void Store_Falls_Back_To_Safe_Defaults_For_Invalid_Values()
    {
        var settings = new NosebleedStreamSettings
        {
            PreferredVideoTransport = "garbage",
            WebSocketVideoCompression = "garbage",
            WebRtcVideoEncoder = " ",
            FfmpegBinary = " ",
            WebRtcVideoEncoderArgs = " "
        };

        settings.Normalize();

        Assert.Equal("webrtc-track", settings.PreferredVideoTransport);
        Assert.Equal("balanced", settings.WebSocketVideoCompression);
        Assert.Equal("libvpx", settings.WebRtcVideoEncoder);
        Assert.Equal("ffmpeg", settings.FfmpegBinary);
        Assert.Null(settings.WebRtcVideoEncoderArgs);
    }
}
