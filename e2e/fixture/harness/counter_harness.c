/*
 * e2e/fixture/harness/counter_harness.c
 *
 * Deterministic headless harness for the Sprite Cloud E2E fixture ROM.
 *
 * Loads a libretro core (nestopia) with the counter ROM, runs a fixed
 * number of frames, optionally injects an A-button press, and writes the
 * final rendered frame to a file so the test driver can hash it.
 *
 * Two invariants this proves:
 *   1. DETERMINISM — same ROM + same frame count + same input → the
 *      final frame hashes to the same value on every run.
 *   2. INPUT RESPONSE — injecting A changes the counter, which changes
 *      the rendered digits, which changes the frame hash.
 *
 * Usage:
 *   gcc -o counter_harness counter_harness.c -ldl -lm -O2
 *   ./counter_harness <core.so> <rom> <frames> <press_a_at_frame|-1> <out.ppm> [system_dir]
 *
 * Exit codes: 0 = ran, 1 = fatal error, 2 = no frames captured.
 */

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <dlfcn.h>
#include <time.h>

#include "libretro.h"

static const char *system_dir = "/tmp";
static int frame_count = 0;
static int press_frame = -1;
static int press_button = -1;   /* RETRO_DEVICE_ID_JOYPAD_* of the button to press */
static bool a_down = false;

/* Last frame pixel data (single capture, XRGB8888) */
static uint8_t *last_frame = NULL;
static unsigned last_w = 0, last_h = 0;
static size_t last_pitch = 0;

static void video_refresh(const void *data, unsigned w, unsigned h, size_t pitch) {
    frame_count++;
    if (!data || data == RETRO_HW_FRAME_BUFFER_VALID)
        return;
    free(last_frame);
    last_frame = malloc(h * pitch);
    memcpy(last_frame, data, h * pitch);
    last_w = w;
    last_h = h;
    last_pitch = pitch;
}

static void audio_sample(int16_t l, int16_t r) { (void)l; (void)r; }
static size_t audio_sample_batch(const int16_t *d, size_t n) { (void)d; return n; }

static void input_poll(void) {
    /* If we've reached the press frame, hold the button for 4 frames,
     * then release. */
    if (press_frame >= 0 && frame_count >= press_frame && frame_count < press_frame + 4) {
        a_down = true;
    } else {
        a_down = false;
    }
}

static int16_t input_state(unsigned port, unsigned device, unsigned index, unsigned id) {
    (void)index;
    if (port == 0 && device == RETRO_DEVICE_JOYPAD) {
        /* nestopia prefers the full 16-bit mask when the frontend reports
         * bitmask support (RETRO_ENVIRONMENT_GET_INPUT_BITMASKS); it also
         * polls individual ids as a fallback. Answer both. */
        if (id == RETRO_DEVICE_ID_JOYPAD_MASK)
            return a_down ? (1 << press_button) : 0;
        if (a_down && (int)id == press_button)
            return 0x7FFF;
    }
    return 0;
}

static bool environ_cb(unsigned cmd, void *data) {
    switch (cmd) {
    case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
        *(const char **)data = system_dir;
        return true;
    case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
        *(const char **)data = system_dir;
        return true;
    case RETRO_ENVIRONMENT_GET_LANGUAGE:
        *(unsigned *)data = RETRO_LANGUAGE_ENGLISH;
        return true;
    case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
        return (*(enum retro_pixel_format *)data) == RETRO_PIXEL_FORMAT_XRGB8888;
    case RETRO_ENVIRONMENT_SET_HW_RENDER:
        return false; /* software rendering only */
    case RETRO_ENVIRONMENT_GET_VARIABLE:
        return false;
    case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
        *(bool *)data = false;
        return true;
    case RETRO_ENVIRONMENT_SET_GEOMETRY:
        return true;
    case RETRO_ENVIRONMENT_SET_SUBSYSTEM_INFO:
        return true;
    default:
        return false;
    }
}

static void die(const char *msg) {
    fprintf(stderr, "FATAL: %s\n", msg);
    exit(1);
}

static void write_ppm(const char *path, const uint8_t *px, unsigned w, unsigned h, size_t pitch) {
    FILE *fp = fopen(path, "wb");
    if (!fp) die("fopen output");
    fprintf(fp, "P6\n%u %u\n255\n", w, h);
    uint8_t *row = malloc(w * 3);
    for (unsigned y = 0; y < h; y++) {
        for (unsigned x = 0; x < w; x++) {
            size_t i = (size_t)y * pitch + (size_t)x * 4;
            row[x*3+0] = px[i+2]; row[x*3+1] = px[i+1]; row[x*3+2] = px[i+0];
        }
        fwrite(row, 1, w*3, fp);
    }
    free(row);
    fclose(fp);
}

int main(int argc, char *argv[]) {
    if (argc < 6) {
        fprintf(stderr, "Usage: %s <core.so> <rom> <frames> <press_button_at_frame|-1> <out.ppm> [button] [system_dir]\n", argv[0]);
        fprintf(stderr, "  button: a (default) | b | start | select | none\n");
        return 1;
    }
    const char *core_path = argv[1];
    const char *rom_path = argv[2];
    int target = atoi(argv[3]);
    press_frame = atoi(argv[4]);
    const char *out_path = argv[5];
    const char *button = (argc >= 7) ? argv[6] : "a";
    if (argc >= 8) system_dir = argv[7];

    if (strcmp(button, "a") == 0) press_button = RETRO_DEVICE_ID_JOYPAD_A;
    else if (strcmp(button, "b") == 0) press_button = RETRO_DEVICE_ID_JOYPAD_B;
    else if (strcmp(button, "start") == 0) press_button = RETRO_DEVICE_ID_JOYPAD_START;
    else if (strcmp(button, "select") == 0) press_button = RETRO_DEVICE_ID_JOYPAD_SELECT;
    else if (strcmp(button, "none") == 0) press_button = -1;
    else { fprintf(stderr, "unknown button '%s'\n", button); return 1; }

    fprintf(stderr, "core=%s rom=%s frames=%d press_at=%d button=%s out=%s\n",
            core_path, rom_path, target, press_frame, button, out_path);

    void *core = dlopen(core_path, RTLD_NOW);
    if (!core) { fprintf(stderr, "dlopen: %s\n", dlerror()); die("dlopen core"); }

#define LOAD(fn) typeof(fn) *p_##fn = dlsym(core, #fn); \
        if (!p_##fn) fprintf(stderr, "  WARN: %s not found\n", #fn)
    LOAD(retro_set_environment); LOAD(retro_set_video_refresh);
    LOAD(retro_set_audio_sample); LOAD(retro_set_audio_sample_batch);
    LOAD(retro_set_input_poll); LOAD(retro_set_input_state);
    LOAD(retro_init); LOAD(retro_deinit);
    LOAD(retro_get_system_info); LOAD(retro_get_system_av_info);
    LOAD(retro_load_game); LOAD(retro_unload_game);
    LOAD(retro_run);
    LOAD(retro_set_controller_port_device);
    LOAD(retro_serialize_size); LOAD(retro_serialize); LOAD(retro_unserialize);
#undef LOAD

    if (!p_retro_set_environment || !p_retro_set_video_refresh || !p_retro_load_game || !p_retro_run)
        die("core missing required symbols");

    p_retro_set_environment(environ_cb);
    p_retro_set_video_refresh(video_refresh);
    p_retro_set_audio_sample(audio_sample);
    p_retro_set_audio_sample_batch(audio_sample_batch);
    p_retro_set_input_poll(input_poll);
    p_retro_set_input_state(input_state);

    struct retro_system_info si;
    p_retro_get_system_info(&si);
    fprintf(stderr, "core: %s v%s (ext: %s)\n",
            si.library_name, si.library_version,
            si.valid_extensions ? si.valid_extensions : "(none)");

    p_retro_init();

    /* CRITICAL: without retro_set_controller_port_device(0, JOYPAD),
     * nestopia never wires the gamepad callback and $4016 reads return
     * open-bus (0x40) — the counter never sees input. */
    if (p_retro_set_controller_port_device) {
        p_retro_set_controller_port_device(0, RETRO_DEVICE_JOYPAD);
        p_retro_set_controller_port_device(1, RETRO_DEVICE_JOYPAD);
    } else {
        fprintf(stderr, "WARN: core lacks retro_set_controller_port_device\n");
    }

    FILE *rf = fopen(rom_path, "rb");
    if (!rf) die("fopen rom");
    fseek(rf, 0, SEEK_END);
    long rom_size = ftell(rf);
    fseek(rf, 0, SEEK_SET);
    void *rom_data = malloc(rom_size);
    if (fread(rom_data, 1, rom_size, rf) != (size_t)rom_size) die("fread rom");
    fclose(rf);

    struct retro_game_info game = {
        .path = rom_path,
        .data = rom_data,
        .size = (size_t)rom_size,
    };
    if (!p_retro_load_game(&game)) {
        game.data = NULL;
        game.size = 0;
        if (!p_retro_load_game(&game)) die("retro_load_game");
    }
    fprintf(stderr, "game loaded (%ld bytes)\n", rom_size);

    struct retro_system_av_info av;
    p_retro_get_system_av_info(&av);
    fprintf(stderr, "av: %ux%u @ %.1f fps\n",
            av.geometry.base_width, av.geometry.base_height, av.timing.fps);

    for (int f = 0; f < target; f++)
        p_retro_run();

    if (!last_frame) {
        fprintf(stderr, "ERROR: no frames captured\n");
        return 2;
    }
    fprintf(stderr, "ran %d frames, captured %ux%u (pitch %zu)\n",
            frame_count, last_w, last_h, last_pitch);

    write_ppm(out_path, last_frame, last_w, last_h, last_pitch);
    fprintf(stderr, "wrote %s\n", out_path);

    p_retro_unload_game();
    p_retro_deinit();
    free(rom_data);
    free(last_frame);
    dlclose(core);
    return 0;
}
