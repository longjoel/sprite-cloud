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
                PreferredVideoTransport = "websocket"
            });
            var loaded = store.Get();

            Assert.Equal("webrtc-track", saved.PreferredVideoTransport);
            Assert.Equal("webrtc-track", loaded.PreferredVideoTransport);
        }
        finally
        {
            if (Directory.Exists(tempDir))
            {
                Directory.Delete(tempDir, recursive: true);
            }
        }
    }
}
