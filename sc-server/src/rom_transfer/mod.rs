//! ROM transfer: secure staging, WebRTC sessions, and protocol handling.
//!
//! Uploads flow through: capability auth → WebRTC data channel → staged
//! `.partial` file → atomic commit → library rescan.
//! Downloads resolve opaque game IDs to canonical regular files.

// Binary target sees some items as dead code (used only via library API).
#![allow(dead_code)]

pub mod download;
pub mod protocol;
pub mod session;
pub mod storage;
