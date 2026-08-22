//! Compiles the two C shims that the libretro runner needs but Rust cannot
//! express directly:
//!   1. sc-log-shim.c  — variadic log forwarder for GET_LOG_INTERFACE.
//!   2. sc-gl-bridge.c — headless EGL/GBM hardware rendering for SET_HW_RENDER.
//!
//! Both link into the final sc-core binary. The GL bridge additionally emits
//! link flags for libEGL / libgbm / libGL, and links desktop GL so cores that
//! request a desktop OpenGL core context work.

fn main() {
    println!("cargo:rerun-if-changed=src/log_shim.c");
    println!("cargo:rerun-if-changed=src/gl_bridge.c");
    println!("cargo:rerun-if-changed=src/deps/libretro.h");

    cc::Build::new()
        .file("src/log_shim.c")
        .flag_if_supported("-std=c99")
        .warnings(true)
        .compile("sc_log_shim");

    cc::Build::new()
        .file("src/gl_bridge.c")
        .flag_if_supported("-std=c99")
        .warnings(true)
        .compile("sc_gl_bridge");

    // Link the EGL/GBM/GL libraries the GL bridge depends on.
    println!("cargo:rustc-link-lib=EGL");
    println!("cargo:rustc-link-lib=gbm");
    println!("cargo:rustc-link-lib=GL");
    // gbm headers ship GLESv2 types transitively; link it too for safety.
    println!("cargo:rustc-link-lib=GLESv2");
}