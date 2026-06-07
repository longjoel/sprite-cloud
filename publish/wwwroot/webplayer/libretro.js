/**
 * RetroArch Web Player
 *
 * This provides the basic JavaScript for the RetroArch web player.
 */

const defaultCore = "gambatte";
var autoStart = false;

var BrowserFS = BrowserFS;
var afs;
var zipfs;
var xhrfs;
var initializationCount = 0;
var Module;
var currentCore;
var reloadTimeout;
var retroArchRunning = false;
var canvas = document.getElementById("canvas");

function modulePreRun(module) {
   module.ENV["LIBRARY_PATH"] = module.corePath;
}

var ModuleBase = {
   noInitialRun: true,
   retroArchSend: function(msg) {
      this.EmscriptenSendCommand(msg);
   },
   retroArchRecv: function() {
      return this.EmscriptenReceiveCommandReply();
   },
   retroArchExit: function(core, content) {
      relaunch(core, content);
   },
   print: function(text) {
      console.log("stdout:", text);
   },
   printErr: function(text) {
      console.log("stderr:", text);
   },
   canvas: canvas
};

function cleanupStorage() {
   localStorage.clear();
   if (BrowserFS.FileSystem.IndexedDB.isAvailable()) {
      var req = indexedDB.deleteDatabase("RetroArch");
      req.onsuccess = function() {
         console.log("Deleted database successfully");
      };
      req.onerror = function() {
         console.error("Couldn't delete database");
      };
      req.onblocked = function() {
         console.error("Couldn't delete database due to the operation being blocked");
      };
   }

   document.getElementById("btnClean").disabled = true;
}

function idbfsInit() {
   var imfs = new BrowserFS.FileSystem.InMemory();
   if (BrowserFS.FileSystem.IndexedDB.isAvailable()) {
      BrowserFS.FileSystem.IndexedDB.Create({storeName: "RetroArch"}, function(e, idbfs) {
         if (e) {
            // fallback to imfs
            afs = new BrowserFS.FileSystem.InMemory();
            console.error("WEBPLAYER: error (idbfs): " + e + " falling back to in-memory filesystem");
            appInitialized();
         } else {
            // initialize afs by copying files from async storage to sync storage.
            BrowserFS.FileSystem.AsyncMirror.Create({sync: imfs, async: idbfs}, function(e, fs) {
               if (e) {
                  afs = new BrowserFS.FileSystem.InMemory();
                  console.error("WEBPLAYER: error (afs): " + e + " falling back to in-memory filesystem");
                  appInitialized();
               } else {
                  afs = fs;
                  console.log("WEBPLAYER: idbfs setup successful");
                  appInitialized();
               }
            });
         }
      });
   } else {
      afs = new BrowserFS.FileSystem.InMemory();
      console.error("WEBPLAYER: idbfs not available; falling back to in-memory filesystem");
      appInitialized();
   }
}

function zipfsInit() {
   // 256 MB max bundle size
   let buffer = new ArrayBuffer(256 * 1024 * 1024);
   let bufferView = new Uint8Array(buffer);
   let idx = 0;
   // bundle should be in five parts (this can be changed later)
   Promise.all([fetch("assets/frontend/bundle.zip.aa"),
      fetch("assets/frontend/bundle.zip.ab"),
      fetch("assets/frontend/bundle.zip.ac"),
      fetch("assets/frontend/bundle.zip.ad"),
      fetch("assets/frontend/bundle.zip.ae")
   ]).then(function(resps) {
      Promise.all(resps.map((r) => r.arrayBuffer())).then(function(buffers) {
         for (let buf of buffers) {
            if (idx + buf.byteLength > buffer.maxByteLength) {
               console.error("WEBPLAYER: error: bundle.zip is too large");
            }
            bufferView.set(new Uint8Array(buf), idx, buf.byteLength);
            idx += buf.byteLength;
         }
         // create a ZipFS filesystem for the bundled data
         BrowserFS.FileSystem.ZipFS.Create({zipData: BrowserFS.BFSRequire('buffer').Buffer(new Uint8Array(buffer, 0, idx))}, function(e, fs) {
            if (e) {
               zipfs = new BrowserFS.FileSystem.InMemory();
               console.error("WEBPLAYER: error (zipfs): " + e + " falling back to in-memory filesystem");
               appInitialized();
            } else {
               zipfs = fs;
               console.log("WEBPLAYER: zipfs setup successful");
               appInitialized();
            }
         });
      })
   });
}

function xhrfsInit() {
   // create an XmlHttpRequest filesystem for core assets
   BrowserFS.FileSystem.XmlHttpRequest.Create({baseUrl: "assets/cores/", index: "assets/cores/.index-xhr"}, function(e, fs) {
      if (e) {
         xhrfs = new BrowserFS.FileSystem.InMemory();
         console.error("WEBPLAYER: error (xhrfs): " + e + " falling back to in-memory filesystem");
         appInitialized();
      } else {
         xhrfs = fs;
         console.log("WEBPLAYER: xhrfs setup successful");
         appInitialized();
      }
   });
}

function appInitialized() {
   /* Need to wait for the file system, the wasm runtime, and the zip download
      to complete before enabling the Run button. */
   initializationCount++;
   if (initializationCount == 4) {
      finishFileSystemSetup();
      preLoadingComplete();
   }
}

function preLoadingComplete() {
   $('#icnRun').removeClass('fa-spinner').removeClass('fa-spin');
   $('#icnRun').addClass('fa-play');

   if (autoStart) {
      startRetroArch();
   } else {
      // Make the Preview image clickable to start RetroArch.
      $('.webplayer-preview').addClass('loaded').click(function() {
         startRetroArch();
      });
      $('#btnRun').removeClass('disabled').removeAttr("disabled").click(function() {
         startRetroArch();
      });
   }
}

function mountBrowserFS() {
   var BFS = new BrowserFS.EmscriptenFS(Module.FS, Module.PATH, Module.ERRNO_CODES);
   Module.FS.mount(BFS, {
      root: '/home'
   }, '/home');

   // create fake core files for RetroArch
   Module.FS.writeFile("/home/web_user/retroarch/cores/" + currentCore + "_libretro.core", new Uint8Array());
   for (let core of Object.keys(libretroCores)) {
      Module.FS.writeFile("/home/web_user/retroarch/cores/" + core + "_libretro.core", new Uint8Array());
   }
}

function finishFileSystemSetup() {
   // create a mountable filesystem that will server as a root mountpoint for browserfs
   var mfs = new BrowserFS.FileSystem.MountableFileSystem();

   mfs.mount('/home/web_user/retroarch', zipfs);
   mfs.mount('/home/web_user/retroarch/cores', new BrowserFS.FileSystem.InMemory());
   mfs.mount('/home/web_user/retroarch/userdata', afs);
   mfs.mount('/home/web_user/retroarch/userdata/content/downloads', xhrfs);
   BrowserFS.initialize(mfs);
   mountBrowserFS();

   console.log("WEBPLAYER: filesystem initialization successful");
}

function startRetroArch() {
   $('.webplayer').show();
   $('.webplayer-preview').hide();
   document.getElementById("btnRun").disabled = true;

   $('#btnAdd').removeClass("disabled").removeAttr("disabled").click(function() {
      $('#btnRom').click();
   });
   $('#btnRom').removeAttr("disabled").change(function(e) {
      selectFiles(e.target.files);
   });
   $('#btnMenu').removeClass("disabled").removeAttr("disabled").click(function() {
      Module.retroArchSend("MENU_TOGGLE");
      Module.canvas.focus();
   });
   $('#btnFullscreen').removeClass("disabled").removeAttr("disabled").click(function() {
      Module.retroArchSend("FULLSCREEN_TOGGLE");
      Module.canvas.focus();
   });

   retroArchRunning = true;
   Module.callMain(Module.arguments);
}

function selectFiles(files) {
   $('#btnAdd').addClass('disabled');
   $('#icnAdd').removeClass('fa-plus');
   $('#icnAdd').addClass('fa-spinner spinning');
   var count = files.length;

   for (var i = 0; i < count; i++) {
      filereader = new FileReader();
      filereader.file_name = files[i].name;
      filereader.readAsArrayBuffer(files[i]);
      filereader.onload = function() {
         uploadData(this.result, this.file_name)
      };
      filereader.onloadend = function(evt) {
         console.log("WEBPLAYER: file: " + this.file_name + " upload complete");
         if (evt.target.readyState == FileReader.DONE) {
            $('#btnAdd').removeClass('disabled');
            $('#icnAdd').removeClass('fa-spinner spinning');
            $('#icnAdd').addClass('fa-plus');
         }
      }
   }
}

function uploadData(data, name) {
   var dataView = new Uint8Array(data);
   Module.FS.createDataFile('/', name, dataView, true, false);

   var data = Module.FS.readFile(name, {
      encoding: 'binary'
   });
   Module.FS.writeFile('/home/web_user/retroarch/userdata/content/' + name, data, {
      encoding: 'binary'
   });
   Module.FS.unlink(name);
}

// When the browser has loaded everything.
$(function() {
   // create core list
   var coreArray = Object.entries(libretroCores);
   var coreNames = Object.values(libretroCores).sort();
   var coreSelector = document.getElementById("core-selector");
   for (let name of coreNames) {
      let a = document.createElement("a");
      a.href = ".";
      a.dataset.core = coreArray.find(i => i[1] == name)[0];
      a.textContent = name;
      a.classList.add("dropdown-item");
      coreSelector.appendChild(a);
   }

   // Enable data clear
   $('#btnClean').click(function() {
      cleanupStorage();
   });

   // Enable all available ToolTips.
   $('.tooltip-enable').tooltip({
      placement: 'right'
   });

   // Allow hiding the top menu.
   $('.showMenu').hide();
   $('#btnHideMenu, .showMenu').click(function() {
      $('nav').slideToggle('slow');
      $('.showMenu').toggle('slow');
   });

   // Attempt to disable some default browser keys.
   var keys = {
      9: "tab",
      13: "enter",
      16: "shift",
      18: "alt",
      27: "esc",
      33: "rePag",
      34: "avPag",
      35: "end",
      36: "home",
      37: "left",
      38: "up",
      39: "right",
      40: "down",
      112: "F1",
      113: "F2",
      114: "F3",
      115: "F4",
      116: "F5",
      117: "F6",
      118: "F7",
      119: "F8",
      120: "F9",
      121: "F10",
      122: "F11",
      123: "F12"
   };
   window.addEventListener('keydown', function(e) {
      if (keys[e.which]) {
         e.preventDefault();
      }
   });

   // Switch the core when selecting one.
   $('#core-selector a').click(function(e) {
      e.preventDefault();
      var core = $(this).data('core');
      if (!core) return;
      localStorage.setItem("core", core);
      if (Module && retroArchRunning) {
         Module.retroArchSend("LOAD_CORE /home/web_user/retroarch/cores/" + core + "_libretro.core");

         // maybe RetroArch crashed? reload if RetroArch doesn't exit within a second.
         if (reloadTimeout) clearTimeout(reloadTimeout);
         reloadTimeout = setTimeout(function() {
            location.reload();
         }, 1000);
      } else {
         location.reload();
      }
   });

   // Find which core to load.
   currentCore = localStorage.getItem("core") || defaultCore;
   loadCore(currentCore).then(function() {
      console.log("WEBPLAYER: wasm runtime initialized");
      appInitialized();
   });

   // Start loading the filesystem
   idbfsInit();
   zipfsInit();
   xhrfsInit();
});

async function loadCoreFallback(currentCore) {
   if (currentCore == defaultCore) {
      console.error("Error: couldn't load default core!");
      alert("Error: couldn't load default core!");
      return;
   }
   await loadCore(defaultCore);
}

async function loadCore(core, args) {
   // Make the core the selected core in the UI.
   $('#core-selector a.active').removeClass('active');
   var coreTitle = $('#core-selector a[data-core="' + core + '"]').addClass('active').text();
   $('#dropdownMenu1').text(coreTitle || core);

   ModuleBase.arguments = args || ["-v", "--menu", "-c", "/home/web_user/retroarch/userdata/retroarch.cfg"];
   ModuleBase.preRun = [modulePreRun];
   ModuleBase.canvas = canvas;
   ModuleBase.corePath = "/home/web_user/retroarch/cores/" + core + "_libretro.core";

   // Load the Core's related JavaScript.
   try {
      let script = await import("./" + core + "_libretro.js");
      try {
         Module = await script.default(Object.assign({}, ModuleBase));
      } catch (err) {
         console.error("Couldn't instantiate module", err);
         await loadCoreFallback(core);
         throw err;
      }
   } catch (err) {
      console.error("Couldn't load script", err);
      await loadCoreFallback(core);
      throw err;
   }
}

// exit/exitspawn hook
async function relaunch(core, content) {
   // force restart on exit
   if (!core) core = ModuleBase.corePath;

   if (!content) content = "--menu";

   Module = null;
   if (reloadTimeout) {
      clearTimeout(reloadTimeout);
      reloadTimeout = null;
   }

   // parse core name from full path ("/home/web_user/retroarch/cores/NAME_libretro.core")
   currentCore = core.slice(0, -14).split("/").slice(-1)[0];

   localStorage.setItem("core", currentCore);
   await loadCore(currentCore, ["-v", content, "-c", "/home/web_user/retroarch/userdata/retroarch.cfg"]);
   mountBrowserFS();
   Module.callMain(Module.arguments);
}

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