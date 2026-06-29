//! GStreamer video encoder with nearest-neighbor integer scaling.
//!
//! Software path: appsrc → videoconvert → vp8enc → appsink
//! Hardware path: appsrc → videoconvert → <h264 encoder> → h264parse → appsink
//!
//! Receives raw RGB24 frames at the core's native resolution,
//! applies nearest-neighbor integer upscaling (if configured),
//! then pushes pre-scaled frames to GStreamer for VP8 or H.264 encoding.
//! GStreamer handles colorspace conversion and encoder scheduling internally.

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;

pub struct GstVideoEncoder {
    pipeline: gst::Pipeline,
    appsrc: gst_app::AppSrc,
    appsink: gst_app::AppSink,
    /// Original core resolution (e.g., 256×240 for NES).
    core_width: u32,
    core_height: u32,
    /// Scaled output resolution (core × scale_factor).
    output_width: u32,
    output_height: u32,
    /// Integer scale factor: max(1, floor(GV_GST_VIDEO_SCALE_HEIGHT / core_height)).
    scale_factor: u32,
    /// Frame duration in nanoseconds (derived from core fps).
    frame_duration_ns: u64,
    frames_pushed: u64,
    frames_pulled: u64,
}

impl GstVideoEncoder {
    pub fn new_with_codec(
        core_width: u32,
        core_height: u32,
        fps: f64,
    ) -> Result<Self, String> {
        let scale_height = crate::config::gst_video_scale_height();
        let max_scale = crate::config::gst_video_max_scale().max(1);
        let scale_factor = if scale_height > 0 && core_height > 0 {
            ((scale_height / core_height).max(1)).min(max_scale)
        } else {
            1
        };
        let output_width = core_width * scale_factor;
        let output_height = core_height * scale_factor;
        let frame_duration_ns = if fps > 0.0 {
            (1_000_000_000.0 / fps) as u64
        } else {
            16_666_667
        };

        let (pipeline, _encoder_name) = {
            let available = crate::encoder_probe::probe_h264_encoders();
            build_h264_pipeline(output_width, output_height, &available)?
        };

        let appsrc = pipeline
            .by_name("video_src")
            .ok_or("video_src not found")?
            .downcast::<gst_app::AppSrc>()
            .map_err(|e| format!("video_src: {e:?}"))?;

        let appsink = pipeline
            .by_name("video_sink")
            .ok_or("video_sink not found")?
            .downcast::<gst_app::AppSink>()
            .map_err(|e| format!("video_sink: {e:?}"))?;

        let caps = gst::Caps::builder("video/x-raw")
            .field("format", "RGB")
            .field("width", output_width as i32)
            .field("height", output_height as i32)
            .build();
        appsrc.set_caps(Some(&caps));
        appsrc.set_property("format", gst::Format::Time);
        appsrc.set_property("is-live", true);
        appsrc.set_max_bytes((output_width * output_height * 3 * 2) as u64);

        pipeline
            .set_state(gst::State::Playing)
            .map_err(|e| format!("set Playing: {e}"))?;

        if scale_factor > 1 {
            tracing::info!(
                "[GST-video] {}×{} →{}× → {}×{} bitrate={}kbps",
                core_width,
                core_height,
                scale_factor,
                output_width,
                output_height,
                crate::config::gst_video_bitrate_kbps(),
            );
        } else {
            tracing::info!(
                "[GST-video] {}×{} bitrate={}kbps",
                output_width,
                output_height,
                crate::config::gst_video_bitrate_kbps(),
            );
        }

        Ok(Self {
            pipeline,
            appsrc,
            appsink,
            core_width,
            core_height,
            output_width,
            output_height,
            scale_factor,
            frame_duration_ns,
            frames_pushed: 0,
            frames_pulled: 0,
        })
    }

    /// Push a core-resolution RGB24 frame. Integer-scaled if scale_factor > 1.
    /// `frame_dims` are the actual dimensions of the incoming frame —
    /// if they differ from the core base dimensions (e.g. Genesis switches
    /// from 256×192 to 320×224 mid-game), the frame is resized first.
    pub fn push(&mut self, rgb: &[u8], frame_dims: (u32, u32), frame_num: u64) -> Result<(), String> {
        let (actual_w, actual_h) = frame_dims;
        let data = if actual_w != self.core_width || actual_h != self.core_height {
            // Resize to core base dimensions before integer scaling.
            // This handles cores (genesis_plus_gx) that report one base
            // resolution in av_info but emit different per-frame dimensions.
            if frame_num == 0 {
                tracing::info!(
                    "[GST-video] frame {n} dims {aw}×{ah} differ from base {bw}×{bh} — resizing",
                    n = frame_num, aw = actual_w, ah = actual_h, bw = self.core_width, bh = self.core_height,
                );
            }
            let resized = nearest_neighbor_resize(
                rgb, actual_w, actual_h, self.core_width, self.core_height,
            );
            if self.scale_factor > 1 {
                nearest_neighbor_scale(
                    &resized, self.core_width, self.core_height,
                    self.output_width, self.output_height,
                )
            } else {
                resized
            }
        } else if self.scale_factor > 1 {
            nearest_neighbor_scale(
                rgb, self.core_width, self.core_height,
                self.output_width, self.output_height,
            )
        } else {
            let expected = (self.core_width * self.core_height * 3) as usize;
            if rgb.len() < expected {
                let mut padded = vec![0u8; expected];
                padded[..rgb.len()].copy_from_slice(rgb);
                padded
            } else {
                rgb[..expected].to_vec()
            }
        };

        let mut buffer = gst::Buffer::from_slice(data);
        {
            let buf = buffer.make_mut();
            let pts = frame_num.saturating_mul(self.frame_duration_ns);
            buf.set_pts(gst::ClockTime::from_nseconds(pts));
            buf.set_duration(gst::ClockTime::from_nseconds(self.frame_duration_ns));
        }
        self.appsrc
            .push_buffer(buffer)
            .map_err(|e| format!("video push: {e}"))?;
        self.frames_pushed += 1;
        Ok(())
    }

    /// Non-blocking pull. Returns `None` if no frame ready.
    pub fn try_pull(&mut self) -> Option<Vec<u8>> {
        let sample = self.appsink.try_pull_sample(gst::ClockTime::ZERO)?;
        let buffer = sample.buffer()?;
        let map = buffer.map_readable().ok()?;
        self.frames_pulled += 1;
        Some(map.to_vec())
    }

    pub fn width(&self) -> u32 {
        self.output_width
    }
    pub fn height(&self) -> u32 {
        self.output_height
    }
    pub fn scale_factor(&self) -> u32 {
        self.scale_factor
    }
}

impl Drop for GstVideoEncoder {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

// ── Pipeline builders ───────────────────────────────────────────────────────

fn build_h264_pipeline(
    output_width: u32,
    output_height: u32,
    available: &[crate::encoder_probe::H264EncoderInfo],
) -> Result<(gst::Pipeline, String), String> {
    let configured = crate::config::gst_video_h264_encoder();

    if configured.eq_ignore_ascii_case("auto") || configured.is_empty() {
        let mut errors = Vec::new();
        for info in available {
            let pipeline_str =
                h264_pipeline_string(&info.factory_name, output_width, output_height);
            match launch_pipeline(&pipeline_str) {
                Ok(p) => return Ok((p, info.factory_name.clone())),
                Err(e) => {
                    tracing::warn!("[GST-video] {}: {e}", info.factory_name);
                    errors.push(format!("{}: {e}", info.factory_name));
                }
            }
        }
        Err(format!(
            "no H.264 encoder available (tried: {})",
            if errors.is_empty() {
                "none found".into()
            } else {
                errors.join("; ")
            }
        ))
    } else {
        let pipeline_str = h264_pipeline_string(&configured, output_width, output_height);
        launch_pipeline(&pipeline_str).map(|p| (p, configured))
    }
}

fn h264_pipeline_string(encoder: &str, output_width: u32, output_height: u32) -> String {
    let bitrate = crate::config::gst_video_bitrate_kbps();
    let kf_dist = crate::config::gst_video_keyframe_max_dist();

    let encoder_params = if encoder == "x264enc" || encoder == "openh264enc" {
        // Software encoders: x264enc (libx264) and openh264enc (OpenH264)
        // use pass= instead of rate-control=, speed-preset + tune instead of target-usage,
        // and bframes= instead of max-bframes=.
        format!(
            "bitrate={br} pass=cbr speed-preset=ultrafast tune=zerolatency \
             bframes=0 cabac=false dct8x8=false key-int-max={kf}",
            br = bitrate,
            kf = kf_dist,
        )
    } else {
        // Hardware encoders: VAAPI (vaapih264enc, vah264enc, vah264lpenc),
        // NVENC (nvh264enc), QSV (qsvh264enc, msdkh264enc), AMF (amfh264enc).
        format!(
            "bitrate={br} rate-control=cbr key-int-max={kf} \
             max-bframes=0 cabac=false dct8x8=false",
            br = bitrate,
            kf = kf_dist,
        )
    };

    format!(
        "appsrc name=video_src is-live=true format=time \
         ! videoconvert \
         ! video/x-raw,format=NV12,width={w},height={h} \
         ! {encoder} \
           name=h264enc \
           {params} \
         ! h264parse config-interval=-1 \
         ! video/x-h264,stream-format=byte-stream,alignment=au,profile=constrained-baseline \
         ! appsink name=video_sink sync=false async=false drop=true max-buffers=4",
        w = output_width,
        h = output_height,
        params = encoder_params,
    )
}

fn launch_pipeline(pipeline_str: &str) -> Result<gst::Pipeline, String> {
    gst::parse::launch(pipeline_str)
        .map_err(|e| format!("video pipeline launch: {e}"))?
        .downcast::<gst::Pipeline>()
        .map_err(|e| format!("not a Pipeline: {e:?}"))
}

// ── Integer scaling ────────────────────────────────────────────────────────

/// Nearest-neighbor integer scaling: each source pixel maps to scale_factor×scale_factor
/// destination pixels. RGB24 interleaved (3 bytes per pixel).
///
/// Pre-requisite: output_width == input_width * factor, output_height == input_height * factor.
fn nearest_neighbor_scale(
    src: &[u8],
    src_w: u32,
    src_h: u32,
    dst_w: u32,
    dst_h: u32,
) -> Vec<u8> {
    let src_w = src_w as usize;
    let src_h = src_h as usize;
    let dst_w = dst_w as usize;
    let dst_h = dst_h as usize;
    let factor_x = dst_w / src_w;
    let factor_y = dst_h / src_h;

    let mut dst = vec![0u8; dst_w * dst_h * 3];

    // Process row-by-row for cache-friendliness.
    // For each source row, replicate it vertically factor_y times,
    // and replicate each pixel horizontally factor_x times.
    for src_y in 0..src_h {
        let src_row_start = src_y * src_w * 3;
        for dy in 0..factor_y {
            let dst_y = src_y * factor_y + dy;
            let dst_row_start = dst_y * dst_w * 3;
            for src_x in 0..src_w {
                let px_start = src_row_start + src_x * 3;
                let dst_px_start = dst_row_start + src_x * factor_x * 3;
                // Replicate this pixel factor_x times horizontally
                for dx in 0..factor_x {
                    let offset = dst_px_start + dx * 3;
                    dst[offset] = src[px_start];
                    dst[offset + 1] = src[px_start + 1];
                    dst[offset + 2] = src[px_start + 2];
                }
            }
        }
    }

    dst
}

/// General nearest-neighbor resize: src (src_w×src_h) → dst (dst_w×dst_h).
/// Handles both upscaling and downscaling. Used to normalize per-frame
/// dimensions to the core's base dimensions before integer scaling.
fn nearest_neighbor_resize(
    src: &[u8],
    src_w: u32,
    src_h: u32,
    dst_w: u32,
    dst_h: u32,
) -> Vec<u8> {
    let src_w = src_w as usize;
    let src_h = src_h as usize;
    let dst_w = dst_w as usize;
    let dst_h = dst_h as usize;

    let mut dst = vec![0u8; dst_w * dst_h * 3];

    for dst_y in 0..dst_h {
        let src_y = (dst_y as u64 * src_h as u64 / dst_h as u64) as usize;
        let src_row = src_y * src_w * 3;
        let dst_row = dst_y * dst_w * 3;
        for dst_x in 0..dst_w {
            let src_x = (dst_x as u64 * src_w as u64 / dst_w as u64) as usize;
            let si = src_row + src_x * 3;
            let di = dst_row + dst_x * 3;
            dst[di] = src[si];
            dst[di + 1] = src[si + 1];
            dst[di + 2] = src[si + 2];
        }
    }

    dst
}
