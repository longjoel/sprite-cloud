/*
 * sc-log-shim.c — minimal libretro log-interface forwarder.
 *
 * libretro's retro_log_printf_t is variadic: `void cb(level, const char *fmt, ...)`.
 * Rust cannot reformat a va_list, so this tiny C shim forwards core log calls to
 * stderr with a level tag and flushes immediately. stderr is line-buffered and
 * survives SIGSEGV (unlike buffered stdout), which is essential for diagnosing
 * cores that crash during init.
 *
 * The symbol is exported (no static) and exposed to Rust via `extern "C"` in
 * ffi.rs, referenced as `sc_log_printf`.
 */

#include <stdio.h>
#include <stdarg.h>

#define RETRO_LOG_DEBUG 0
#define RETRO_LOG_INFO  1
#define RETRO_LOG_WARN  2
#define RETRO_LOG_ERROR 3

/* Exported: called by the libretro core through the env GET_LOG_INTERFACE. */
void sc_log_printf(unsigned level, const char *fmt, ...)
{
    const char *tag;
    switch (level & 0xFF) {
        case RETRO_LOG_ERROR: tag = "ERROR"; break;
        case RETRO_LOG_WARN:  tag = "WARN "; break;
        case RETRO_LOG_DEBUG: tag = "DEBUG"; break;
        default:              tag = "INFO "; break;
    }

    fputs("[core-log] ", stderr);
    fputs(tag, stderr);
    fputs(": ", stderr);

    va_list args;
    va_start(args, fmt);
    vfprintf(stderr, fmt, args);
    va_end(args);
    fflush(stderr);
}