use image::{Rgb, RgbImage};

/// Scrolling SMPTE color bars. Each frame shifts one row.
pub fn generate_color_bars(width: u32, height: u32, frame: u64) -> Vec<u8> {
    let colors = [
        Rgb([192, 192, 192]), // white
        Rgb([192, 192, 0]),   // yellow
        Rgb([0, 192, 192]),   // cyan
        Rgb([0, 192, 0]),     // green
        Rgb([192, 0, 192]),   // magenta
        Rgb([192, 0, 0]),     // red
        Rgb([0, 0, 192]),     // blue
    ];

    let bar_width = (width / 7).max(1);
    let scroll_offset = (frame % height as u64) as u32;

    let mut img = RgbImage::new(width, height);
    for y in 0..height {
        let y_scrolled = (y + scroll_offset) % height;
        for x in 0..width {
            let bar = ((x / bar_width) as usize).min(6);
            img.put_pixel(x, y_scrolled, colors[bar]);
        }
    }

    img.into_raw()
}

/// Bouncing cyan square on dark background.
pub fn generate_bouncing_square(width: u32, height: u32, frame: u64) -> Vec<u8> {
    let size = 60u32;
    let speed = 2u64;
    let max_x = width.saturating_sub(size);
    let max_y = height.saturating_sub(size);

    let total = frame * speed;
    let period_x = max_x as u64 * 2;
    let period_y = max_y as u64 * 2;

    let x = if period_x > 0 {
        if (total / period_x) % 2 == 0 {
            (total % period_x) as u32
        } else {
            max_x.saturating_sub((total % period_x) as u32)
        }
    } else {
        0
    };

    let y = if period_y > 0 {
        if (total / period_y) % 2 == 0 {
            (total % period_y) as u32
        } else {
            max_y.saturating_sub((total % period_y) as u32)
        }
    } else {
        0
    };

    let mut img = RgbImage::from_pixel(width, height, Rgb([16, 16, 24]));
    for dy in 0..size.min(height) {
        for dx in 0..size.min(width) {
            let px = (x.saturating_add(dx)).min(width.saturating_sub(1));
            let py = (y.saturating_add(dy)).min(height.saturating_sub(1));
            img.put_pixel(px, py, Rgb([34, 211, 238]));
        }
    }

    img.into_raw()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn color_bars_returns_correct_size() {
        let frame = generate_color_bars(320, 240, 0);
        assert_eq!(frame.len(), (320 * 240 * 3) as usize);
    }

    #[test]
    fn bouncing_square_returns_correct_size() {
        let frame = generate_bouncing_square(320, 240, 0);
        assert_eq!(frame.len(), (320 * 240 * 3) as usize);
    }

    #[test]
    fn bouncing_square_moves_over_time() {
        let frame0 = generate_bouncing_square(320, 240, 0);
        let frame1 = generate_bouncing_square(320, 240, 1);
        assert_ne!(frame0, frame1);
    }
}
