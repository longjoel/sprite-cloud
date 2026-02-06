namespace games_vault.Libretro;

public static class Crc32
{
    private static readonly uint[] Table = BuildTable();

    public static async Task<uint> ComputeAsync(Stream stream, CancellationToken cancellationToken)
    {
        if (stream is null) throw new ArgumentNullException(nameof(stream));

        uint crc = 0xFFFFFFFF;
        var buffer = new byte[1024 * 64];

        while (true)
        {
            var read = await stream.ReadAsync(buffer, cancellationToken);
            if (read <= 0)
            {
                break;
            }

            crc = Update(crc, buffer.AsSpan(0, read));
        }

        return ~crc;
    }

    public static uint Update(uint crc, ReadOnlySpan<byte> data)
    {
        var c = crc;
        for (var i = 0; i < data.Length; i++)
        {
            c = (c >> 8) ^ Table[(c ^ data[i]) & 0xFF];
        }

        return c;
    }

    private static uint[] BuildTable()
    {
        const uint poly = 0xEDB88320;
        var table = new uint[256];

        for (uint i = 0; i < table.Length; i++)
        {
            var c = i;
            for (var k = 0; k < 8; k++)
            {
                c = (c & 1) != 0 ? poly ^ (c >> 1) : (c >> 1);
            }

            table[i] = c;
        }

        return table;
    }
}

