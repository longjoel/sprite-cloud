//! Test pattern generators for visual verification.
//!
//! These produce raw RGB24 byte buffers at the configured resolution.
//! Used by both the HTTP polling endpoint (`/test-frame`) and the
//! WebRTC video stream for development and debugging.

/// Standard color bar values (SMPTE-style, 8 bars).
const COLOR_BARS: [(u8, u8, u8); 8] = [
    (255, 255, 255), // white
    (255, 255, 0),   // yellow
    (0, 255, 255),   // cyan
    (0, 255, 0),     // green
    (255, 0, 255),   // magenta
    (255, 0, 0),     // red
    (0, 0, 255),     // blue
    (0, 0, 0),       // black
];

/// Bouncing square size as a fraction of frame height.
const SQUARE_FRAC: u32 = 8;

/// Bouncing square speed in pixels per frame.
const BOUNCE_SPEED: u32 = 2;

// ── 8×8 bitmap font (printable ASCII 32–126) ─────────────────────────
// Each glyph is 8 bytes, one per row, MSB = leftmost pixel.
// Only the subset needed for error messages is defined; '?' for missing.

const FONT_DATA: &[(char, [u8; 8])] = &[
    (' ', [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    ('!', [0x18, 0x3c, 0x3c, 0x18, 0x18, 0x00, 0x18, 0x00]),
    ('-', [0x00, 0x00, 0x00, 0x7e, 0x00, 0x00, 0x00, 0x00]),
    ('.', [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x18, 0x00]),
    ('0', [0x3c, 0x66, 0x6e, 0x76, 0x66, 0x66, 0x3c, 0x00]),
    ('1', [0x18, 0x38, 0x18, 0x18, 0x18, 0x18, 0x7e, 0x00]),
    ('3', [0x3c, 0x66, 0x06, 0x1c, 0x06, 0x66, 0x3c, 0x00]),
    ('2', [0x3c, 0x66, 0x06, 0x0c, 0x18, 0x30, 0x7e, 0x00]),
    ('4', [0x0c, 0x1c, 0x2c, 0x4c, 0x7e, 0x0c, 0x0c, 0x00]),
    ('C', [0x3c, 0x66, 0x60, 0x60, 0x60, 0x66, 0x3c, 0x00]),
    ('a', [0x00, 0x00, 0x3c, 0x06, 0x3e, 0x66, 0x3e, 0x00]),
    ('c', [0x00, 0x00, 0x3c, 0x60, 0x60, 0x66, 0x3c, 0x00]),
    ('d', [0x06, 0x06, 0x3e, 0x66, 0x66, 0x66, 0x3e, 0x00]),
    ('e', [0x00, 0x00, 0x3c, 0x66, 0x7e, 0x60, 0x3c, 0x00]),
    ('f', [0x1c, 0x30, 0x7c, 0x30, 0x30, 0x30, 0x30, 0x00]),
    ('h', [0x60, 0x60, 0x7c, 0x66, 0x66, 0x66, 0x66, 0x00]),
    ('i', [0x18, 0x00, 0x38, 0x18, 0x18, 0x18, 0x3c, 0x00]),
    ('k', [0x60, 0x60, 0x66, 0x6c, 0x78, 0x6c, 0x66, 0x00]),
    ('l', [0x38, 0x18, 0x18, 0x18, 0x18, 0x18, 0x3c, 0x00]),
    ('m', [0x00, 0x00, 0x6c, 0x7e, 0x56, 0x56, 0x56, 0x00]),
    ('n', [0x00, 0x00, 0x7c, 0x66, 0x66, 0x66, 0x66, 0x00]),
    ('o', [0x00, 0x00, 0x3c, 0x66, 0x66, 0x66, 0x3c, 0x00]),
    ('p', [0x00, 0x00, 0x7c, 0x66, 0x7c, 0x60, 0x60, 0x00]),
    ('r', [0x00, 0x00, 0x7c, 0x66, 0x60, 0x60, 0x60, 0x00]),
    ('s', [0x00, 0x00, 0x3e, 0x60, 0x3c, 0x06, 0x7c, 0x00]),
    ('t', [0x30, 0x30, 0x7c, 0x30, 0x30, 0x30, 0x1c, 0x00]),
    ('u', [0x00, 0x00, 0x66, 0x66, 0x66, 0x66, 0x3e, 0x00]),
    ('v', [0x00, 0x00, 0x66, 0x66, 0x66, 0x3c, 0x18, 0x00]),
    ('w', [0x00, 0x00, 0x56, 0x56, 0x56, 0x7e, 0x6c, 0x00]),
    ('x', [0x00, 0x00, 0x66, 0x3c, 0x18, 0x3c, 0x66, 0x00]),
    ('y', [0x00, 0x00, 0x66, 0x66, 0x3e, 0x06, 0x3c, 0x00]),
];

fn font_glyph(ch: char) -> [u8; 8] {
    for &(c, g) in FONT_DATA {
        if c == ch {
            return g;
        }
    }
    // '?' placeholder for missing glyphs
    [0x3c, 0x66, 0x06, 0x0c, 0x18, 0x00, 0x18, 0x00]
}

/// Draw a line of text onto an RGB24 buffer at (x0, y0).
fn draw_text(buf: &mut [u8], buf_w: u32, _buf_h: u32, x0: u32, y0: u32, text: &str, color: (u8, u8, u8)) {
    let (cr, cg, cb) = color;
    for (ci, ch) in text.chars().enumerate() {
        let glyph = font_glyph(ch);
        let gx = x0 + (ci as u32) * 8;
        for row in 0..8u32 {
            let row_byte = glyph[row as usize];
            let py = y0 + row;
            for col in 0..8u32 {
                if (row_byte >> (7 - col)) & 1 != 0 {
                    let px = gx + col;
                    if px < buf_w {
                        let idx = ((py * buf_w + px) * 3) as usize;
                        if idx + 2 < buf.len() {
                            buf[idx] = cr;
                            buf[idx + 1] = cg;
                            buf[idx + 2] = cb;
                        }
                    }
                }
            }
        }
    }
}

/// Generate an error screen with a message centered on a dark background.
/// Shows "Core failed to load" with a brief explanation below.
pub fn generate_error_screen(
    width: u32,
    height: u32,
    title: &str,
    subtitle: &str,
) -> Vec<u8> {
    let mut buf = vec![0x10u8; (width * height * 3) as usize]; // dark grey bg

    // Title — white, centered
    let title_x = (width as i32 - (title.len() as i32 * 8)) / 2;
    let title_x = if title_x > 0 { title_x as u32 } else { 4 };
    draw_text(&mut buf, width, height, title_x, height / 2 - 12, title, (240, 240, 240));

    // Subtitle — dim, centered below
    if !subtitle.is_empty() {
        let sub_x = (width as i32 - (subtitle.len() as i32 * 8)) / 2;
        let sub_x = if sub_x > 0 { sub_x as u32 } else { 4 };
        draw_text(&mut buf, width, height, sub_x, height / 2 + 4, subtitle, (140, 140, 140));
    }

    buf
}

/// Generate an SMPTE-style color bar pattern.
pub fn generate_color_bars(width: u32, height: u32, _frame: u64) -> Vec<u8> {
    let bar_width = width / 8;
    let mut buf = vec![0u8; (width * height * 3) as usize];
    for y in 0..height {
        for x in 0..width {
            let bar = (x / bar_width).min(7) as usize;
            let (r, g, b) = COLOR_BARS[bar];
            let idx = ((y * width + x) * 3) as usize;
            buf[idx] = r;
            buf[idx + 1] = g;
            buf[idx + 2] = b;
        }
    }
    buf
}

/// Generate a frame with a cyan square bouncing around the screen.
pub fn generate_bouncing_square(width: u32, height: u32, frame: u64) -> Vec<u8> {
    let square_size = height / SQUARE_FRAC;
    let max_x = width - square_size;
    let max_y = height - square_size;

    let x = (frame.wrapping_mul(BOUNCE_SPEED as u64) % (max_x as u64 * 2)) as u32;
    let x = if x > max_x { max_x * 2 - x } else { x };

    let y = (frame.wrapping_mul(BOUNCE_SPEED as u64 * 3) % (max_y as u64 * 2)) as u32;
    let y = if y > max_y { max_y * 2 - y } else { y };

    let mut buf = vec![0u8; (width * height * 3) as usize];
    for py in y..y + square_size {
        for px in x..x + square_size {
            let idx = ((py * width + px) * 3) as usize;
            buf[idx] = 0;
            buf[idx + 1] = 255;
            buf[idx + 2] = 255;
        }
    }
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_screen_renders_text() {
        let data = generate_error_screen(320, 240, "error", "details");
        assert_eq!(data.len(), 320 * 240 * 3);
        // Should have non-background pixels (text was drawn)
        let non_bg = data.iter().filter(|&&b| b != 0x10).count();
        assert!(non_bg > 100, "error screen should have visible text");
    }

    #[test]
    fn error_screen_clips_overflow_text() {
        let data = generate_error_screen(100, 60, "very long text that overflows", "sub");
        assert_eq!(data.len(), 100 * 60 * 3);
    }

    #[test]
    fn color_bars_returns_correct_size() {
        let data = generate_color_bars(320, 240, 0);
        assert_eq!(data.len(), 320 * 240 * 3);
    }

    #[test]
    fn bouncing_square_returns_correct_size() {
        let data = generate_bouncing_square(320, 240, 0);
        assert_eq!(data.len(), (320 * 240 * 3) as usize);
    }

    #[test]
    fn bouncing_square_moves_over_time() {
        let frame0 = generate_bouncing_square(320, 240, 0);
        let frame1 = generate_bouncing_square(320, 240, 1);
        assert_ne!(frame0, frame1, "consecutive frames must differ");
    }
}
