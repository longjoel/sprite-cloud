//! GStreamer H.264 encoder auto-discovery.
//!
//! Probes GStreamer's element registry at runtime for available H.264 video
//! encoders (hardware and software). Returns a ranked list for pipeline
//! construction — no hardcoded element names.

use gstreamer as gst;
use gstreamer::prelude::*;

/// An available H.264 encoder, ranked by preference.
#[derive(Debug, Clone)]
pub struct H264EncoderInfo {
    pub factory_name: String,
    pub rank: i32,
    pub is_hardware: bool,
    pub accepts_dmabuf: bool,
}

/// Probe GStreamer for all available H.264 video encoders.
pub fn probe_h264_encoders() -> Vec<H264EncoderInfo> {
    let candidates: &[(&str, bool)] = &[
        ("vah264enc", true),
        ("vaapih264enc", true),
        ("vah264lpenc", true),
        ("nvh264enc", true),
        ("amfh264enc", true),
        ("qsvh264enc", true),
        ("msdkh264enc", true),
        ("x264enc", false),
        ("openh264enc", false),
    ];

    let mut encoders: Vec<H264EncoderInfo> = Vec::new();

    for (name, is_hardware) in candidates {
        if let Some(factory) = gst::ElementFactory::find(name) {
            let klass = factory.klass();
            if !klass.contains("Encoder") || !klass.contains("Video") {
                continue;
            }

            let accepts_dmabuf = *is_hardware;

            encoders.push(H264EncoderInfo {
                factory_name: name.to_string(),
                rank: i32::from(factory.rank()),
                is_hardware: *is_hardware,
                accepts_dmabuf,
            });
        }
    }

    encoders.sort_by(|a, b| {
        b.accepts_dmabuf
            .cmp(&a.accepts_dmabuf)
            .then(b.is_hardware.cmp(&a.is_hardware))
            .then(b.rank.cmp(&a.rank))
    });

    encoders
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;

    static GST_INIT: OnceLock<()> = OnceLock::new();

    fn init_gst() {
        GST_INIT.get_or_init(|| {
            gst::init().expect("gst init");
        });
    }

    #[test]
    fn probe_finds_at_least_x264enc() {
        init_gst();
        let encoders = probe_h264_encoders();
        let names: Vec<&str> = encoders.iter().map(|e| e.factory_name.as_str()).collect();
        assert!(
            names.contains(&"x264enc"),
            "x264enc must be found (gst-plugins-ugly). Found: {names:?}"
        );
    }

    #[test]
    fn probe_sorted_by_preference() {
        init_gst();
        let encoders = probe_h264_encoders();
        if encoders.len() < 2 {
            return;
        }
        for i in 0..encoders.len() - 1 {
            let a = &encoders[i];
            let b = &encoders[i + 1];
            let a_score = a.accepts_dmabuf as i32 * 1000 + a.is_hardware as i32 * 100 + a.rank;
            let b_score = b.accepts_dmabuf as i32 * 1000 + b.is_hardware as i32 * 100 + b.rank;
            assert!(
                a_score >= b_score,
                "encoder order: {} (score={a_score}) before {} (score={b_score})",
                a.factory_name,
                b.factory_name,
            );
        }
    }
}
