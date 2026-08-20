//! Compiles sc-log-shim.c so the libretro runner can provide GET_LOG_INTERFACE
//! to cores. The shim is a variadic C function (Rust cannot reformat a va_list),
//! forwarding core log calls to stderr, surviving SIGSEGV during core init.

fn main() {
    println!("cargo:rerun-if-changed=src/log_shim.c");
    cc::Build::new()
        .file("src/log_shim.c")
        // `cc` on Linux defaults to gcc; keep it C99-safe and position-independent.
        .flag_if_supported("-std=c99")
        .warnings(true)
        .compile("sc_log_shim");
}