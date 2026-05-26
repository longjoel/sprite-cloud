using System.Diagnostics;
using Microsoft.Extensions.Options;

namespace games_vault.Nosebleed;

public sealed class NosebleedProcessInspector(IOptions<NosebleedOptions> options)
{
    private readonly NosebleedOptions _options = options.Value ?? new NosebleedOptions();

    public IReadOnlyList<NosebleedProcessSnapshot> GetOrphanProcesses(IEnumerable<int>? managedPids = null)
    {
        var excluded = managedPids is null ? new HashSet<int>() : new HashSet<int>(managedPids);
        var snapshots = new List<NosebleedProcessSnapshot>();

        if (!OperatingSystem.IsLinux() || !Directory.Exists("/proc"))
        {
            return snapshots;
        }

        foreach (var procDir in Directory.EnumerateDirectories("/proc"))
        {
            var name = Path.GetFileName(procDir);
            if (!int.TryParse(name, out var pid) || excluded.Contains(pid))
            {
                continue;
            }

            var args = ReadProcCmdline(pid);
            if (args.Count == 0 || !IsNosebleedCommand(args, _options.BinaryPath))
            {
                continue;
            }

            var parsed = ParseArguments(args);
            snapshots.Add(new NosebleedProcessSnapshot(
                pid,
                args[0],
                string.Join(' ', args),
                parsed.SessionId,
                parsed.Listen,
                ExtractPort(parsed.Listen),
                parsed.CorePath,
                parsed.ContentPath));
        }

        return snapshots.OrderBy(x => x.ProcessId).ToList();
    }

    public bool TryKillIfNosebleed(int pid)
    {
        var args = ReadProcCmdline(pid);
        if (args.Count == 0 || !IsKillableNosebleedCommand(args, _options.BinaryPath))
        {
            return false;
        }

        try
        {
            using var process = Process.GetProcessById(pid);
            if (process.HasExited)
            {
                return false;
            }

            var revalidatedArgs = ReadProcCmdline(pid);
            if (revalidatedArgs.Count == 0 || !IsKillableNosebleedCommand(revalidatedArgs, _options.BinaryPath))
            {
                return false;
            }

            process.Kill(entireProcessTree: true);
            return true;
        }
        catch
        {
            return false;
        }
    }

    public static NosebleedParsedArguments ParseArguments(IReadOnlyList<string> args)
    {
        string? listen = null;
        string? sessionId = null;
        string? core = null;
        string? content = null;

        for (var i = 0; i < args.Count; i++)
        {
            var rawArg = args[i];
            var equalsIndex = rawArg.IndexOf('=', StringComparison.Ordinal);
            var arg = equalsIndex >= 0 ? rawArg[..equalsIndex] : rawArg;
            var value = GetFlagValue(args, ref i);
            switch (arg)
            {
                case "--listen":
                    listen = value;
                    break;
                case "--session-id":
                    sessionId = value;
                    break;
                case "--core":
                    core = value;
                    break;
                case "--content":
                    content = value;
                    break;
            }
        }

        return new NosebleedParsedArguments(listen, sessionId, core, content);
    }

    public static bool IsNosebleedCommand(IReadOnlyList<string> args, string? configuredBinaryPath)
    {
        if (args.Count == 0)
        {
            return false;
        }

        var executable = args[0];
        if (!string.IsNullOrWhiteSpace(configuredBinaryPath))
        {
            try
            {
                if (string.Equals(Path.GetFullPath(executable), Path.GetFullPath(configuredBinaryPath), StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
            catch
            {
                if (string.Equals(executable, configuredBinaryPath, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
        }

        if (string.Equals(Path.GetFileNameWithoutExtension(executable), "nosebleed", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        var parsed = ParseArguments(args);
        return parsed.SessionId?.StartsWith("games-vault-", StringComparison.OrdinalIgnoreCase) == true;
    }

    public static bool IsKillableNosebleedCommand(IReadOnlyList<string> args, string? configuredBinaryPath)
    {
        if (args.Count == 0)
        {
            return false;
        }

        if (!string.IsNullOrWhiteSpace(configuredBinaryPath) && PathsEqual(args[0], configuredBinaryPath))
        {
            return true;
        }

        var parsed = ParseArguments(args);
        return parsed.SessionId?.StartsWith("games-vault-", StringComparison.OrdinalIgnoreCase) == true &&
               !string.IsNullOrWhiteSpace(parsed.Listen) &&
               !string.IsNullOrWhiteSpace(parsed.CorePath) &&
               !string.IsNullOrWhiteSpace(parsed.ContentPath);
    }

    public static int? ExtractPort(string? listen)
    {
        if (string.IsNullOrWhiteSpace(listen))
        {
            return null;
        }

        var value = listen.Trim();
        var colonIndex = value.LastIndexOf(':');
        if (colonIndex >= 0 && colonIndex < value.Length - 1)
        {
            value = value[(colonIndex + 1)..];
        }

        return int.TryParse(value, out var port) && port is > 0 and <= 65535 ? port : null;
    }

    private static string? GetFlagValue(IReadOnlyList<string> args, ref int index)
    {
        var arg = args[index];
        var equalsIndex = arg.IndexOf('=', StringComparison.Ordinal);
        if (equalsIndex >= 0)
        {
            return arg[(equalsIndex + 1)..];
        }

        if (index + 1 < args.Count && !args[index + 1].StartsWith("--", StringComparison.Ordinal))
        {
            index++;
            return args[index];
        }

        return null;
    }

    private static bool PathsEqual(string left, string right)
    {
        try
        {
            return string.Equals(Path.GetFullPath(left), Path.GetFullPath(right), StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return string.Equals(left, right, StringComparison.OrdinalIgnoreCase);
        }
    }

    private static IReadOnlyList<string> ReadProcCmdline(int pid)
    {
        try
        {
            var path = $"/proc/{pid}/cmdline";
            var bytes = File.ReadAllBytes(path);
            return bytes.Length == 0
                ? []
                : System.Text.Encoding.UTF8.GetString(bytes)
                    .Split('\0', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        }
        catch
        {
            return [];
        }
    }
}

public sealed record NosebleedParsedArguments(
    string? Listen,
    string? SessionId,
    string? CorePath,
    string? ContentPath);

public sealed record NosebleedProcessSnapshot(
    int ProcessId,
    string ExecutablePath,
    string CommandLine,
    string? SessionId,
    string? Listen,
    int? Port,
    string? CorePath,
    string? ContentPath);
