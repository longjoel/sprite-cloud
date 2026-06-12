using System.Collections.ObjectModel;

namespace games_vault.BackgroundJobs;

public sealed class BackgroundJobCommandRegistry(IReadOnlyDictionary<string, Type> commandTypesByName)
{
    public IReadOnlyDictionary<string, Type> CommandTypesByName { get; } =
        new ReadOnlyDictionary<string, Type>(new Dictionary<string, Type>(commandTypesByName, StringComparer.OrdinalIgnoreCase));

    public bool TryGetCommandType(string commandName, out Type commandType) =>
        CommandTypesByName.TryGetValue(commandName, out commandType!);
}
