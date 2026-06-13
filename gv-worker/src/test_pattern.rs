//! Test pattern generators for visual verification.
//!
//! These produce raw RGB24 byte buffers at the configured resolution.
//! Used by both the HTTP polling endpoint (`/test-frame`) and the
//! WebRTC video stream for development and debugging.

#[allow(unused_imports)]
use crate::config::{VIDEO_HEIGHT, VIDEO_WIDTH};

/// Standard color bar values (SMPTE-style, 8 bars).
/// RGB tuples for a basic color bar pattern at full intensity.
#[allow(dead_code)]
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
const SQUARE_FRAC: u32 = 8; // 240/8 = 30px

/// Bouncing square speed in pixels per frame.
const BOUNCE_SPEED: u32 = 2;

/// Generate an SMPTE-style color bar pattern.
///
/// Divides the frame into 8 vertical bars. Frame number is unused
/// (static pattern) but kept for API consistency with bouncing_square.
#[allow(dead_code)]
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
///
/// The square moves diagonally, bouncing off frame edges.
/// Position is deterministic from `frame` — useful for verifying
/// frame sequencing in both HTTP and WebRTC paths.
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
            buf[idx] = 0;     // R
            buf[idx + 1] = 255; // G
            buf[idx + 2] = 255; // B — cyan
        }
    }
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn color_bars_returns_correct_size() {
        let data = generate_color_bars(320, 240, 0);
        assert_eq!(data.len(), 320 * 240 * 3);
    }

    #[test]
    fn bouncing_square_returns_correct_size() {
        let data = generate_bouncing_square(VIDEO_WIDTH, VIDEO_HEIGHT, 0);
        assert_eq!(data.len(), (VIDEO_WIDTH * VIDEO_HEIGHT * 3) as usize);
    }

    #[test]
    fn bouncing_square_moves_over_time() {
        let frame0 = generate_bouncing_square(VIDEO_WIDTH, VIDEO_HEIGHT, 0);
        let frame1 = generate_bouncing_square(VIDEO_WIDTH, VIDEO_HEIGHT, 1);
        assert_ne!(frame0, frame1, "consecutive frames must differ");
    }
}
