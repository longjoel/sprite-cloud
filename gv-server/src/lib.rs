pub mod commands;
pub mod config;
pub mod core_bridge;
pub mod dat;
pub mod encoder_probe;
pub mod gst_audio;
pub mod gst_video;
pub mod gv_web;
// pub mod local;  // TODO: rewrite for in-process sessions
pub mod platform;
pub mod retry;
pub mod saves;
pub mod scan;
pub mod session;
pub mod streaming;
pub mod webrtc;
// pub mod ws;  // WebSocket client — not yet active; using HTTP polling
