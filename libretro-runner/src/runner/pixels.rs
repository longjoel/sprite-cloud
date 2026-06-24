//! Pixel format conversion utilities for libretro framebuffers.
//!
//! Converts XRGB8888, RGB565, and 0RGB1555 to RGB24,
//! with both packed and strided variants.

/// Convert XRGB8888 to RGB24 by dropping the alpha byte from each pixel.
pub(super) fn xrgb8888_to_rgb24(data: &[u8], width: usize, height: usize) -> Vec<u8> {
    let pixel_count = width * height;
    let expected_bytes = pixel_count * 4;
    if data.len() < expected_bytes {
        return Vec::new();
    }

    let mut rgb = Vec::with_capacity(pixel_count * 3);
    // SAFETY: bytemuck cast from &[u8] to &[u32] is safe — u32 has no
    // alignment requirement on x86_64, and we've verified the byte length.
    let pixels: &[u32] = bytemuck::cast_slice(&data[..expected_bytes]);

    for &p in pixels {
        // XRGB8888 layout: 0xXXRRGGBB (little-endian: B, G, R, X in memory)
        rgb.push((p >> 16) as u8); // R
        rgb.push((p >> 8) as u8); // G
        rgb.push(p as u8); // B
    }

    rgb
}

/// Convert RGB565 to RGB24 by unpacking 5-6-5 bit fields into 8-8-8.
pub(super) fn rgb565_to_rgb24(data: &[u8], width: usize, height: usize) -> Vec<u8> {
    let pixel_count = width * height;
    let expected_bytes = pixel_count * 2;
    if data.len() < expected_bytes {
        return Vec::new();
    }

    let mut rgb = Vec::with_capacity(pixel_count * 3);
    let pixels: &[u16] = bytemuck::cast_slice(&data[..expected_bytes]);

    for &p in pixels {
        // RGB565 layout: RRRRRGGGGGGBBBBB (big-endian 16-bit)
        let r = ((p >> 11) & 0x1F) as u8;
        let g = ((p >> 5) & 0x3F) as u8;
        let b = (p & 0x1F) as u8;

        // Scale 5-bit to 8-bit: (x << 3) | (x >> 2)
        // Scale 6-bit to 8-bit: (x << 2) | (x >> 4)
        rgb.push((r << 3) | (r >> 2));
        rgb.push((g << 2) | (g >> 4));
        rgb.push((b << 3) | (b >> 2));
    }

    rgb
}

/// Convert XRGB8888 to RGB24 with proper stride handling.
///
/// `pitch` is the distance in bytes from start of one row to the next.
/// When pitch > width * 4, padding bytes between rows are skipped.
pub(super) fn xrgb8888_to_rgb24_strided(data: &[u8], width: usize, height: usize, pitch: usize) -> Vec<u8> {
    let row_bytes = width * 4;
    let expected_total = pitch * height;
    if data.len() < expected_total {
        return Vec::new();
    }

    let mut rgb = Vec::with_capacity(width * height * 3);
    for row in 0..height {
        let row_start = row * pitch;
        let row_data = &data[row_start..row_start + row_bytes];
        let pixels: &[u32] = bytemuck::cast_slice(row_data);
        for &p in pixels {
            rgb.push((p >> 16) as u8); // R
            rgb.push((p >> 8) as u8); // G
            rgb.push(p as u8); // B
        }
    }
    rgb
}

/// Convert RGB565 to RGB24 with proper stride handling.
///
/// `pitch` is the distance in bytes from start of one row to the next.
/// When pitch > width * 2, padding bytes between rows are skipped.
pub(super) fn rgb565_to_rgb24_strided(data: &[u8], width: usize, height: usize, pitch: usize) -> Vec<u8> {
    let row_bytes = width * 2;
    let expected_total = pitch * height;
    if data.len() < expected_total {
        return Vec::new();
    }

    let mut rgb = Vec::with_capacity(width * height * 3);
    for row in 0..height {
        let row_start = row * pitch;
        let row_data = &data[row_start..row_start + row_bytes];
        let pixels: &[u16] = bytemuck::cast_slice(row_data);
        for &p in pixels {
            let r = ((p >> 11) & 0x1F) as u8;
            let g = ((p >> 5) & 0x3F) as u8;
            let b = (p & 0x1F) as u8;
            rgb.push((r << 3) | (r >> 2));
            rgb.push((g << 2) | (g >> 4));
            rgb.push((b << 3) | (b >> 2));
        }
    }
    rgb
}

/// Convert 0RGB1555 to RGB24 by unpacking 5-5-5 bit fields into 8-8-8.
///
/// 0RGB1555 layout (little-endian u16): bit 15=0(unused), bits 14-10=R,
/// bits 9-5=G, bits 4-0=B. Same as RGB565 but green is 5-bit instead of 6-bit.
pub(super) fn xrgb1555_to_rgb24(data: &[u8], width: usize, height: usize) -> Vec<u8> {
    let pixel_count = width * height;
    let expected_bytes = pixel_count * 2;
    if data.len() < expected_bytes {
        return Vec::new();
    }

    let mut rgb = Vec::with_capacity(pixel_count * 3);
    let pixels: &[u16] = bytemuck::cast_slice(&data[..expected_bytes]);

    for &p in pixels {
        let r = ((p >> 10) & 0x1F) as u8;
        let g = ((p >> 5) & 0x1F) as u8;
        let b = (p & 0x1F) as u8;
        // Scale 5-bit to 8-bit: (x << 3) | (x >> 2)
        rgb.push((r << 3) | (r >> 2));
        rgb.push((g << 3) | (g >> 2));
        rgb.push((b << 3) | (b >> 2));
    }

    rgb
}

/// Convert 0RGB1555 to RGB24 with proper stride handling.
pub(super) fn xrgb1555_to_rgb24_strided(data: &[u8], width: usize, height: usize, pitch: usize) -> Vec<u8> {
    let row_bytes = width * 2;
    let expected_total = pitch * height;
    if data.len() < expected_total {
        return Vec::new();
    }

    let mut rgb = Vec::with_capacity(width * height * 3);
    for row in 0..height {
        let row_start = row * pitch;
        let row_data = &data[row_start..row_start + row_bytes];
        let pixels: &[u16] = bytemuck::cast_slice(row_data);
        for &p in pixels {
            let r = ((p >> 10) & 0x1F) as u8;
            let g = ((p >> 5) & 0x1F) as u8;
            let b = (p & 0x1F) as u8;
            rgb.push((r << 3) | (r >> 2));
            rgb.push((g << 3) | (g >> 2));
            rgb.push((b << 3) | (b >> 2));
        }
    }
    rgb
}
