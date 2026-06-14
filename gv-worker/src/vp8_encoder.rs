//! libvpx VP8 encoder via FFI (env-libvpx-sys).
//!
//! Thin unsafe wrapper around libvpx 1.14.0. The encoder takes raw
//! RGB24 frames, converts to I420 (BT.601), and produces VP8 bitstream
//! packets suitable for WebRTC RTP payloading.

use std::mem::MaybeUninit;
use vpx_sys::*;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/// Errors that can occur during VP8 encoding.
#[derive(Debug, Clone)]
pub enum VpxError {
    /// Encoder configuration failed (invalid params, ABI mismatch, etc.)
    Config(String),
    /// Encoder initialisation failed
    Init(String),
    /// Frame encoding failed
    Encode(String),
    /// Input buffer too small for the configured dimensions
    BufferTooSmall { expected: usize, got: usize },
    /// Dimensions must be even (I420 chroma subsampling requirement)
    OddDimensions { width: u32, height: u32 },
}

impl std::fmt::Display for VpxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Config(msg) => write!(f, "VPX config error: {}", msg),
            Self::Init(msg) => write!(f, "VPX init error: {}", msg),
            Self::Encode(msg) => write!(f, "VPX encode error: {}", msg),
            Self::BufferTooSmall { expected, got } => {
                write!(f, "buffer too small: need {} bytes, got {}", expected, got)
            }
            Self::OddDimensions { width, height } => {
                write!(f, "dimensions must be even, got {}×{}", width, height)
            }
        }
    }
}

impl std::error::Error for VpxError {}

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

/// libvpx VP8 encoder instance.
///
/// # Safety
///
/// `Vp8Encoder` owns a `vpx_codec_ctx_t` allocated by libvpx. The context
/// is destroyed in `Drop`. `vpx_codec_ctx_t` is not `Sync` (libvpx contexts
/// are not reentrant), but it IS safe to `Send` — ownership transfer between
/// threads is fine as long as only one thread accesses the context at a time
/// (guaranteed by `&mut self` on `encode`).
pub struct Vp8Encoder {
    ctx: vpx_codec_ctx_t,
    width: u32,
    height: u32,
    /// Tracks whether the next frame should be a keyframe.
    need_keyframe: bool,
}

impl std::fmt::Debug for Vp8Encoder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Vp8Encoder")
            .field("width", &self.width)
            .field("height", &self.height)
            .field("need_keyframe", &self.need_keyframe)
            .finish_non_exhaustive()
    }
}

// SAFETY: vpx_codec_ctx_t is not Sync (no concurrent access), but ownership
// transfer between threads is safe. encode() takes &mut self, guaranteeing
// exclusive access.
unsafe impl Send for Vp8Encoder {}

/// Realtime deadline — encoder must produce output with minimal latency,
/// no frame reordering or lookahead. Required for interactive streaming.
const DL_REALTIME: u64 = 1;

impl Vp8Encoder {
    /// Create a new VP8 encoder.
    ///
    /// `width` and `height` must both be even (I420 chroma subsampling).
    pub fn new(width: u32, height: u32) -> Result<Self, VpxError> {
        // I420 requires even dimensions
        if !width.is_multiple_of(2) || !height.is_multiple_of(2) {
            return Err(VpxError::OddDimensions { width, height });
        }

        unsafe {
            let iface = vpx_codec_vp8_cx();

            // Use MaybeUninit — struct has types (vpx_bit_depth, etc.) that
            // can't be zero-initialized. vpx_codec_enc_config_default fills
            // all fields with valid values.
            let mut cfg = MaybeUninit::<vpx_codec_enc_cfg_t>::uninit();
            // usage=0: generic / good-quality encoder profile
            let err = vpx_codec_enc_config_default(iface, cfg.as_mut_ptr(), 0);
            if err != VPX_CODEC_OK {
                return Err(VpxError::Config(format!("{:?}", err)));
            }
            let mut cfg = cfg.assume_init();

            cfg.g_w = width;
            cfg.g_h = height;
            // Timebase: 1/30 second per tick — one tick = one frame at 30fps
            cfg.g_timebase.num = 1;
            cfg.g_timebase.den = crate::config::VIDEO_FPS as i32;
            cfg.rc_target_bitrate = crate::config::target_bitrate_kbps();
            // Error-resilient: enables intra-refresh and partition boundaries
            // so the browser can recover from packet loss mid-stream
            cfg.g_error_resilient = 1;

            let mut ctx = MaybeUninit::<vpx_codec_ctx_t>::uninit();
            // flags=0: no VPX_CODEC_USE_* flags needed for basic encoding
            let err = vpx_codec_enc_init_ver(
                ctx.as_mut_ptr(),
                iface,
                &cfg as *const _,
                0,
                VPX_ENCODER_ABI_VERSION as i32,
            );
            if err != VPX_CODEC_OK {
                let detail = vpx_codec_error_detail(ctx.as_mut_ptr());
                let detail_str = if detail.is_null() {
                    "unknown".to_string()
                } else {
                    std::ffi::CStr::from_ptr(detail)
                        .to_string_lossy()
                        .into_owned()
                };
                return Err(VpxError::Init(format!("{:?} ({})", err, detail_str)));
            }
            let ctx = ctx.assume_init();

            Ok(Vp8Encoder {
                ctx,
                width,
                height,
                need_keyframe: true,
            })
        }
    }

    /// Encode a raw RGB24 frame to VP8.
    ///
    /// `rgb` must be at least `width * height * 3` bytes.
    /// The first frame is always a keyframe; subsequent frames are delta
    /// frames for bandwidth efficiency (unless the encoder decides
    /// otherwise internally).
    ///
    /// Returns the encoded bitstream and a flag indicating whether this
    /// frame is a keyframe.
    pub fn encode(&mut self, rgb: &[u8]) -> Result<(Vec<u8>, bool), VpxError> {
        let expected = self.width as usize * self.height as usize * 3;
        if rgb.len() < expected {
            return Err(VpxError::BufferTooSmall {
                expected,
                got: rgb.len(),
            });
        }

        unsafe {
            let mut img = MaybeUninit::<vpx_image_t>::uninit();

            let (y_plane, u_plane, v_plane) =
                rgb_to_i420(rgb, self.width as usize, self.height as usize);

            // vpx_img_wrap returns null on failure (e.g. allocation error).
            // We must check it before assuming img is valid.
            let img_ptr = vpx_img_wrap(
                img.as_mut_ptr(),
                vpx_img_fmt_t::VPX_IMG_FMT_I420,
                self.width,
                self.height,
                1,
                std::ptr::null_mut(),
            );
            if img_ptr.is_null() {
                return Err(VpxError::Encode(
                    "vpx_img_wrap failed (allocation error)".into(),
                ));
            }
            let mut img = img.assume_init();

            // Overwrite plane pointers with our I420 data.
            // vpx_img_wrap allocates its own planes when data is null;
            // we replace them with our manually-converted buffers.
            let y_ptr = y_plane.as_ptr() as *mut u8;
            let u_ptr = u_plane.as_ptr() as *mut u8;
            let v_ptr = v_plane.as_ptr() as *mut u8;

            img.planes[0] = y_ptr as *mut _;
            img.planes[1] = u_ptr as *mut _;
            img.planes[2] = v_ptr as *mut _;
            // I420 chroma planes are half-width and half-height (4:2:0 subsampling)
            img.stride[0] = self.width as i32;
            img.stride[1] = (self.width / 2) as i32;
            img.stride[2] = (self.width / 2) as i32;

            // Encode: only force a keyframe on the very first frame.
            // After that, let the encoder decide — it will insert periodic
            // keyframes (default every 9999 frames) and intra-refresh blocks
            // (because g_error_resilient is set).
            let flags = if self.need_keyframe {
                self.need_keyframe = false;
                VPX_EFLAG_FORCE_KF as i64
            } else {
                0
            };

            let err = vpx_codec_encode(
                &mut self.ctx as *mut _,
                &img as *const _,
                1,            // pts: frame number in timebase units
                1,            // duration: one timebase unit per frame
                flags,
                DL_REALTIME,  // realtime deadline — no frame reordering
            );

            // vpx_codec_encode copies the frame data before returning
            // (realtime deadline guarantees synchronous behaviour), so
            // it's safe to drop the I420 planes here.
            drop(y_plane);
            drop(u_plane);
            drop(v_plane);

            if err != VPX_CODEC_OK {
                return Err(VpxError::Encode(format!("{:?}", err)));
            }

            let mut packets = Vec::new();
            let mut is_keyframe = false;
            let mut iter: vpx_codec_iter_t = std::ptr::null();
            loop {
                let pkt = vpx_codec_get_cx_data(&mut self.ctx as *mut _, &mut iter);
                if pkt.is_null() {
                    break;
                }
                let pkt = &*pkt;
                if pkt.kind == vpx_codec_cx_pkt_kind::VPX_CODEC_CX_FRAME_PKT {
                    let frame = &pkt.data.frame;
                    let data = std::slice::from_raw_parts(
                        frame.buf as *const u8,
                        frame.sz as usize,
                    );
                    packets.extend_from_slice(data);
                    if frame.flags & vpx_sys::VPX_FRAME_IS_KEY != 0 {
                        is_keyframe = true;
                    }
                }
            }

            Ok((packets, is_keyframe))
        }
    }
}

impl Drop for Vp8Encoder {
    fn drop(&mut self) {
        unsafe {
            vpx_codec_destroy(&mut self.ctx as *mut _);
        }
    }
}

// ---------------------------------------------------------------------------
// RGB → I420 conversion (BT.601, 4:2:0)
// ---------------------------------------------------------------------------

/// Convert RGB24 to I420 (planar 4:2:0 YUV).
///
/// Uses BT.601 coefficients for RGB→YUV conversion (the standard for SD
/// digital video). Chroma planes are subsampled 2:1 both horizontally
/// and vertically.
fn rgb_to_i420(rgb: &[u8], width: usize, height: usize) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let frame_size = width * height;
    let uv_size = (width / 2) * (height / 2);
    let mut y = vec![0u8; frame_size];
    let mut u = vec![0u8; uv_size];
    let mut v = vec![0u8; uv_size];

    for row in 0..height {
        for col in 0..width {
            let rgb_idx = (row * width + col) * 3;
            let r = rgb[rgb_idx] as f32;
            let g = rgb[rgb_idx + 1] as f32;
            let b = rgb[rgb_idx + 2] as f32;

            // BT.601 full-swing luminance
            let y_val = (0.299 * r + 0.587 * g + 0.114 * b).clamp(0.0, 255.0) as u8;
            y[row * width + col] = y_val;

            // Chroma subsampling: one U/V sample per 2×2 block
            if row % 2 == 0 && col % 2 == 0 {
                let uv_idx = (row / 2) * (width / 2) + (col / 2);
                // BT.601 chroma (centered at 128)
                let u_val = (-0.169 * r - 0.331 * g + 0.5 * b + 128.0).clamp(0.0, 255.0) as u8;
                let v_val = (0.5 * r - 0.419 * g - 0.081 * b + 128.0).clamp(0.0, 255.0) as u8;
                u[uv_idx] = u_val;
                v[uv_idx] = v_val;
            }
        }
    }

    (y, u, v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rgb_to_i420_sizes() {
        let rgb = vec![0u8; 320 * 240 * 3];
        let (y, u, v) = rgb_to_i420(&rgb, 320, 240);
        assert_eq!(y.len(), 320 * 240);
        assert_eq!(u.len(), 160 * 120);
        assert_eq!(v.len(), 160 * 120);
    }

    #[test]
    fn test_rejects_odd_width() {
        let err = Vp8Encoder::new(321, 240).unwrap_err();
        assert!(matches!(err, VpxError::OddDimensions { .. }));
    }

    #[test]
    fn test_rejects_undersized_buffer() {
        let mut enc = Vp8Encoder::new(320, 240).unwrap();
        let too_small = vec![0u8; 100];
        let err = enc.encode(&too_small).unwrap_err();
        assert!(matches!(err, VpxError::BufferTooSmall { .. }));
    }

    #[test]
    fn test_first_frame_is_keyframe() {
        let mut enc = Vp8Encoder::new(320, 240).unwrap();
        let rgb = vec![128u8; 320 * 240 * 3];
        let result = enc.encode(&rgb);
        assert!(
            result.is_ok(),
            "first frame must encode: {:?}",
            result.err()
        );
        let (data, is_key) = result.unwrap();
        assert!(!data.is_empty(), "first frame must produce data");
        assert!(is_key, "first frame must be a keyframe");
    }
}
