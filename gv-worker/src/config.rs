// Video pipeline configuration.
//
// Resolution: 320×240 QVGA
//   Chosen for low bandwidth and CPU overhead during development.
//   The real resolution will come from the emulator core at runtime.
//
// Frame rate: 30 fps
//   Matches NTSC console output (29.97 ~ 30). The RTP clock is 90 kHz
//   (VP8 standard), giving a timestamp increment of 90_000 / 30 = 3_000.
//
// Bitrate: 500 kbps VP8 (CBR)
//   Conservative default for 320×240 — high enough to avoid macroblocking
//   on fast motion, low enough for a real-time LAN stream.

/// Video frame width in pixels.
pub const VIDEO_WIDTH: u32 = 320;

/// Video frame height in pixels.
pub const VIDEO_HEIGHT: u32 = 240;

/// Target frames per second.
pub const VIDEO_FPS: u32 = 30;

/// Duration of one frame in milliseconds.
pub const FRAME_INTERVAL_MS: u64 = 1000 / VIDEO_FPS as u64; // 33

/// VP8 RTP clock rate (Hz). Standard for VP8 payload.
pub const VP8_CLOCK_RATE: u32 = 90_000;

/// RTP timestamp increment per frame (clock_rate / fps).
pub const RTP_TIMESTAMP_INCREMENT: u32 = VP8_CLOCK_RATE / VIDEO_FPS; // 3000

/// Target encoder bitrate in kbps.
pub const TARGET_BITRATE_KBPS: u32 = 500;

/// STUN server for NAT traversal.
/// Google's public STUN is fine for LAN development;
/// production should use a dedicated TURN server.
pub const STUN_SERVER: &str = "stun:stun.l.google.com:19302";

/// WebRTC track ID sent in SDP.
pub const TRACK_ID: &str = "video";

/// WebRTC stream ID (msid) sent in SDP.
pub const STREAM_ID: &str = "gv-worker";

/// How often to emit a diagnostic log line (in frames).
/// Logs frame 1-3 always, then every N frames thereafter.
pub const DIAG_LOG_INTERVAL: u64 = 90; // ~every 3 seconds at 30 fps

/// ICE gathering timeout in seconds.
/// If the WebRTC handshake can't finish gathering candidates within this
/// window, the SDP exchange is aborted.
pub const ICE_GATHERING_TIMEOUT_SECS: u64 = 10;
