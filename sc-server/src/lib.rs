// The library target exists for integration tests. The production runtime is
// wired through main.rs, so binary-only handlers appear dead when Cargo checks
// this target in isolation.
#![allow(dead_code)]

pub mod commands;
pub mod config;
pub mod core_bridge;
pub mod dat;
pub mod encoder_probe;
pub mod gst_audio;
pub mod gst_video;
pub mod library_state;
pub mod platform;
pub mod player_server;
pub mod retry;
pub mod rom_transfer;
pub mod saves;
pub mod sc_web;
pub mod scan;
pub mod session;
pub mod streaming;
pub mod upgrade;
pub mod webrtc;
