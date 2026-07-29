//! ROM transfer: secure staging, WebRTC sessions, and protocol handling.
//!
//! Uploads flow through: capability auth → WebRTC data channel → staged
//! `.partial` file → atomic commit → library rescan.
//! Downloads resolve opaque game IDs to canonical regular files.

pub mod session;
pub mod storage;
