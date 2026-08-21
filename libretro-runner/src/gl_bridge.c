/*
 * sc-gl-bridge.c — headless EGL/GBM rendering for libretro cores.
 *
 * Owns ALL OpenGL context + surface setup and the libretro HW-render struct
 * handling (via the real libretro.h), because hand-rolling the struct in Rust
 * corrupts field offsets (see egl-headless-rendering skill: retro_hw_render_callback
 * must match the canonical header exactly).
 *
 * Design mirrors the proven headless-EGL harness on Intel ADL-N + Mesa 25.2.x:
 *   GBM device -> EGL display -> GBM window surface -> EGL window surface
 *   -> desktop GL core (or GLES2) context -> real default framebuffer 0.
 *
 * The critical pitfall (context_reset chaining) is handled here: we SAVE the
 * core's own context_reset and call it from our wrapper AFTER making the EGL
 * context current. Overwriting it is the #1 cause of RIP=0x0 in glsm_ctl.
 *
 * Exposed to Rust via `unsafe extern "C"` in gl_bridge.rs:
 *   sc_gl_bridge_init, sc_gl_bridge_prepare_frame, sc_gl_bridge_finish_frame,
 *   sc_gl_bridge_destroy
 */

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>

#include <gbm.h>
#include <EGL/egl.h>
#include <EGL/eglext.h>
// Desktop GL types for context types that request OpenGL_CORE.
#include <GL/gl.h>

#include "deps/libretro.h"

#define RENDER_NODE "/dev/dri/renderD128"
#define DEFAULT_W 640
#define DEFAULT_H 480

/* Actual surface size (from the core's av_info max dims once known). */
static int surf_w = DEFAULT_W;
static int surf_h = DEFAULT_H;

static int dri_fd = -1;
static struct gbm_device *gbm_dev = NULL;
static struct gbm_surface *gbm_surf = NULL;
static EGLDisplay egl_dpy = EGL_NO_DISPLAY;
static EGLConfig egl_cfg = NULL;
static EGLContext egl_ctx = EGL_NO_CONTEXT;
static EGLSurface egl_surf = EGL_NO_SURFACE;

/* The core's own context_reset, saved so our wrapper can chain to it. */
static retro_hw_context_reset_t core_context_reset = NULL;
static int gl_initialized = 0;

/* DID_GL bind for our context API decision. */
static int gl_is_es = 0;
/* Desktop GL cores may want legacy (fixed-function) GL that only a
 * compatibility-profile context provides (e.g. ParaLLEl-N64's glide64).
 * RETRO_HW_CONTEXT_OPENGL (0x1) => compat; OPENGL_CORE (0x3) => core. */
static int gl_compat = 0;

static void die(const char *msg) {
    fprintf(stderr, "[gl-bridge] FATAL: %s (errno=%s)\n", msg, strerror(errno));
    exit(99);
}

/* ------------------------------------------------------------------ */
/* get_proc_address / get_current_framebuffer for the hw_render_callback */
/* ------------------------------------------------------------------ */

static retro_proc_address_t gl_get_proc_address(const char *name) {
    return (retro_proc_address_t)(uintptr_t)eglGetProcAddress(name);
}

static uintptr_t gl_get_current_framebuffer(void) {
    /* We render to the GBM surface's default framebuffer 0. */
    return 0;
}

/* ------------------------------------------------------------------ */
/* context_reset wrapper — CHAIN the core's callback (critical)        */
/* ------------------------------------------------------------------ */

static void our_context_reset(void) {
    if (gl_initialized) {
        eglMakeCurrent(egl_dpy, egl_surf, egl_surf, egl_ctx);
    }
    if (core_context_reset) {
        core_context_reset();
    }
}

/* ------------------------------------------------------------------ */
/* EGL / GBM setup                                                     */
/* ------------------------------------------------------------------ */

static void init_egl_gbm(int context_type, int version_major, int version_minor) {
    /* Open the DRM render node. */
    dri_fd = open(RENDER_NODE, O_RDWR);
    if (dri_fd < 0) die("open /dev/dri/renderD128");
    gbm_dev = gbm_create_device(dri_fd);
    if (!gbm_dev) die("gbm_create_device");

    /* Use the GBM platform extension (NOT the legacy eglGetDisplay path). */
    PFNEGLGETPLATFORMDISPLAYEXTPROC getDpy =
        (PFNEGLGETPLATFORMDISPLAYEXTPROC)eglGetProcAddress("eglGetPlatformDisplayEXT");
    if (!getDpy) die("eglGetPlatformDisplayEXT unavailable");
    egl_dpy = getDpy(EGL_PLATFORM_GBM_MESA, gbm_dev, NULL);
    if (egl_dpy == EGL_NO_DISPLAY) die("eglGetPlatformDisplay(GBM)");

    EGLint major, minor;
    if (!eglInitialize(egl_dpy, &major, &minor)) die("eglInitialize");

    /* Decide API: GLES cores (FORCE_GLES, Flycast/mupen) need GLES; cores
     * that request OPENGL_CORE need desktop GL. Anti-fallback: never pass
     * an ES context type to a core expecting desktop OpenGL. */
    gl_is_es = (context_type == RETRO_HW_CONTEXT_OPENGLES2 ||
                context_type == RETRO_HW_CONTEXT_OPENGLES3 ||
                context_type == RETRO_HW_CONTEXT_OPENGLES_VERSION);

    if (gl_is_es) {
        if (!eglBindAPI(EGL_OPENGL_ES_API)) die("eglBindAPI(ES)");
    } else {
        if (!eglBindAPI(EGL_OPENGL_API)) die("eglBindAPI(GL)");
    }

    /* Config: match GBM_FORMAT_XRGB8888 (needs an 8/8/8/8 EGL_RGBA config —
     * the proven match on this GPU, see skill. */
    EGLint cfg_attrs[] = {
        EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8,
        EGL_RENDERABLE_TYPE, gl_is_es ? EGL_OPENGL_ES2_BIT : EGL_OPENGL_BIT,
        EGL_SURFACE_TYPE, EGL_WINDOW_BIT,
        EGL_NONE
    };
    EGLint n = 0;
    if (!eglChooseConfig(egl_dpy, cfg_attrs, &egl_cfg, 1, &n) || n != 1)
        die("eglChooseConfig");

    /* GBM surface: XRGB8888 + RENDERING + LINEAR (needed for readback). Sized
     * to the core's max dims (surf_w/h) — see set-output-size. */
    gbm_surf = gbm_surface_create(gbm_dev, surf_w, surf_h,
                                  GBM_FORMAT_XRGB8888,
                                  GBM_BO_USE_RENDERING | GBM_BO_USE_LINEAR);
    if (!gbm_surf) die("gbm_surface_create");

    egl_surf = eglCreateWindowSurface(egl_dpy, egl_cfg, gbm_surf, NULL);
    if (egl_surf == EGL_NO_SURFACE) die("eglCreateWindowSurface");

    /* Context. Desktop GL core for OPENGL_CORE; GLES 2/3 for ES cores. */
    if (gl_is_es) {
        int es_maj = version_major >= 3 ? 3 : 2;
        EGLint ctx_attrs[] = { EGL_CONTEXT_CLIENT_VERSION, es_maj, EGL_NONE };
        egl_ctx = eglCreateContext(egl_dpy, egl_cfg, EGL_NO_CONTEXT, ctx_attrs);
    } else {
        int maj = version_major > 0 ? version_major : 3;
        int min_ = version_minor > 0 ? version_minor : 3;
        EGLint ctx_attrs[] = {
            EGL_CONTEXT_MAJOR_VERSION, maj,
            EGL_CONTEXT_MINOR_VERSION, min_,
            EGL_CONTEXT_OPENGL_PROFILE_MASK,
            gl_compat ? EGL_CONTEXT_OPENGL_COMPATIBILITY_PROFILE_BIT
                      : EGL_CONTEXT_OPENGL_CORE_PROFILE_BIT,
            EGL_NONE
        };
        egl_ctx = eglCreateContext(egl_dpy, egl_cfg, EGL_NO_CONTEXT, ctx_attrs);
    }
    if (egl_ctx == EGL_NO_CONTEXT) die("eglCreateContext");

    if (!eglMakeCurrent(egl_dpy, egl_surf, egl_surf, egl_ctx))
        die("eglMakeCurrent");

    gl_initialized = 1;
    fprintf(stderr, "[gl-bridge] initialised: API=%s, EGL %d.%d, surface %dx%d\n",
            gl_is_es ? "OpenGL ES" : "Desktop GL",
            (int)major, (int)minor, surf_w, surf_h);
    if (gl_is_es) {
        fprintf(stderr, "[gl-bridge] GLES: %s\n", (const char *)glGetString(GL_VERSION));
    } else {
        fprintf(stderr, "[gl-bridge] GL: %s\n", (const char *)glGetString(GL_VERSION));
    }
}

/* ------------------------------------------------------------------ */
/* Rust-facing API                                                     */
/* ------------------------------------------------------------------ */

/**
 * Handle SET_HW_RENDER. `data` points to a `struct retro_hw_render_callback`
 * (the core filled context_type/version; we fill the callbacks). Returns 1 on
 * accept, 0 on reject.
 */
int sc_gl_bridge_set_hw_render(void *raw) {
    if (!raw) return 0;
    struct retro_hw_render_callback *hw = (struct retro_hw_render_callback *)raw;

    fprintf(stderr, "[gl-bridge] SET_HW_RENDER: context_type=0x%x ver=%u.%u\n",
            hw->context_type, hw->version_major, hw->version_minor);

    /* Only accept OpenGL / OpenGLES context types. Some cores (e.g. Flycast)
     * probe by first requesting Vulkan and expect the frontend to decline it
     * so they fall back to GLES. Reject anything Vulkan/D3D/unknown. */
    int is_gl  = (hw->context_type == RETRO_HW_CONTEXT_OPENGL ||
                  hw->context_type == RETRO_HW_CONTEXT_OPENGL_CORE);
    int is_es  = (hw->context_type == RETRO_HW_CONTEXT_OPENGLES2 ||
                  hw->context_type == RETRO_HW_CONTEXT_OPENGLES3 ||
                  hw->context_type == RETRO_HW_CONTEXT_OPENGLES_VERSION);
    if (!is_gl && !is_es) {
        fprintf(stderr, "[gl-bridge] rejecting unsupported context_type 0x%x "
                        "(core should fall back to GL/GLES)\n", hw->context_type);
        return 0;
    }
    gl_is_es = is_es;
    /* Desktop GL: compatibility profile for plain OPENGL (legacy cores like
     * ParaLLEl-N64's glide64 need fixed-function GL); core profile for
     * OPENGL_CORE. Irrelevant for GLES. */
    gl_compat = (hw->context_type == RETRO_HW_CONTEXT_OPENGL);

    /* Save the core's own constructor and replace with our chaining wrapper. */
    core_context_reset = hw->context_reset;
    hw->context_reset = our_context_reset;

    hw->get_current_framebuffer = gl_get_current_framebuffer;
    hw->get_proc_address = gl_get_proc_address;
    hw->bottom_left_origin = true;
    hw->depth = false;
    hw->stencil = false;
    hw->cache_context = false;
    hw->debug_context = false;

    /* Lazily initialise EGL/GBM using the requested context type. */
    if (!gl_initialized) {
        init_egl_gbm(hw->context_type, hw->version_major, hw->version_minor);
    }

    /* Trigger the (chained) context_reset immediately while current. */
    our_context_reset();

    return 1;
}

/**
 * Called from video_refresh_callback when data == RETRO_HW_FRAME_BUFFER_VALID.
 * Swap + read the default framebuffer into `dst` (RGBA, w*h*4), flipping to
 * top-left origin for the streaming pipeline. Returns 1 on success.
 */
int sc_gl_bridge_present_and_read(uint8_t *dst, int width, int height, int pitch) {
    if (!gl_initialized || !dst) return 0;
    if (!eglSwapBuffers(egl_dpy, egl_surf)) {
        fprintf(stderr, "[gl-bridge] eglSwapBuffers failed\n");
        return 0;
    }
    glFinish();

    int w = width > 0 ? width : DEFAULT_W;
    int h = height > 0 ? height : DEFAULT_H;
    int row_bytes = pitch > 0 ? pitch : w * 4;

    /* Read back a full row. Use GL_BGRA so the byte layout matches the
     * libretro XRGB8888 format the Rust pipeline already decodes
     * ([B,G,R,X] == [B,G,R,A] ignoring alpha) — avoiding an R/B swap.
     * glReadPixels is bottom-up; flip rows. */
    uint8_t *row = malloc((size_t)row_bytes);
    if (!row) return 0;
    for (int y = 0; y < h; y++) {
        int srcy = h - 1 - y;
        glReadPixels(0, srcy, w, 1, GL_BGRA, GL_UNSIGNED_BYTE, row);
        memcpy(dst + (size_t)y * row_bytes, row, (size_t)row_bytes);
    }
    free(row);
    return 1;
}

void sc_gl_bridge_destroy(void) {
    if (egl_ctx != EGL_NO_CONTEXT) eglDestroyContext(egl_dpy, egl_ctx);
    if (egl_surf != EGL_NO_SURFACE) eglDestroySurface(egl_dpy, egl_surf);
    if (gbm_surf) gbm_surface_destroy(gbm_surf);
    if (egl_dpy != EGL_NO_DISPLAY) eglTerminate(egl_dpy);
    if (gbm_dev) gbm_device_destroy(gbm_dev);
    if (dri_fd >= 0) close(dri_fd);
    egl_ctx = EGL_NO_CONTEXT; egl_surf = EGL_NO_SURFACE; egl_dpy = EGL_NO_DISPLAY;
    gbm_surf = NULL; gbm_dev = NULL; dri_fd = -1;
    gl_initialized = 0;
}

int sc_gl_bridge_is_initialized(void) { return gl_initialized; }

/* ------------------------------------------------------------------ */
/* Output-size control (dynamic-resolution handling)                  */
/* ------------------------------------------------------------------ */

/**
 * Set the EGL window surface to the core's max dimensions. SET_HW_RENDER runs
 * during retro_load_game, before av_info (max dims) is known, so this lets the
 * runner resize the surface once the real max is fetched. N64 changes its VI
 * resolution at runtime; as long as the surface is >= the largest frame and we
 * read per-frame w/h out of it, no stretch occurs. Safe to call once, after
 * the first present; infrequent (once per load).
 */
void sc_gl_bridge_set_output_size(int width, int height) {
    if (width < 1) width = DEFAULT_W;
    if (height < 1) height = DEFAULT_H;
    /* Clamp to a sane upper bound to avoid absurdly large allocations. */
    if (width > 4096) width = 4096;
    if (height > 4096) height = 4096;

    if (!gl_initialized) {
        /* Not set up yet — record the target; init_egl_gbm will use it. */
        surf_w = width;
        surf_h = height;
        return;
    }

    if (surf_w == width && surf_h == height) return;

    fprintf(stderr, "[gl-bridge] resizing output surface %dx%d -> %dx%d\n",
            surf_w, surf_h, width, height);

    /* Recreate just the EGL window surface + GBM surface at the new size;
     * the EGL display + context can stay. Make it current so the core keeps
     * a valid default framebuffer 0 across the swap. */
    if (egl_surf != EGL_NO_SURFACE) eglDestroySurface(egl_dpy, egl_surf);
    if (gbm_surf) gbm_surface_destroy(gbm_surf);

    surf_w = width;
    surf_h = height;

    gbm_surf = gbm_surface_create(gbm_dev, surf_w, surf_h,
                                  GBM_FORMAT_XRGB8888,
                                  GBM_BO_USE_RENDERING | GBM_BO_USE_LINEAR);
    if (!gbm_surf) { fprintf(stderr, "[gl-bridge] resize: gbm_surface_create failed\n"); return; }

    egl_surf = eglCreateWindowSurface(egl_dpy, egl_cfg, gbm_surf, NULL);
    if (egl_surf == EGL_NO_SURFACE) {
        fprintf(stderr, "[gl-bridge] resize: eglCreateWindowSurface failed\n");
        return;
    }
    eglMakeCurrent(egl_dpy, egl_surf, egl_surf, egl_ctx);
    fprintf(stderr, "[gl-bridge] surface now %dx%d\n", surf_w, surf_h);
}