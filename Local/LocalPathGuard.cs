namespace games_vault.Local;

public static class LocalPathGuard
{
    public static string NormalizeRoot(string rootPath)
    {
        if (string.IsNullOrWhiteSpace(rootPath))
        {
            throw new InvalidOperationException("Root path is required.");
        }

        var root = Path.GetFullPath(rootPath.Trim());
        root = root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        return root;
    }

    public static string NormalizeAndValidateFilePath(string rootPath, string fullPath)
    {
        var root = NormalizeRoot(rootPath);

        if (string.IsNullOrWhiteSpace(fullPath))
        {
            throw new InvalidOperationException("File path is required.");
        }

        var normalized = Path.GetFullPath(fullPath.Trim());
        if (!normalized.StartsWith(root, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("File path is not within the configured root folder.");
        }

        return normalized;
    }
}

