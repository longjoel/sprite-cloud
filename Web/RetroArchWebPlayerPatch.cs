using System.Text;
using Microsoft.Extensions.Logging;

namespace games_vault.Web;

public static class RetroArchWebPlayerPatch
{
    public const string Marker = "games-vault:retroarch-webplayer-sync:v5";

    public static void ApplyToFolder(string webPlayerRoot, ILogger logger)
    {
        if (string.IsNullOrWhiteSpace(webPlayerRoot))
        {
            throw new ArgumentException("Web player root is required.", nameof(webPlayerRoot));
        }

        var root = Path.GetFullPath(webPlayerRoot);
        if (!Directory.Exists(root))
        {
            throw new DirectoryNotFoundException(root);
        }

        var libretroJs = Path.Combine(root, "libretro.js");
        if (!File.Exists(libretroJs))
        {
            logger.LogWarning("Web player patch skipped: missing libretro.js at {Path}", libretroJs);
            return;
        }

        var text = File.ReadAllText(libretroJs, Encoding.UTF8);
        if (text.Contains(Marker, StringComparison.Ordinal))
        {
            return;
        }

        // If an older patch is present, replace it in-place to avoid leaving broken JS behind.
        var anyMarker = "games-vault:retroarch-webplayer-sync:";
        var oldIdx = text.IndexOf(anyMarker, StringComparison.Ordinal);
        if (oldIdx >= 0)
        {
            // The patch is appended; truncate from the start of the marker comment line.
            var start = text.LastIndexOf('\n', oldIdx);
            if (start < 0) start = 0;
            text = text[..start].TrimEnd() + "\n";
            File.WriteAllText(libretroJs, text + BuildPatchJs(), Encoding.UTF8);
            logger.LogInformation("Upgraded RetroArch web player save-sync patch.");
            return;
        }

        File.AppendAllText(libretroJs, "\n" + BuildPatchJs(), Encoding.UTF8);
        logger.LogInformation("Applied RetroArch web player save-sync patch.");
    }

    private static string BuildPatchJs()
    {
        // This patch intentionally avoids modifying existing functions. It wraps preLoadingComplete to:
        // 1) Restore server-synced userdata into the BrowserFS mount (Module.FS)
        // 2) Start periodic uploads of all userdata files to the server
        // The wrapper page controls when RetroArch starts; we only prep/flush data.
        return """
// games-vault:retroarch-webplayer-sync:v5
(function () {
  function qs() { try { return new URLSearchParams(window.location.search); } catch { return null; } }
  function getCfg() {
    var p = qs(); if (!p) return null;
    var gameId = parseInt(p.get("gameId") || "", 10);
    var savesList = p.get("savesList") || "";
    var savesPut = p.get("savesPut") || "";
    var csrfUrl = p.get("csrf") || "";
    if (!Number.isFinite(gameId) || gameId <= 0) return null;
    if (!savesList || !savesPut || !csrfUrl) return null;
    return { gameId: gameId, savesList: savesList, savesPut: savesPut, csrfUrl: csrfUrl };
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function ensureDir(path) {
    try { Module.FS.mkdir(path); } catch { }
  }

  function ensureDirsForFile(absPath) {
    var parts = absPath.split("/").filter(Boolean);
    var cur = "";
    for (var i = 0; i < parts.length - 1; i++) {
      cur += "/" + parts[i];
      ensureDir(cur);
    }
  }

  function isDir(path) {
    try {
      var st = Module.FS.stat(path);
      return st && Module.FS.isDir && Module.FS.isDir(st.mode);
    } catch { return false; }
  }

  function isFile(path) {
    try {
      var st = Module.FS.stat(path);
      return st && Module.FS.isFile && Module.FS.isFile(st.mode);
    } catch { return false; }
  }

  function listDir(path) {
    try { return Module.FS.readdir(path).filter(function (n) { return n !== "." && n !== ".."; }); } catch { return []; }
  }

  function readFileU8(path) {
    return Module.FS.readFile(path, { encoding: "binary" });
  }

  function stat(path) {
    try { return Module.FS.stat(path); } catch { return null; }
  }

  async function getToken(cfg) {
    var res = await fetch(cfg.csrfUrl, { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) throw new Error("csrf token fetch failed: " + res.status);
    var json = await res.json();
    return json && json.token ? String(json.token) : "";
  }

  async function restoreAll(cfg) {
    var res = await fetch(cfg.savesList, { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) throw new Error("saves list fetch failed: " + res.status);
    var json = await res.json();
    var items = (json && json.items) ? json.items : [];
    if (!Array.isArray(items) || items.length === 0) return;

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || it.kind !== "userdata") continue;
      var key = it.key || "default";
      var fileName = it.fileName || it.file_name || it.name || "";
      var url = it.url || "";
      if (!fileName || !url) continue;

      var rel = (key === "default" ? "" : String(key).replace(/^\/+/, "").replace(/\/+$/, "")) + (key === "default" ? "" : "/") + fileName;
      var abs = "/home/web_user/retroarch/userdata/games-vault/" + cfg.gameId + "/" + rel;
      ensureDirsForFile(abs);

      var fr = await fetch(url, { cache: "no-store", credentials: "same-origin" });
      if (!fr.ok) continue;
      var buf = await fr.arrayBuffer();
      var u8 = new Uint8Array(buf);
      try {
        Module.FS.writeFile(abs, u8, { encoding: "binary" });
      } catch { }
    }
  }

  function collectFiles(rootPath) {
    var out = [];
    function walk(dir) {
      var names = listDir(dir);
      for (var i = 0; i < names.length; i++) {
        var p = dir.replace(/\/+$/, "") + "/" + names[i];
        if (isDir(p)) walk(p);
        else out.push(p);
      }
    }
    walk(rootPath);
    return out;
  }

  function toKeyAndName(absPath) {
    var prefix = "/home/web_user/retroarch/userdata/games-vault/" + cfg.gameId + "/";
    var rel = absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath.replace(/^\/+/, "");
    var parts = rel.split("/").filter(Boolean);
    if (parts.length === 0) return { key: "default", name: "file.bin" };
    var name = parts[parts.length - 1];
    var key = parts.length > 1 ? parts.slice(0, -1).join("/") : "default";
    return { key: key, name: name };
  }

  var lastSig = new Map();

  function sigFor(path) {
    var st = stat(path);
    if (!st) return "";
    var m = st.mtime ? (new Date(st.mtime).getTime()) : 0;
    return String(st.size) + ":" + String(m);
  }

  async function uploadFile(cfg, token, absPath) {
    var kn = toKeyAndName(absPath);
    var bytes = readFileU8(absPath);
    var blob = new Blob([bytes], { type: "application/octet-stream" });
    var fd = new FormData();
    fd.append("gameId", String(cfg.gameId));
    fd.append("kind", "userdata");
    fd.append("key", kn.key);
    fd.append("fileName", kn.name);
    fd.append("file", blob, kn.name);

      var res = await fetch(cfg.savesPut, {
        method: "POST",
        body: fd,
        cache: "no-store",
        credentials: "same-origin",
        headers: { "RequestVerificationToken": token }
      });

    if (!res.ok) throw new Error("upload failed: " + res.status);
  }

  async function syncOnce(cfg, token) {
    var root = "/home/web_user/retroarch/userdata/games-vault/" + cfg.gameId;
    var files = collectFiles(root);
    for (var i = 0; i < files.length; i++) {
      var p = files[i];
      if (!isFile(p)) continue;
      var sig = sigFor(p);
      if (!sig) continue;
      if (lastSig.get(p) === sig) continue;
      try {
        await uploadFile(cfg, token, p);
        lastSig.set(p, sig);
      } catch (e) {
        console.warn("games-vault: save upload failed", p, e);
      }
    }
  }

  function installSync(cfg) {
    if (window.__gamesVaultSaveSyncInstalled) return;
    window.__gamesVaultSaveSyncInstalled = true;

    var token = "";
    var syncing = false;

    async function ensureToken() {
      if (token) return token;
      token = await getToken(cfg);
      return token;
    }

    async function tick() {
      if (syncing) return;
      syncing = true;
      try {
        await ensureToken();
        await syncOnce(cfg, token);
      } finally {
        syncing = false;
      }
    }

    // periodic + on background/unload
    setInterval(function () { tick().catch(function () { }); }, 10000);
    document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") tick().catch(function () { }); });
    window.addEventListener("beforeunload", function () { try { tick(); } catch { } });
  }

  function hookPreLoadingComplete() {
    var cfg = getCfg();
    if (!cfg) return;

    var original = window.preLoadingComplete;
    window.preLoadingComplete = function () {
      try { if (typeof original === "function") original(); } catch { }

      (async function () {
        // Wait for Module/FS to exist (it will by the time preLoadingComplete is called, but be defensive).
        for (var i = 0; i < 200; i++) {
          if (window.Module && window.Module.FS) break;
          await sleep(50);
        }
        if (!window.Module || !window.Module.FS) return;

        // Restore once per page.
        if (!window.__gamesVaultSaveSyncRestored) {
          window.__gamesVaultSaveSyncRestored = true;
          try { await restoreAll(cfg); } catch (e) { console.warn("games-vault: restore failed", e); }
        }

        // Start upload loop.
        try { installSync(cfg); } catch { }
      })();
    };
  }

  // Install hook immediately (libretro.js is loaded before the wrapper script).
  hookPreLoadingComplete();
})();
""";
    }
}
