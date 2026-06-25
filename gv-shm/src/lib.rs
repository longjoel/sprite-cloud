//! Shared-memory ring buffer for IPC between gv-server and gv-worker.
//!
//! ## Layout
//!
//! ```text
//! Header (64 bytes):
//!   magic(u32) | frame_count(u32) | write_pos(AtomicU32) | read_pos(AtomicU32) | _pad[48]
//!
//! Frames (frame_count × 16384 bytes each):
//!   frame_type(u32) | size(u32) | timestamp_us(u32) | data[16372]
//! ```
//!
//! ## Usage
//!
//! - **Writer** (gv-worker): `ShmRing::create(name, N)` or `ShmRing::open(name)`,
//!   then call `write_frame(ty, data, ts)`.
//! - **Reader** (gv-server): `ShmRing::open(name)`, then call `read_frame()`.
//!
//! Single-writer, single-reader — no mutex required.
//! Atomic ordering (Release/Acquire) ensures frame data visibility.

use std::ffi::CString;
use std::io;
use std::ptr;
use std::sync::atomic::{AtomicU32, Ordering};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Magic value identifying our shared-memory segments: "GVFS" → 0x47564653
const MAGIC: u32 = 0x4756_4653;

/// Default ring capacity in frames (~4 MiB with the default 16 KiB frame size).
pub const DEFAULT_FRAME_COUNT: u32 = 256;

/// Maximum frame payload size in bytes.
const MAX_FRAME_SIZE: usize = 16384; // 16 KiB

/// Header size in bytes (must match `ShmHeader` layout).
const HEADER_SIZE: usize = 64;

// ---------------------------------------------------------------------------
// Frame-type constants
// ---------------------------------------------------------------------------

/// Well-known frame types.
pub mod frame_type {
    /// H.264 encoded video
    pub const VIDEO: u32 = 0;
    /// Opus encoded audio
    pub const AUDIO: u32 = 1;
    /// Input events (keyboard, mouse, gamepad)
    pub const INPUT: u32 = 2;
    /// Health / heartbeat / status
    pub const HEALTH: u32 = 3;
}

// ---------------------------------------------------------------------------
// Shared-memory layout types
// ---------------------------------------------------------------------------

/// Header at the beginning of the shared-memory region.
///
/// 64 bytes total.  Alignment of 64 keeps the first frame cache-line aligned
/// and gives a clean separation on most architectures.
#[repr(C, align(64))]
struct ShmHeader {
    magic: u32,
    frame_count: u32,
    /// Advanced by the writer after storing a frame.
    write_pos: AtomicU32,
    /// Advanced by the reader after consuming a frame.
    read_pos: AtomicU32,
    /// Explicit padding to reach 64 bytes.
    _pad: [u8; 48],
}

/// A single frame slot inside the ring.
///
/// Total size: 4 + 4 + 4 + 16372 = 16384 bytes.
#[repr(C)]
struct ShmFrame {
    frame_type: u32,
    size: u32,
    timestamp_us: u32,
    data: [u8; MAX_FRAME_SIZE - 12],
}

// ---------------------------------------------------------------------------
// ShmRing
// ---------------------------------------------------------------------------

/// A handle to a shared-memory ring buffer.
///
/// **Drop behaviour**:
/// - Always calls `munmap` and `close`.
/// - If the segment was *created* by this handle (`ShmRing::create`) it also
///   calls `shm_unlink`, removing the name from the kernel namespace.
///
/// # Safety
///
/// Implements `Send + Sync` because the underlying shared memory is designed
/// for multi-process access and the struct only holds a raw pointer + fd.
pub struct ShmRing {
    /// Name passed to `shm_open` (with leading `/` prepended if needed).
    name: String,
    /// File descriptor for the shared-memory object.
    fd: i32,
    /// Pointer to the start of the mapped region.
    ptr: *mut u8,
    /// Total size of the mapped region in bytes.
    size: usize,
    /// Number of frame slots.
    frame_count: u32,
    /// `true` if this handle created the segment → calls `shm_unlink` on drop.
    owned: bool,
}

// SAFETY: raw pointer + fd are not thread-safe by default in Rust's model, but
// the shared memory itself is mmap'd MAP_SHARED and uses atomics for
// synchronisation.  The struct has no other interior mutability.
unsafe impl Send for ShmRing {}
unsafe impl Sync for ShmRing {}

impl std::fmt::Debug for ShmRing {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ShmRing")
            .field("name", &self.name)
            .field("fd", &self.fd)
            .field("ptr", &self.ptr)
            .field("size", &self.size)
            .field("frame_count", &self.frame_count)
            .field("owned", &self.owned)
            .finish()
    }
}

impl ShmRing {
    // ------------------------------------------------------------------
    // Constructors
    // ------------------------------------------------------------------

    /// Create a new shared-memory ring buffer.
    ///
    /// `name` is the identifier passed to `shm_open`.  A leading `/` is
    /// prepended automatically if not present (Linux convention).
    /// `frame_count` must be ≥ 2 (need at least one free slot for the
    /// producer-consumer algorithm to distinguish full from empty).
    ///
    /// Uses `O_CREAT | O_EXCL` — fails with `io::ErrorKind::AlreadyExists`
    /// if a segment with the given name already exists.
    pub fn create(name: &str, frame_count: u32) -> io::Result<Self> {
        assert!(frame_count >= 2, "frame_count must be at least 2");

        let size = HEADER_SIZE + (frame_count as usize) * MAX_FRAME_SIZE;
        let shm_name = shm_name(name);
        let cname = to_cstring(&shm_name)?;

        // shm_open with O_CREAT | O_EXCL – fails if segment exists.
        let fd = unsafe {
            libc::shm_open(cname.as_ptr(), libc::O_CREAT | libc::O_RDWR | libc::O_EXCL, 0o644)
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }

        // Set size of the shared-memory object.
        if unsafe { libc::ftruncate(fd, size as libc::off_t) } != 0 {
            let e = io::Error::last_os_error();
            unsafe {
                libc::close(fd);
                libc::shm_unlink(cname.as_ptr());
            }
            return Err(e);
        }

        // Map it into our address space.
        let ptr = unsafe {
            libc::mmap(
                ptr::null_mut(),
                size,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_SHARED,
                fd,
                0,
            )
        };
        if ptr == libc::MAP_FAILED {
            let e = io::Error::last_os_error();
            unsafe {
                libc::close(fd);
                libc::shm_unlink(cname.as_ptr());
            }
            return Err(e);
        }

        // Initialise the header.
        let header = ptr as *mut ShmHeader;
        unsafe {
            (*header).magic = MAGIC;
            (*header).frame_count = frame_count;
            // write_pos / read_pos are already 0 (ftruncate zero-fills on Linux).
            // Zero the padding bytes for cleanliness.
            ptr::write_bytes(ptr::addr_of_mut!((*header)._pad) as *mut u8, 0, 48);
        }

        Ok(ShmRing {
            name: shm_name,
            fd,
            ptr: ptr as *mut u8,
            size,
            frame_count,
            owned: true,
        })
    }

    /// Open an existing shared-memory ring buffer.
    ///
    /// Verifies the magic number in the header.  Returns
    /// `io::ErrorKind::InvalidData` if the segment exists but was not created
    /// by this module.
    pub fn open(name: &str) -> io::Result<Self> {
        let shm_name = shm_name(name);
        let cname = to_cstring(&shm_name)?;

        let fd = unsafe { libc::shm_open(cname.as_ptr(), libc::O_RDWR, 0o644) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }

        // Map only the header first so we can read frame_count.
        let ptr = unsafe {
            libc::mmap(
                ptr::null_mut(),
                HEADER_SIZE,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_SHARED,
                fd,
                0,
            )
        };
        if ptr == libc::MAP_FAILED {
            let e = io::Error::last_os_error();
            unsafe {
                libc::close(fd);
            }
            return Err(e);
        }

        let header = ptr as *const ShmHeader;
        let magic = unsafe { (*header).magic };
        if magic != MAGIC {
            let e = io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "bad magic: expected 0x{MAGIC:08X}, got 0x{magic:08X}",
                    MAGIC = MAGIC,
                    magic = magic,
                ),
            );
            unsafe {
                libc::munmap(ptr, HEADER_SIZE);
                libc::close(fd);
            }
            return Err(e);
        }

        let frame_count = unsafe { (*header).frame_count };
        let size = HEADER_SIZE + (frame_count as usize) * MAX_FRAME_SIZE;

        // Remap with the full size.
        unsafe {
            libc::munmap(ptr, HEADER_SIZE);
        }
        let ptr = unsafe {
            libc::mmap(
                ptr::null_mut(),
                size,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_SHARED,
                fd,
                0,
            )
        };
        if ptr == libc::MAP_FAILED {
            let e = io::Error::last_os_error();
            unsafe {
                libc::close(fd);
            }
            return Err(e);
        }

        Ok(ShmRing {
            name: shm_name,
            fd,
            ptr: ptr as *mut u8,
            size,
            frame_count,
            owned: false,
        })
    }

    // ------------------------------------------------------------------
    // Core operations
    // ------------------------------------------------------------------

    /// Write a frame into the ring (writer-side).
    ///
    /// Returns `io::ErrorKind::WouldBlock` when the ring is full
    /// (i.e. `(write_pos + 1) % frame_count == read_pos`).
    pub fn write_frame(&self, frame_type: u32, data: &[u8], timestamp_us: u32) -> io::Result<()> {
        if data.len() > MAX_FRAME_SIZE - 12 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "data too large: {} bytes (max {})",
                    data.len(),
                    MAX_FRAME_SIZE - 12
                ),
            ));
        }

        let header = self.header_ptr();

        // Acquire on read_pos so we observe the reader's latest advancement.
        let read_pos = unsafe { (*header).read_pos.load(Ordering::Acquire) };
        let write_pos = unsafe { (*header).write_pos.load(Ordering::Relaxed) };

        let next_write = (write_pos + 1) % self.frame_count;
        if next_write == read_pos {
            return Err(io::Error::new(io::ErrorKind::WouldBlock, "ring buffer full"));
        }

        let frame = self.frame_ptr(write_pos);
        unsafe {
            (*frame).frame_type = frame_type;
            (*frame).size = data.len() as u32;
            (*frame).timestamp_us = timestamp_us;
            ptr::copy_nonoverlapping(data.as_ptr(), (*frame).data.as_mut_ptr(), data.len());
        }

        // Release: frame data must be visible before the position update.
        unsafe {
            (*header).write_pos.store(next_write, Ordering::Release);
        }

        Ok(())
    }

    /// Read the next frame from the ring (reader-side).
    ///
    /// Returns `None` when the buffer is empty (`read_pos == write_pos`).
    /// Otherwise returns `Some((frame_type, data, timestamp_us))`.
    pub fn read_frame(&self) -> Option<(u32, Vec<u8>, u32)> {
        let header = self.header_ptr();

        // Acquire on write_pos to observe the writer's latest frame.
        let write_pos = unsafe { (*header).write_pos.load(Ordering::Acquire) };
        let read_pos = unsafe { (*header).read_pos.load(Ordering::Relaxed) };

        if read_pos == write_pos {
            return None;
        }

        let frame = self.frame_ptr(read_pos);
        let (frame_type, _size, timestamp, data) = unsafe {
            let ft = (*frame).frame_type;
            let sz = (*frame).size as usize;
            let ts = (*frame).timestamp_us;
            // Copy the data out of shared memory — we must not hand out a
            // reference into mmap'd memory whose lifetime we don't control.
            let mut buf = Vec::with_capacity(sz);
            ptr::copy_nonoverlapping((*frame).data.as_ptr(), buf.as_mut_ptr(), sz);
            buf.set_len(sz);
            (ft, sz, ts, buf)
        };

        let next_read = (read_pos + 1) % self.frame_count;
        // Release: ensure the read is complete before the writer sees the
        // new read_pos (so the writer knows the slot is free).
        unsafe {
            (*header).read_pos.store(next_read, Ordering::Release);
        }

        Some((frame_type, data, timestamp))
    }

    // ------------------------------------------------------------------
    // Query helpers
    // ------------------------------------------------------------------

    /// Number of frames currently available to read.
    pub fn available(&self) -> u32 {
        let header = self.header_ptr();
        let write_pos = unsafe { (*header).write_pos.load(Ordering::Acquire) };
        let read_pos = unsafe { (*header).read_pos.load(Ordering::Relaxed) };
        if write_pos >= read_pos {
            write_pos - read_pos
        } else {
            self.frame_count - read_pos + write_pos
        }
    }

    /// Number of free slots (frames that can be written without blocking).
    pub fn free(&self) -> u32 {
        // One slot is always kept empty to distinguish full from empty.
        self.frame_count - 1 - self.available()
    }

    /// Total number of frame slots in the ring.
    pub fn frame_count(&self) -> u32 {
        self.frame_count
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

impl ShmRing {
    #[inline]
    fn header_ptr(&self) -> *mut ShmHeader {
        self.ptr as *mut ShmHeader
    }

    #[inline]
    fn frame_ptr(&self, index: u32) -> *mut ShmFrame {
        debug_assert!((index as usize) < self.frame_count as usize);
        unsafe {
            self.ptr
                .add(HEADER_SIZE + (index as usize) * MAX_FRAME_SIZE) as *mut ShmFrame
        }
    }
}

// ---------------------------------------------------------------------------
// Drop
// ---------------------------------------------------------------------------

impl Drop for ShmRing {
    fn drop(&mut self) {
        unsafe {
            libc::munmap(self.ptr as *mut libc::c_void, self.size);
            libc::close(self.fd);
        }
        if self.owned {
            if let Ok(cname) = CString::new(self.name.as_str()) {
                unsafe {
                    libc::shm_unlink(cname.as_ptr());
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Utility free functions
// ---------------------------------------------------------------------------

/// Ensure the name starts with `/` (Linux convention for `shm_open`).
fn shm_name(raw: &str) -> String {
    if raw.starts_with('/') {
        raw.to_string()
    } else {
        format!("/{raw}")
    }
}

fn to_cstring(s: &str) -> io::Result<CString> {
    CString::new(s).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "name contains null byte"))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU32;

    /// Generate a unique shm name for tests so they can run in parallel.
    static TEST_COUNTER: AtomicU32 = AtomicU32::new(0);

    fn unique_name() -> String {
        let n = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        format!("/test_shm_ring_{n}")
    }

    // ----------------------------------------------------------------
    // Basic create / write / read
    // ----------------------------------------------------------------

    #[test]
    fn test_create_write_read() {
        let ring = ShmRing::create(&unique_name(), 4).expect("create ring");

        // Write 3 frames.
        ring.write_frame(frame_type::VIDEO, b"video_data_1", 1000)
            .unwrap();
        ring.write_frame(frame_type::AUDIO, b"audio_data_1", 2000)
            .unwrap();
        ring.write_frame(frame_type::INPUT, b"input_data_1", 3000)
            .unwrap();

        // Read them back in order.
        let (ty, data, ts) = ring.read_frame().unwrap();
        assert_eq!(ty, frame_type::VIDEO);
        assert_eq!(data, b"video_data_1");
        assert_eq!(ts, 1000);

        let (ty, data, ts) = ring.read_frame().unwrap();
        assert_eq!(ty, frame_type::AUDIO);
        assert_eq!(data, b"audio_data_1");
        assert_eq!(ts, 2000);

        let (ty, data, ts) = ring.read_frame().unwrap();
        assert_eq!(ty, frame_type::INPUT);
        assert_eq!(data, b"input_data_1");
        assert_eq!(ts, 3000);

        // Should be empty now.
        assert!(ring.read_frame().is_none());
    }

    // ----------------------------------------------------------------
    // Wrap-around
    // ----------------------------------------------------------------

    #[test]
    fn test_wrap_around() {
        let ring = ShmRing::create(&unique_name(), 4).expect("create ring");

        // Fill to capacity - 1.
        ring.write_frame(frame_type::VIDEO, b"f1", 1).unwrap();
        ring.write_frame(frame_type::VIDEO, b"f2", 2).unwrap();
        ring.write_frame(frame_type::VIDEO, b"f3", 3).unwrap();

        // Consume two, making room at the end.
        let (_, data, ts) = ring.read_frame().unwrap();
        assert_eq!(data, b"f1");
        assert_eq!(ts, 1);
        let (_, data, ts) = ring.read_frame().unwrap();
        assert_eq!(data, b"f2");
        assert_eq!(ts, 2);

        // Write two more — these must wrap to the beginning.
        ring.write_frame(frame_type::AUDIO, b"f4", 4).unwrap();
        ring.write_frame(frame_type::AUDIO, b"f5", 5).unwrap();

        // Read the remaining frame from the first batch.
        let (_, data, ts) = ring.read_frame().unwrap();
        assert_eq!(data, b"f3");
        assert_eq!(ts, 3);

        // Then the wrapped frames.
        let (_, data, ts) = ring.read_frame().unwrap();
        assert_eq!(data, b"f4");
        assert_eq!(ts, 4);
        let (_, data, ts) = ring.read_frame().unwrap();
        assert_eq!(data, b"f5");
        assert_eq!(ts, 5);

        // Empty.
        assert!(ring.read_frame().is_none());
    }

    // ----------------------------------------------------------------
    // Full → WouldBlock
    // ----------------------------------------------------------------

    #[test]
    fn test_ring_full_errors() {
        let ring = ShmRing::create(&unique_name(), 4).expect("create ring");

        // Fill all available slots.
        ring.write_frame(frame_type::HEALTH, b"h1", 1).unwrap();
        ring.write_frame(frame_type::HEALTH, b"h2", 2).unwrap();
        ring.write_frame(frame_type::HEALTH, b"h3", 3).unwrap();

        // Next write must fail.
        let err = ring.write_frame(frame_type::HEALTH, b"h4", 4).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::WouldBlock);

        // After consuming one, there's room again.
        ring.read_frame().unwrap();
        ring.write_frame(frame_type::HEALTH, b"h4", 4).unwrap();
    }

    // ----------------------------------------------------------------
    // Open existing segment
    // ----------------------------------------------------------------

    #[test]
    fn test_open_existing() {
        let name = unique_name();

        // Creator stays alive so shm_unlink isn't called until after the test.
        let creator = ShmRing::create(&name, 8).expect("create ring");
        creator
            .write_frame(frame_type::HEALTH, b"shared_data", 42)
            .unwrap();

        // Open a second handle — simulates worker ↔ server.
        let reader = ShmRing::open(&name).expect("open ring");
        let (ty, data, ts) = reader.read_frame().unwrap();
        assert_eq!(ty, frame_type::HEALTH);
        assert_eq!(data, b"shared_data");
        assert_eq!(ts, 42);

        // Write from the "reader" side (single-writer is a convention, not
        // enforced by the code — it works as long as only one side writes).
        reader
            .write_frame(frame_type::INPUT, b"reply", 99)
            .unwrap();
        let (ty, data, ts) = creator.read_frame().unwrap();
        assert_eq!(ty, frame_type::INPUT);
        assert_eq!(data, b"reply");
        assert_eq!(ts, 99);
    }

    // ----------------------------------------------------------------
    // Open with bad magic
    // ----------------------------------------------------------------

    #[test]
    fn test_open_bad_magic() {
        let name = unique_name();
        // Create a segment manually (not through ShmRing) so magic is wrong.
        let cname = CString::new(name.as_str()).unwrap();
        let fd = unsafe {
            libc::shm_open(
                cname.as_ptr(),
                libc::O_CREAT | libc::O_RDWR | libc::O_EXCL,
                0o644,
            )
        };
        assert!(fd >= 0);
        unsafe {
            libc::ftruncate(fd, HEADER_SIZE as libc::off_t);
            libc::close(fd);
        }

        let result = ShmRing::open(&name);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::InvalidData);

        // Clean up.
        unsafe { libc::shm_unlink(cname.as_ptr()) };
    }

    // ----------------------------------------------------------------
    // Data that fills the max payload
    // ----------------------------------------------------------------

    #[test]
    fn test_max_payload() {
        let ring = ShmRing::create(&unique_name(), 4).expect("create ring");
        let payload = vec![0xABu8; MAX_FRAME_SIZE - 12];
        ring.write_frame(frame_type::VIDEO, &payload, 9999)
            .unwrap();

        let (ty, data, ts) = ring.read_frame().unwrap();
        assert_eq!(ty, frame_type::VIDEO);
        assert_eq!(data.len(), payload.len());
        assert_eq!(data, payload);
        assert_eq!(ts, 9999);
    }

    // ----------------------------------------------------------------
    // Oversized data is rejected
    // ----------------------------------------------------------------

    #[test]
    fn test_oversized_rejected() {
        let ring = ShmRing::create(&unique_name(), 4).expect("create ring");
        let payload = vec![0u8; MAX_FRAME_SIZE - 11]; // 1 byte too large
        let err = ring.write_frame(frame_type::VIDEO, &payload, 0).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }

    // ----------------------------------------------------------------
    // available() / free()
    // ----------------------------------------------------------------

    #[test]
    fn test_available_and_free() {
        let ring = ShmRing::create(&unique_name(), 8).expect("create ring");
        assert_eq!(ring.available(), 0);
        assert_eq!(ring.free(), 7); // capacity - 1

        ring.write_frame(frame_type::HEALTH, b"a", 1).unwrap();
        ring.write_frame(frame_type::HEALTH, b"b", 2).unwrap();
        assert_eq!(ring.available(), 2);
        assert_eq!(ring.free(), 5);

        ring.read_frame().unwrap();
        assert_eq!(ring.available(), 1);
        assert_eq!(ring.free(), 6);
    }

    // ----------------------------------------------------------------
    // frame_count accessor
    // ----------------------------------------------------------------

    #[test]
    fn test_frame_count_accessor() {
        let ring = ShmRing::create(&unique_name(), 17).expect("create ring");
        assert_eq!(ring.frame_count(), 17);
    }
}
