//! Bounded still-image capture from a trusted libretro core.
//!
//! This is intentionally a small building block: it runs a finite number of
//! frames, chooses the first non-empty RGB24 frame, and atomically writes a PNG.
//! Queueing, title-screen scoring, and catalog persistence belong to later work.

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use tempfile::{NamedTempFile, TempDir};

use crate::{Core, CoreConfig, Error};

/// Maximum accepted framebuffer dimensions, matching the existing sc-core safety limit.
pub const MAX_CAPTURE_WIDTH: u32 = 640;
pub const MAX_CAPTURE_HEIGHT: u32 = 480;

/// Inputs and bounds for one isolated still-image capture.
#[derive(Debug, Clone)]
pub struct CaptureConfig {
    /// Path to a trusted libretro core shared library.
    pub core_path: PathBuf,
    /// Optional ROM path. Cores that support no-game operation may omit this.
    pub content_path: Option<PathBuf>,
    /// Caller-supplied system/BIOS directory.
    pub system_dir: PathBuf,
    /// Final PNG destination. The file is atomically promoted only on success.
    pub output_path: PathBuf,
    /// Maximum number of frames to execute before reporting that no useful frame exists.
    pub frame_budget: u32,
    /// Cooperative wall-time bound for the bounded frame loop.
    pub max_wall_time: Duration,
}

/// Metadata for a completed still-image artifact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapturedStill {
    pub path: PathBuf,
    pub width: u32,
    pub height: u32,
    pub source_frame: u32,
}

/// Capture failures leave no partial final artifact at `CaptureConfig::output_path`.
#[derive(Debug, thiserror::Error)]
pub enum CaptureError {
    #[error("frame budget must be greater than zero")]
    EmptyFrameBudget,
    #[error("maximum capture duration must be greater than zero")]
    EmptyWallTime,
    #[error("output path has no parent directory: {0}")]
    MissingOutputParent(PathBuf),
    #[error("failed to create capture directory {path}: {source}")]
    CreateDirectory {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to create disposable save directory: {0}")]
    CreateSaveDirectory(#[source] std::io::Error),
    #[error("failed to load core: {0}")]
    LoadCore(#[source] Error),
    #[error("core failed while running frame {frame}: {source}")]
    RunFrame {
        frame: u32,
        #[source]
        source: Error,
    },
    #[error("capture exceeded {limit:?} before a usable frame was produced")]
    TimedOut { limit: Duration },
    #[error("core produced no non-empty frame within {frame_budget} frames")]
    NoUsableFrame { frame_budget: u32 },
    #[error(
        "frame {width}x{height} exceeds capture limit {MAX_CAPTURE_WIDTH}x{MAX_CAPTURE_HEIGHT}"
    )]
    FrameTooLarge { width: u32, height: u32 },
    #[error("frame byte length {actual} does not match RGB24 dimensions {width}x{height}")]
    InvalidFrameLength {
        width: u32,
        height: u32,
        actual: usize,
    },
    #[error("failed to create temporary artifact: {0}")]
    CreateTemporaryArtifact(#[source] std::io::Error),
    #[error("failed to encode PNG artifact: {0}")]
    EncodePng(#[source] png::EncodingError),
    #[error("failed to atomically promote artifact to {path}: {source}")]
    PromoteArtifact {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

/// Runs a trusted core for a bounded number of frames and atomically writes one PNG still.
///
/// The core runs native code. Callers must execute this in an externally constrained worker
/// for a hard process-level timeout; `max_wall_time` bounds this synchronous loop between
/// frames and reports a visible failure for a slow-but-returning core.
pub fn capture_still(config: CaptureConfig) -> Result<CapturedStill, CaptureError> {
    if config.frame_budget == 0 {
        return Err(CaptureError::EmptyFrameBudget);
    }
    if config.max_wall_time.is_zero() {
        return Err(CaptureError::EmptyWallTime);
    }

    fs::create_dir_all(&config.system_dir).map_err(|source| CaptureError::CreateDirectory {
        path: config.system_dir.clone(),
        source,
    })?;

    let output_parent = config
        .output_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| CaptureError::MissingOutputParent(config.output_path.clone()))?;
    fs::create_dir_all(output_parent).map_err(|source| CaptureError::CreateDirectory {
        path: output_parent.to_path_buf(),
        source,
    })?;

    let save_dir = TempDir::new().map_err(CaptureError::CreateSaveDirectory)?;
    let mut core = load_core(&config, &save_dir)?;
    let started = Instant::now();

    for frame_number in 1..=config.frame_budget {
        if started.elapsed() > config.max_wall_time {
            return Err(CaptureError::TimedOut {
                limit: config.max_wall_time,
            });
        }

        core.run_frame().map_err(|source| CaptureError::RunFrame {
            frame: frame_number,
            source,
        })?;

        if started.elapsed() > config.max_wall_time {
            return Err(CaptureError::TimedOut {
                limit: config.max_wall_time,
            });
        }

        let Some(frame) = core.frame() else {
            continue;
        };
        if !frame.iter().any(|&channel| channel != 0) {
            continue;
        }

        let (width, height) = core.frame_size();
        validate_frame(frame, width, height)?;
        write_png_atomically(&config.output_path, width, height, frame)?;
        return Ok(CapturedStill {
            path: config.output_path,
            width,
            height,
            source_frame: frame_number,
        });
    }

    Err(CaptureError::NoUsableFrame {
        frame_budget: config.frame_budget,
    })
}

fn load_core(config: &CaptureConfig, save_dir: &TempDir) -> Result<Core, CaptureError> {
    // SAFETY: `CaptureConfig::core_path` is documented as a trusted libretro core path.
    unsafe {
        Core::load(CoreConfig {
            core_path: config.core_path.clone(),
            content_path: config.content_path.clone(),
            system_dir: config.system_dir.clone(),
            save_dir: save_dir.path().to_path_buf(),
        })
    }
    .map_err(CaptureError::LoadCore)
}

fn validate_frame(frame: &[u8], width: u32, height: u32) -> Result<(), CaptureError> {
    if width == 0 || height == 0 || width > MAX_CAPTURE_WIDTH || height > MAX_CAPTURE_HEIGHT {
        return Err(CaptureError::FrameTooLarge { width, height });
    }
    let expected = width as usize * height as usize * 3;
    if frame.len() != expected {
        return Err(CaptureError::InvalidFrameLength {
            width,
            height,
            actual: frame.len(),
        });
    }
    Ok(())
}

fn write_png_atomically(
    output_path: &std::path::Path,
    width: u32,
    height: u32,
    rgb24: &[u8],
) -> Result<(), CaptureError> {
    let parent = output_path
        .parent()
        .expect("capture_still validates the output parent before encoding");
    let temporary = NamedTempFile::new_in(parent).map_err(CaptureError::CreateTemporaryArtifact)?;

    {
        let mut encoder = png::Encoder::new(temporary.as_file(), width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(CaptureError::EncodePng)?;
        writer
            .write_image_data(rgb24)
            .map_err(CaptureError::EncodePng)?;
    }

    temporary
        .persist(output_path)
        .map_err(|error| CaptureError::PromoteArtifact {
            path: output_path.to_path_buf(),
            source: error.error,
        })?;
    Ok(())
}
