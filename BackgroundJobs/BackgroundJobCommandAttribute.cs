namespace games_vault.BackgroundJobs;

[AttributeUsage(AttributeTargets.Class, AllowMultiple = false)]
public sealed class BackgroundJobCommandAttribute(string name) : Attribute
{
    public string Name { get; } = name;
}
