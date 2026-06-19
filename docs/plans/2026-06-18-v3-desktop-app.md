# Games Vault v3: Desktop App — Architecture Plan

> **For Hermes:** Use `subagent-driven-development` skill to implement this plan task-by-task.

**Goal:** Ship Games Vault as a desktop application for gaming PCs with real GPUs — Windows Service / Linux AppImage / Flatpak — with GPU-accelerated encoding, zero-copy DMA-BUF rendering, and LAN discovery.

**Architecture:** New `gv-desktop` crate wraps gv-server as a system tray / service app with GPU detection and mDNS. `gv-worker` (v3) gets encoder auto-discovery replacing the hardcoded GStreamer element names from the hardware-encoding branch. `gv-web` gets encoder stats in dashboard. Packaging scripts produce MSI, AppImage, and Flatpak.

**Tech Stack:** Rust (gv-desktop, gv-worker), Tauri v2 (desktop shell), GStreamer 1.24+ (encoder probing), Avahi/mDNS (LAN discovery), Next.js (gv-web unchanged), WiX (Windows MSI), AppImageKit / flatpak-builder (Linux)

---

## Current State

| Component | What it does | Key issue |
|-----------|-------------|-----------|
| `gv-server` | CLI + daemon, spawns workers, polls gv-web | No desktop integration, no GPU awareness |
| `gv-worker-v2` | WebRTC + GStreamer VP8 encoder | Hardcoded VP8 only, no encoder discovery |
| `gv-web` | Next.js dashboard + settings | No encoder/GPU stats display |
| `libretro-runner` | Loads cores, runs frames, captures video/audio | DMA-BUF path in hardware-encoding branch is GPU-only |
| `gv-player` | Standalone embedded player page | Works, no changes needed for v3 |

**Hardware-encoding branch** (`feature/hardware-encoding-3d-acceleration`): Adds VideoCodec enum, H.264 pipeline builders, DMA-BUF push path, Xvfb auto-spawn. Has four bugs: (1) hardcoded encoder names `vah264enc`/`varenderD129h264enc` that don't exist on most systems, (2) no encoder probing/discovery, (3) no `x264enc` fallback, (4) `varenderD129h264enc` is a GStreamer development name. The architecture (DMA-BUF → VAAPI → WebRTC) is sound — it just needs the encoder layer fixed.

**Env vars today:** `GV_GST_VIDEO_*` (VP8 tuning), `GV_ICE_*` (STUN/TURN), `GV_WORKER_BIN`, `GV_HOST_TOKEN`, `GV_ALLOWED_ORIGIN`, `GV_WORKER_CONTROL_TOKEN`, `GV_XVFB`

**gv-web pages:** Dashboard (game library), Settings (server config), Player (WebRTC stream), Dev (test tools)

---

## v3 Crate Map

```
monorepo/
├── gv-desktop/          NEW — desktop app wrapper
│   ├── src/
│   │   ├── main.rs           Tauri entry point (system tray + window)
│   │   ├── service.rs        Windows Service / systemd integration
│   │   ├── gpu.rs            GPU detection (Vulkan, VAAPI, NVENC, AMF)
│   │   ├── mdns.rs           mDNS LAN discovery broadcaster
│   │   ├── encoder_probe.rs  GStreamer encoder capability probe
│   │   └── tray.rs           System tray icon + menu
│   ├── Cargo.toml
│   └── tauri.conf.json
│
├── gv-server/           MODIFIED — minor additions
│   └── src/
│       └── main.rs           Adds --desktop flag, forwards GPU/encoder metadata
│
├── gv-worker/            RENAMED from gv-worker-v2
│   └── src/
│       ├── config.rs         Adds GV_GST_VIDEO_CODEC, H264_ENCODER, encoder probe result
│       ├── gst_video.rs      Encoder discovery: build_h264_pipeline probes available encoders
│       ├── gpu_probe.rs  NEW GPU capability detection at worker startup
│       └── main_body.rs      Codec negotiation from SDP offer, H.264 track setup
│
├── libretro-runner/      MINOR addition
│   └── src/
│       └── runner.rs         GPU context type reporting in CoreHandle
│
├── gv-web/               MODIFIED — dashboard additions
│   ├── app/dashboard/        GPU/encoder status card
│   └── app/settings/         Encoder selection UI
│
├── gv-player/            UNCHANGED
│
├── scripts/
│   ├── build-appimage.sh NEW
│   ├── build-msi.ps1    NEW
│   └── build-flatpak.sh NEW
│
└── Cargo.toml            Add gv-desktop to workspace members
```

---

## Security model (baked into each task)

| Threat | Mitigation | Where |
|--------|-----------|-------|
| GPU/encoder probe runs arbitrary GStreamer pipelines | Probe uses `gst::ElementFactory::find()` only — no pipeline launch | Task 4 |
| mDNS broadcasts expose server to network | Namespace under `_gamesvault._tcp`, include pairing token hash only | Task 6 |
| Service runs as root | Windows: LocalService account; Linux: user systemd unit, not root | Task 5 |
| Desktop app opens port to LAN | Bind to 127.0.0.1 by default; LAN binding is opt-in via settings | Task 5 |

---

## Phase 1: Encoder Foundation (the branch's bugs, fixed)

### Task 1: Rename gv-worker-v2 → gv-worker

**Objective:** Rename crate, update all references, Cargo workspace.

**Files:**
- Rename: `gv-worker-v2/` → `gv-worker/`
- Modify: `Cargo.toml` — update workspace members, rename dep in gv-server
- Modify: `gv-server/src/worker.rs` — update binary name references
- Modify: `scripts/dev-start.sh` — update binary name
- Modify: `Dockerfile` — update build target
- Modify: `docker-compose*.yml` — update image/container names

**Acceptance criteria:**
- `cargo build -p gv-worker` succeeds
- `cargo build -p gv-server` succeeds (gv-server depends on gv-worker)
- `./scripts/dev-start.sh build` succeeds
- No references to `gv-worker-v2` remain in source (grep -r)

### Task 2: Port VideoCodec enum + config from hardware-encoding branch

**Objective:** Bring the `VideoCodec` enum and `GV_GST_VIDEO_CODEC` / `GV_GST_VIDEO_H264_ENCODER` env vars from the hardware-encoding branch into v3, clean.

**Files:**
- Modify: `gv-worker/src/config.rs` — add `VideoCodecPreference` enum, `gst_video_codec()`, `gst_video_h264_encoder()`
- Modify: `gv-worker/src/gst_video.rs` — add `VideoCodec` enum, `codec()` method, `new_with_codec()` constructor

**What to bring (from `feature/hardware-encoding-3d-acceleration`):**
```rust
// config.rs
pub enum VideoCodecPreference { Auto, Vp8, H264 }
pub fn gst_video_codec() -> VideoCodecPreference { /* GV_GST_VIDEO_CODEC */ }
pub fn gst_video_h264_encoder() -> String { /* GV_GST_VIDEO_H264_ENCODER */ }

// gst_video.rs
pub enum VideoCodec { Vp8, H264 }
impl GstVideoEncoder {
    pub fn new_with_codec(w, h, fps, codec) -> Result<Self, String>
    pub fn codec(&self) -> VideoCodec
}
```

**What NOT to bring:** The `build_h264_pipeline` and `build_hardware_h264_pipeline` functions (they have the hardcoded encoder names — Task 4 rewrites them). The DMA-BUF push method (comes in Task 8). Do NOT port `push_dmabuf` yet.

**Acceptance criteria:**
- `cargo build -p gv-worker` succeeds
- Existing VP8 encoder path still works: `cargo test -p gv-worker`
- `GV_GST_VIDEO_CODEC=vp8` selects VP8, `GV_GST_VIDEO_CODEC=h264` selects H.264 (enum parse only, no pipeline yet)

### Task 3: Add GStreamer encoder probing utility

**Objective:** New function that queries GStreamer for available H.264 encoders at startup, returning a ranked list. Replaces hardcoded `["vah264enc", "varenderD129h264enc"]`.

**Files:**
- Create: `gv-worker/src/encoder_probe.rs`
- Modify: `gv-worker/src/lib.rs` — add `pub mod encoder_probe`

**Implementation:**
```rust
// gv-worker/src/encoder_probe.rs

use gstreamer as gst;
use gstreamer::prelude::*;

/// An available H.264 encoder, ranked by preference.
#[derive(Debug, Clone)]
pub struct H264EncoderInfo {
    pub factory_name: String,     // GStreamer element factory name
    pub long_name: String,        // Human-readable name
    pub rank: i32,                // GStreamer plugin rank (higher = preferred)
    pub is_hardware: bool,        // true for VAAPI/NVENC/AMF/QSV
    pub accepts_dmabuf: bool,     // true if caps include memory:DMABuf
}

/// Probe GStreamer for all available H.264 video encoders.
/// Returns list sorted by preference (hardware DMA-BUF > hardware > software).
pub fn probe_h264_encoders() -> Vec<H264EncoderInfo> {
    let registry = gst::Registry::get();
    let mut encoders: Vec<H264EncoderInfo> = Vec::new();

    // Known H.264 encoder factory names by vendor
    let candidates = [
        // Hardware — DMA-BUF capable (preferred)
        "vah264enc",          // GStreamer 1.28+ VA (Intel/AMD via new va plugin)
        "vaapih264enc",       // GStreamer VAAPI (Intel/AMD)
        "nvh264enc",          // NVIDIA NVENC
        "amfh264enc",         // AMD AMF
        "qsvh264enc",         // Intel QSV
        "vah264lpenc",        // Intel low-power VA encoder
        "msdkh264enc",        // Intel Media SDK (legacy)
        // Software — always available fallbacks
        "x264enc",            // libx264 (GPL, universal)
        "openh264enc",        // OpenH264 (BSD, universal)
    ];

    for name in candidates {
        if let Some(factory) = registry.find_feature(name, gst::TypeFindOrFactoryType::None) {
            if let Some(element_factory) = factory.dynamic_cast::<gst::ElementFactory>().ok() {
                // Check if it's actually an encoder
                let klass = element_factory.klass();
                if !klass.contains("Encoder") || !klass.contains("Video") {
                    continue;
                }

                let is_hardware = klass.contains("Hardware");
                let accepts_dmabuf = is_hardware; // optimistic; refine later

                encoders.push(H264EncoderInfo {
                    factory_name: name.to_string(),
                    long_name: element_factory.longname().to_string(),
                    rank: element_factory.rank() as i32,
                    is_hardware,
                    accepts_dmabuf,
                });
            }
        }
    }

    // Sort: hardware+DMABuf first, then hardware, then software, then by rank
    encoders.sort_by(|a, b| {
        b.accepts_dmabuf.cmp(&a.accepts_dmabuf)
            .then(b.is_hardware.cmp(&a.is_hardware))
            .then(b.rank.cmp(&a.rank))
    });

    encoders
}
```

**Acceptance criteria:**
- `cargo build -p gv-worker` succeeds
- Unit test: call `probe_h264_encoders()` — must find at least `x264enc` on any system with gst-plugins-ugly
- Unit test: on this machine (Intel iGPU), must find at least `vaapih264enc` or `vah264lpenc`

### Task 4: Rewrite H.264 pipeline builders with probed encoders

**Objective:** Replace `build_h264_pipeline` and `build_hardware_h264_pipeline` from the hardware-encoding branch with versions that use the encoder probe results. Add `x264enc` as guaranteed fallback.

**Files:**
- Modify: `gv-worker/src/gst_video.rs`

**What changes:**
```rust
fn build_h264_pipeline(
    output_width: u32,
    output_height: u32,
    available_encoders: &[H264EncoderInfo],
) -> Result<(gst::Pipeline, String), String> {
    let configured = crate::config::gst_video_h264_encoder();
    
    if configured.eq_ignore_ascii_case("auto") || configured.is_empty() {
        // Try probed encoders in preference order
        for info in available_encoders {
            let pipeline_str = h264_pipeline_string(&info.factory_name, output_width, output_height);
            match launch_pipeline(&pipeline_str) {
                Ok(p) => return Ok((p, info.factory_name.clone())),
                Err(e) => tracing::warn!("[GST-video] {}: {e}", info.factory_name),
            }
        }
    } else {
        // User-specified encoder
        let pipeline_str = h264_pipeline_string(&configured, output_width, output_height);
        return launch_pipeline(&pipeline_str)
            .map(|p| (p, configured));
    }
    
    Err("no H.264 encoder available".into())
}

// Software H.264 pipeline string (NV12 input, works with any encoder)
fn h264_pipeline_string(encoder: &str, output_width: u32, output_height: u32) -> String {
    let bitrate = crate::config::gst_video_bitrate_kbps();
    let kf_dist = crate::config::gst_video_keyframe_max_dist();
    format!(
        "appsrc name=video_src is-live=true format=time \
         ! videoconvert \
         ! video/x-raw,format=NV12,width={w},height={h} \
         ! {encoder} \
           name=h264enc \
           bitrate={br} \
           rate-control=cbr \
           target-usage=7 \
           b-frames=0 \
           cabac=false \
           dct8x8=false \
           key-int-max={kf} \
         ! h264parse config-interval=-1 \
         ! video/x-h264,stream-format=byte-stream,alignment=au,profile=constrained-baseline \
         ! appsink name=video_sink sync=false async=false drop=true max-buffers=4",
        w = output_width, h = output_height,
        br = bitrate, kf = kf_dist,
    )
}
```

**For `x264enc` specifically:** The pipeline string uses the same NV12 input format. `x264enc` accepts NV12 natively. If `x264enc` doesn't support `key-int-max` (it uses `keyframe-max-dist` instead), add a per-encoder parameter map.

**Acceptance criteria:**
- `cargo build -p gv-worker` succeeds
- `GV_GST_VIDEO_CODEC=h264` + `gst-inspect-1.0 x264enc` exists → H.264 pipeline launches with x264enc
- `GV_GST_VIDEO_CODEC=h264` + VAAPI available → prefers vaapih264enc over x264enc
- `GV_GST_VIDEO_CODEC=auto` + browser offers H.264 → uses H.264 if available, falls back to VP8
- `GV_GST_VIDEO_CODEC=auto` + browser only offers VP8 → uses VP8

### Task 5: Wire codec negotiation into WebRTC handshake

**Objective:** Port the codec negotiation logic from the hardware-encoding branch's `main_body.rs` into v3. The worker probes encoders at startup, then during WebRTC handshake checks the browser's SDP offer for H.264 support and negotiates accordingly.

**Files:**
- Modify: `gv-worker/src/main_body.rs`

**What to port (from `feature/hardware-encoding-3d-acceleration`):**
- `sdp_offer_supports_h264()` function
- `create_video_encoder()` function (but modified to use probed encoders, not hardcoded)
- `MIME_TYPE_H264` import
- H.264 SDP fmtp line: `"level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"`
- Dynamic video track creation based on selected codec

**Key change from branch:** Instead of calling `build_hardware_h264_pipeline` / `build_h264_pipeline` directly, pass the probed encoder list from Task 4.

**Acceptance criteria:**
- `cargo build -p gv-worker` succeeds
- VP8 streams still work (no regression)
- `GV_GST_VIDEO_CODEC=h264` → H.264 WebRTC track created, SDP answer includes H.264
- Chrome connects to worker with H.264 → plays video

---

## Phase 2: GPU Awareness

### Task 6: GPU detection at server startup

**Objective:** New function in gv-server (and eventually gv-desktop) that detects available GPUs, their capabilities, and available encoders. Reports this in server metadata.

**Files:**
- Create: `gv-server/src/gpu_info.rs`
- Modify: `gv-server/src/main.rs` — call GPU probe at startup, include in metadata
- Modify: `gv-server/src/gv_web.rs` — `ServerMetadata` struct gets GPU fields

**Implementation:**
```rust
#[derive(Debug, Clone, Serialize)]
pub struct GpuInfo {
    pub name: String,                    // "Intel Arc A770" or "llvmpipe (software)"
    pub vendor: String,                  // "Intel", "AMD", "NVIDIA", "Software"
    pub is_hardware: bool,
    pub render_node: Option<String>,     // "/dev/dri/renderD128"
    pub vulkan_available: bool,
    pub available_h264_encoders: Vec<EncoderInfo>,
}

pub fn detect_gpus() -> Vec<GpuInfo> {
    // 1. Check /dev/dri for DRM devices → read vendor via sysfs
    // 2. Try Vulkan instance creation (vulkano or ash) → enumerate physical devices
    // 3. Fallback: check if llvmpipe is the active Mesa driver = software GPU
}
```

**On Windows:** Use DXGI to enumerate adapters. On Linux: check `/sys/class/drm/card*/device/vendor` + `/dev/dri`.

**Acceptance criteria:**
- `gv-server start` logs detected GPUs
- `/api/server/metadata` includes GPU info
- On this machine: detects Intel iGPU (renderD128) or at minimum reports "software (llvmpipe)"
- No panic if `/dev/dri` doesn't exist (Docker, WSL)

### Task 7: GPU-aware worker spawning

**Objective:** When spawning a worker, gv-server selects the best GPU/encoder and passes it via env vars. User can override in settings.

**Files:**
- Modify: `gv-server/src/worker.rs` — `spawn_worker()` accepts optional GPU/encoder selection
- Modify: `gv-server/src/main.rs` — worker spawn passes GPU selection
- Modify: `gv-web/app/settings/page.tsx` — GPU/encoder selection UI

**Env vars forwarded to worker:**
- `GV_GPU_RENDER_NODE=/dev/dri/renderD128` (which GPU to render on)
- `GV_GST_VIDEO_CODEC=h264` (codec preference)
- `GV_GST_VIDEO_H264_ENCODER=vaapih264enc` (specific encoder)

**Acceptance criteria:**
- Worker spawn logs which GPU it's using
- Settings page shows GPU selector (dropdown of detected GPUs)
- Settings page shows encoder selector (dropdown of probed encoders)

---

## Phase 3: Desktop App

### Task 8: Create gv-desktop crate with Tauri

**Objective:** New crate wrapping gv-server as a desktop app with system tray.

**Files:**
- Create: `gv-desktop/Cargo.toml`
- Create: `gv-desktop/src/main.rs`
- Create: `gv-desktop/src/tray.rs`
- Create: `gv-desktop/tauri.conf.json`
- Modify: `Cargo.toml` — add `gv-desktop` to workspace members

**Tauri setup:**
```toml
[package]
name = "gv-desktop"
version = "3.0.0"
edition = "2024"

[dependencies]
tauri = "2"
tauri-plugin-shell = "2"
gv-server = { path = "../gv-server" }
tray-icon = "0.19"
```

**Behavior:**
- App starts → spawns gv-server as a managed child process
- Opens gv-web at `http://localhost:3000` in a Tauri webview
- System tray icon with menu: Open, Pause Server, Settings, Quit
- On quit → graceful shutdown of gv-server + all workers

**Acceptance criteria:**
- `cargo build -p gv-desktop` succeeds
- App launches, system tray icon appears
- gv-server starts and gv-web loads in webview
- Quit from tray stops gv-server

### Task 9: Windows Service integration

**Objective:** gv-desktop can install/uninstall itself as a Windows Service.

**Files:**
- Create: `gv-desktop/src/service.rs`
- Modify: `gv-desktop/src/main.rs` — `--install-service`, `--uninstall-service` flags

**Implementation:**
```rust
use windows_service::{
    service::{ServiceAccess, ServiceErrorControl, ServiceInfo, ServiceStartType, ServiceType},
    service_manager::{ServiceManager, ServiceManagerAccess},
};

pub fn install_service() -> Result<()> {
    // Register with SCM: name="GamesVault", display="Games Vault Server"
    // Start type: Automatic (delayed start)
    // Account: LocalService
}

pub fn uninstall_service() -> Result<()> {
    // Stop and delete from SCM
}
```

**Acceptance criteria:**
- `gv-desktop --install-service` registers with Windows SCM
- Service starts on boot, runs gv-server on localhost:3000
- `gv-desktop --uninstall-service` removes cleanly
- Service runs as LocalService (not SYSTEM, not Administrator)

### Task 10: mDNS LAN discovery

**Objective:** gv-server broadcasts its presence on the LAN so phones/laptops can find it automatically.

**Files:**
- Create: `gv-desktop/src/mdns.rs` (or add to gv-server if desktop crate isn't ready)
- Modify: `gv-server/src/main.rs` — spawn mDNS broadcaster on startup

**Implementation:**
```rust
use mdns_sd::{ServiceDaemon, ServiceInfo};

pub fn broadcast_games_vault(port: u16, instance_name: &str) -> Result<ServiceDaemon> {
    let daemon = ServiceDaemon::new()?;
    let service_info = ServiceInfo::new(
        "_gamesvault._tcp",
        instance_name,       // "Joel's Gaming PC"
        "localhost",         // hostname (bonjour resolves this)
        "",                  // IP (auto)
        port,
        Some(&[
            ("version", "3.0"),
            ("path", "/"),
        ]),
    )?;
    daemon.register(service_info)?;
    Ok(daemon)
}
```

**On Windows:** Use `dnssd` crate with Bonjour SDK, or fall back to SSDP.

**Acceptance criteria:**
- gv-server starts → `_gamesvault._tcp` service appears on LAN
- `avahi-browse -r _gamesvault._tcp` shows the server
- gv-web mobile PWA can discover server by mDNS name

### Task 11: GPU detection in desktop app

**Objective:** The Tauri app shows GPU information and encoder status on first run / in settings.

**Files:**
- Modify: `gv-desktop/src/gpu.rs`
- Modify: `gv-web/app/dashboard/page.tsx` — GPU status card
- Modify: `gv-server/src/main.rs` — serve GPU info endpoint or include in /api/server/metadata

**UI additions to dashboard:**
```
┌─────────────────────────────────┐
│ System                          │
│ GPU: Intel Arc A770             │
│ Encoder: vaapih264enc (VAAPI)   │
│ Render: DMA-BUF (zero-copy)     │
│ Games running: 1                 │
│ CPU: 12%  RAM: 4.2/32 GB       │
└─────────────────────────────────┘
```

**Acceptance criteria:**
- Dashboard shows detected GPU name and encoder
- Dashboard shows whether DMA-BUF is active
- Falls back gracefully: "Software rendering (llvmpipe)" if no GPU

---

## Phase 4: Platform Packaging

### Task 12: Linux AppImage build script

**Objective:** Produce a single-file AppImage that bundles gv-server, gv-worker, gv-web, and all GStreamer deps.

**Files:**
- Create: `scripts/build-appimage.sh`

**Approach:** Use `linuxdeploy` with GStreamer plugin. The AppImage contains:
- `usr/bin/gv-server` (Rust binary)
- `usr/bin/gv-worker` (Rust binary, or single-binary mode)
- `usr/share/gv-web/` (Next.js static export or .next/ standalone)
- GStreamer + plugins (bundled via linuxdeploy plugin)
- Mesa drivers (bundled for software fallback)
- Desktop file + icon

**Acceptance criteria:**
- `./scripts/build-appimage.sh` produces `GamesVault-3.0.0-x86_64.AppImage`
- AppImage runs on Fedora 40, Ubuntu 24.04, Debian 12 without additional deps
- gv-server starts, gv-web loads at localhost:3000
- H.264 encoding works (x264enc fallback guaranteed)

### Task 13: Flatpak manifest

**Objective:** Flatpak build for Flathub distribution.

**Files:**
- Create: `scripts/build-flatpak.sh`
- Create: `flatpak/com.gamesvault.GamesVault.yml`

**Flatpak considerations:**
- GPU access needs `--device=dri` and `--socket=x11` or `--socket=wayland`
- GStreamer from org.freedesktop.Sdk.Extension.gstreamer
- WebRTC needs `--socket=network` (should already be there)
- Mesa from runtime (no need to bundle)

**Acceptance criteria:**
- `flatpak-builder build-dir com.gamesvault.GamesVault.yml` succeeds
- Flatpak runs, shows web UI, streams games

### Task 14: Windows MSI installer

**Objective:** WiX-based MSI that installs gv-desktop as a Windows Service.

**Files:**
- Create: `scripts/build-msi.ps1`
- Create: `installer/windows/GamesVault.wxs`

**MSI contents:**
- `GamesVault.exe` (Tauri desktop app)
- `gv-server.exe` (CLI binary)
- `gv-worker.exe` (or single-binary mode)
- GStreamer runtime (bundled from gstreamer.freedesktop.org)
- Register Windows Service
- Start menu shortcuts
- Uninstall entry

**Acceptance criteria:**
- MSI installs on Windows 11 without errors
- Games Vault appears in Start menu
- Service starts on boot (Automatic, delayed)
- `http://localhost:3000` serves the web UI
- Uninstall removes service, files, registry entries

---

## Phase 5: DMA-BUF Integration (from hardware-encoding branch)

### Task 15: Port DMA-BUF frame handling

**Objective:** Bring the `CoreVideoFrame::DmaBuf` variant and `push_dmabuf()` method from the hardware-encoding branch. Wire the DMA-BUF path when hardware rendering is active.

**Files:**
- Modify: `gv-worker/src/gst_video.rs` — port `push_dmabuf()`, `build_hardware_h264_pipeline()`
- Modify: `gv-worker/src/main_body.rs` — port `VideoPayload::DmaBuf` arm in streaming loop
- Modify: `gv-worker/src/core_bridge.rs` — port `CoreVideoFrame::DmaBuf` variant
- Modify: `libretro-runner/src/runner.rs` — ensure `CoreFrame.video` can carry `CoreVideoFrame::DmaBuf`

**What to port:**
- `DmaBufFrame` struct from `libretro-runner/src/lib.rs`
- `push_dmabuf()` method on `GstVideoEncoder` (DMA-BUF allocator + buffer push)
- `build_hardware_h264_pipeline()` — DMA-BUF caps pipeline: `caps=video/x-raw(memory:DMABuf)` → vaapipostproc → H.264 encoder
- Streaming loop: match on `CoreVideoFrame::DmaBuf(dmabuf)` → call `push_dmabuf()`

**Key change from branch:** The hardware pipeline MUST use the probed encoder list. If no DMA-BUF-capable encoder is available, the `build_hardware_h264_pipeline` fallback path uses `build_h264_pipeline` (software NV12 input).

**Acceptance criteria:**
- `cargo build -p gv-worker -p libretro-runner` succeeds
- DMA-BUF path works when GPU + VAAPI available (test on AMD/NVIDIA/Intel with real GPU)
- Falls back to software H.264 or VP8 when DMA-BUF not available
- No panic on systems without `/dev/dri`

### Task 16: Integration smoke test — H.264 end-to-end

**Objective:** Automated test that launches worker with a test core, negotiates H.264, verifies encoded frames are valid H.264.

**Files:**
- Create: `gv-worker/tests/h264_integration.rs`

**Test flow:**
1. Start worker with `GV_GST_VIDEO_CODEC=h264`
2. Send SDP offer containing `h264/90000`
3. Verify SDP answer contains H.264
4. Stream 60 frames
5. Pull encoded frames from GStreamer appsink
6. Verify frames are valid H.264 (NAL unit start codes, SPS/PPS present)
7. Verify frame count matches input

**Acceptance criteria:**
- `cargo test -p gv-worker --test h264_integration` passes
- Test passes with x264enc (software, always available)
- Test passes with hardware encoder if available (VAAPI/NVENC)

---

## Non-Goals (explicitly excluded)

- **Software rendering for headless servers.** v3 targets gaming PCs with real GPUs. Software rendering (llvmpipe, SwiftShader) is out of scope. The Xvfb path from the hardware-encoding branch is preserved for 3D cores that need GLX, but it's not the primary path.
- **macOS packaging.** Deferred. DMG + LaunchAgent is straightforward but adds testing surface.
- **Multi-GPU scheduling policy (round-robin).** Single GPU for now. Multi-GPU slots come in a follow-up.
- **TURN server changes.** Existing TURN/VPS relay infrastructure is unchanged.
- **Mobile native apps.** gv-web PWA remains the mobile client. No Swift/Kotlin.
- **VP9/AV1 encoding.** H.264 is the pragmatic choice. VP9/AV1 add complexity without benefit for game streaming (browsers all support H.264, encoders are slower, latency is worse).

---

## Dependency Graph

```
Phase 1 (Encoder Foundation)
  Task 1 (rename crate)
    ↓
  Task 2 (port VideoCodec enum)
    ↓
  Task 3 (encoder probing) ──────────────────┐
    ↓                                          │
  Task 4 (rewrite H.264 pipelines) ←──────────┘
    ↓
  Task 5 (WebRTC codec negotiation)
    ↓
Phase 2 (GPU Awareness)
  Task 6 (GPU detection)
    ↓
  Task 7 (GPU-aware worker spawning)
    ↓
Phase 3 (Desktop App)
  Task 8 (gv-desktop crate + Tauri)
    ↓
  Task 9 (Windows Service) ─┐
  Task 10 (mDNS discovery)  ├─ parallel
  Task 11 (GPU dashboard)  ─┘
    ↓
Phase 4 (Packaging)
  Task 12 (AppImage) ─┐
  Task 13 (Flatpak)   ├─ parallel
  Task 14 (MSI)      ─┘
    ↓
Phase 5 (DMA-BUF)
  Task 15 (port DMA-BUF from hardware-encoding branch)
    ↓
  Task 16 (H.264 integration test)
```

**Total: 16 tasks across 5 phases.**
