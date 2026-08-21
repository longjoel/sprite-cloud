# sc-core libretro hardware-rendering gap: heavy cores fail to load

> **Goal:** make the N64/Dreamcast/PS2 player flow on drone0 actually boot a game.
> PS1 already works (CPU core). Root cause is **no GL context in the runner** —
> an OpenGL 3D context issue, not a core-options bug.
> **Status:** ✅ **Phase 1 (logging) DONE — committed `ad837b89`.**
> ✅ **Phase 2a (EGL/GBM HW render) PROVEN — Flycast now boots a Dreamcast game
> headless.** N64 (mupen) source build + live-frame verification remain.

## 0. Corrected root cause (supersedes earlier "env-contract gap" theory)

`libretro-runner` handles **zero** hardware-rendering env commands: no
`SET_HW_RENDER`, no EGL/GBM/GLX/Vulkan anywhere in the crate. The heavy cores —

- mupen64plus-next (GLideN64), flycast, pcsx2

are all **GL cores**. They call `SET_HW_RENDER` asking for a context; the runner
answers `false`; the core falls back to `glsym_gl.c` — a dlsym-based
`gl*` symbol resolver that resolves through `libGL→libGLX`. With no X server and
no context, the GL dispatcher calls a NULL proc → **SIGSEGV at RIP=0x0** inside
`retro_load_game`. mupen refuses gracefully (`retro_load_game returned false`).
Light cores (pcsx_rearmed = CPU renderer) never request GL and work fine.

drone0 silicon (Intel ALD-N `0x46d1`, Mesa 25.2.8, `renderD128`, EGL/GBM/GLES all
present) is the exact headless-EGL stack documented in the `egl-headless-rendering`
skill: **surfaceless + FBO only works for our own GL**; libretro cores need the
GBM surface → EGL window surface → real framebuffer 0 path, plus `context_reset`
chaining.

## 1. Evidence gathered (drone0, live)

| Platform | Core | Direct `sc-core` result |
|---|---|---|
| PS1 (pcsx_rearmed) | CPU | ✅ loads, renders |
| N64 (mupen64plus_next) | GL | ❌ `retro_load_game returned false` |
| Dreamcast (flycast) | GL | ❌ **SIGSEGV** at address `0x0` |
| PS2 (pcsx2) | GL | ❌ **SIGSEGV** at address `0x0` |

- ROM opens fine (strace), not byte-swap/missing-file.
- Buildbot `.so` cores link libGL→libGLX → GLX-only, incompatible with headless EGL.

## 2. Phase 1 — robust core logging first (MVP / this deliverable)

Goal: let cores tell us exactly why they fail, reliably and before they SIGSEGV.
A log interface also lets the GL code in Phase 2 emit its own init errors.

1. **C log shim** (`log_shim.c`): libretro's `retro_log_printf_t` is variadic
   (`fn(level, fmt, ...)`). Rust cannot reformat a variadic `va_list`, so a tiny C
   function forwards `vfprintf(stderr, ...)` with a level prefix + fflush (stderr
   survives SIGSEGV; printf to stdout may be lost). Compiled via `cc` in a new
   `build.rs`.
2. **`GET_LOG_INTERFACE` (27)** in the env callback: fill
   `retro_log_callback { log: Some(shim) }`, return `true`.
3. **`GET_LIBRETRO_PATH` (19)**: return the loaded core's path (trivial, and some
   cores resolve shaders relative to it).
4. Keep the `eprintln!` for any still-unhandled env cmd.
5. Deploy `sc-core` → drone0, re-run all four smoke tests. Expect cores to now
   print their real GL init errors instead of dying silently / refusing blindly.

**Exit criteria:** `GET_LOG_INTERFACE` returns `true`, core stderr reaches our
stderr, and the re-run of N64/flycast shows the *specific* GL failure reason
(e.g. "no GL context" / "Failed to create context") — confirming the diagnosis
and pinning the correct Phase 2 context type before we build it.

### ✅ Phase 1 outcome (implemented + verified, deployed to drone0)

- C log shim (`log_shim.c`, compiled via `build.rs`/`cc`) + `GET_LOG_INTERFACE`
  (env 27) + `GET_LIBRETRO_PATH` (env 19) wired into `environment_callback`.
  Verified `sc_log_printf` is a linked GLOBAL FUNC in the release binary.
- **mupen64plus-next**: now logs and refuses cleanly (no silent segfault):
  `[core-log] ERROR: mupen64plus: libretro frontend doesn't have OpenGL support`,
  then `retro_load_game returned false` (exit 3). Confirms the OpenGL-context
  root cause directly from the core.
- **flycast**: now boots further — logs BIOS/VMEM init (`[VMEM] ...`, "nvmem is
  enabled") and reads the `.cdi` — then refuses on GL, rather than raw-segfault.
- **pcsx_rearmed (PS1)**: still loads and renders, with full logging → **no
  regression** on the CPU path.
- **pcsx2**: still SIGSEGV (exit 139) at a real code address inside its own `.so`
  (segv `ip 0x7be5…30`, in `pcsx2_libretro.so`) BEFORE reaching the log-interface
  callback (no `[core-log]` at all). It also requests unusual env cmds
  `65581 (0x1002d)`, `58 (0x3a)`, `69`, `52`, `16` then crashes. → **distinct
  issue, isolated to Phase 2** (likely pcsx2's own env/options handling, not the
  GL path; needs its own backtrace).
- drone0 `sc-server` service restarted, health OK.

## 3. Phase 2 — headless EGL/GBM hardware rendering (the real fix)

1. Implement `SET_HW_RENDER` in the runner using the skill's proven path:
   - EGL via `eglGetPlatformDisplayEXT(EGL_PLATFORM_GBM_MESA, …)` (not legacy
     `eglGetDisplay`).
   - **GBM surface → EGL window surface** (real default framebuffer 0 — required;
     a surfaceless FBO won't cut it for cores).
   - Desktop GL: `eglBindAPI(EGL_OPENGL_API)` + core profile 3.3, since cores
     request `RETRO_HW_CONTEXT_OPENGL_CORE` (0x3). Some cores want GLES2 — decide
     per-core from the `context_type` the core requests.
   - **Chain `context_reset`** (save the core's, wrap in ours) — the #1 cause of
     RIP=0x0 in `glsm_ctl` if overwritten.
   - `get_proc_address` + `get_current_framebuffer` provided; `eglSwapBuffers` on
     every `video_refresh` with `RETRO_HW_FRAME_BUFFER_VALID`.
   - Convert/capture GL framebuffer → raw frame for the streaming pipeline.
2. **CUDA/software dilemma per core** (buildbot binaries are GLX-only):
   - mupen64plus-next / flycast: **build from source** with the parallel render
     path (ParaLLEl-RDP for N64, follow the skill's `cores/build.py` recipe) so
     they use `libGLESv2`/our EGL context instead of GLX.
   - pcsx2: hourly GLES/software; verify build flags.
3. Wire the per-core EGL context into `sc-server`'s launch path only for cores
   flagged `hw_render=true` in `info.rs`; keep the existing software path for CPU
   cores (PS1 stays on it).
4. Verify via direct `sc-core` smoke tests, then the full `start_game` → "playing"
   player flow on drone0.

## 4. Verification

1. Phase 1: all four direct `sc-core` runs now log; N64/flycast failures are
   identifiable from core stderr.
2. Phase 2: N64 SM64 boots and streams; flycast + pcsx2 load without SIGSEGV.
3. PS1 pcsx_rearmed (CPU path) **does not regress**.
4. `journalctl -u sc-server`: core reaches "playing", no `core did not stop
   within shutdown deadline`.

## 5. Risks / tradeoffs

- **Variadic log**: cannot be done in pure safe Rust → requires a C shim via
  `cc` build-dependency (new build.rs in the crate).
- **Buildbot binaries are GLX-only** → Phase 2 must source-build the GL cores
  (or use parallel software renderers). Cannot just drop buildbot `.so` files in.
- `SET_HW_RENDER` handling is shared by all cores — must keep the CPU path for
  software cores and only take the HW path when a core asks for it.
- Phase 2 touches the streaming/readback pipeline; phase-gate on Phase 1 logging
  first so failures self-reveal.

## 6. Deployment / PR path

- Phase 1 log shim is self-contained as its **own PR** (separate from PS2
  detection PR #832).
- Deploy built `sc-core` to drone0 *now* for the user's player URL iteration,
  independent of review (test box, not production).
- Phase 2 (HW render + core source builds) is a larger change → separate PR + the
  `cores/build.py` recipe.

## 7. Open questions
1. For Phase 2 GL cores: prefer the **parallel-software renderers** (ParaLLEl-RDP /
   PCSX2 software) to avoid per-core GL source builds, or bite the bullet on
   source-building each GL core? (Skill shows parallel-N64 works cleanly; flycast
   has no software fallback.)
2. Should the EGL context be owned by `libretro-runner` (shared) or injected per
   platform by sc-server?
