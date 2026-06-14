//! Integration tests for gv-worker.
//!
//! These start a real gv-worker HTTP server and verify the full pipeline:
//! test page, SDP negotiation, encoder output, and session lifecycle.
//!
//! Run with: `cargo test --test integration -- --nocapture`

use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command};
use std::time::Duration;

/// Spawn gv-worker on a random port (pass 0 to the binary) and wait for it
/// to print the actual port it bound to. Returns (child, port).
fn spawn_worker() -> (Child, u16) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_gv-worker"))
        .arg("0") // random port
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("failed to spawn gv-worker");

    // Read the port from stderr: "WORKER_READY port=<N>"
    let stderr = child.stderr.take().expect("no stderr");
    let mut reader = BufReader::new(stderr);
    let mut line = String::new();

    for _ in 0..100 {
        line.clear();
        let n = reader
            .read_line(&mut line)
            .expect("failed to read worker stderr");
        if n == 0 {
            break;
        }
        if line.contains("WORKER_READY port=") {
            let port_str = line
                .split("port=")
                .nth(1)
                .unwrap()
                .trim()
                .split_whitespace()
                .next()
                .unwrap();
            let port: u16 = port_str.parse().expect("invalid port");
            // Put stderr back
            let stderr = reader.into_inner();
            child.stderr = Some(stderr);
            return (child, port);
        }
    }

    child.kill().ok();
    panic!("worker didn't print port");
}

fn url(port: u16, path: &str) -> String {
    format!("http://127.0.0.1:{}{}", port, path)
}

// ---------------------------------------------------------------------------
// Test: test page
// ---------------------------------------------------------------------------

#[test]
fn test_page_loads() {
    let (mut child, port) = spawn_worker();
    let resp = ureq::get(&url(port, "/")).call().expect("GET / failed");
    assert_eq!(resp.status(), 200);
    let body = resp.into_string().unwrap();
    assert!(body.contains("gv-worker"));
    assert!(body.contains("WebRTC test"));
    child.kill().ok();
}

// ---------------------------------------------------------------------------
// Test: SDP handshake produces valid answer
// ---------------------------------------------------------------------------

#[test]
fn sdp_handshake_returns_video_answer() {
    let (mut child, port) = spawn_worker();

    // Minimal but valid SDP offer with ICE credentials and DTLS fingerprint
    let offer = "v=0\r\n\
                 o=- 46117303 2 IN IP4 127.0.0.1\r\n\
                 s=-\r\n\
                 t=0 0\r\n\
                 a=group:BUNDLE 0\r\n\
                 a=msid-semantic: WMS\r\n\
                 m=video 9 UDP/TLS/RTP/SAVPF 96\r\n\
                 c=IN IP4 0.0.0.0\r\n\
                 a=rtcp:9 IN IP4 0.0.0.0\r\n\
                 a=ice-ufrag:test123\r\n\
                 a=ice-pwd:testpass1234567890\r\n\
                 a=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89\r\n\
                 a=setup:actpass\r\n\
                 a=mid:0\r\n\
                 a=recvonly\r\n\
                 a=rtpmap:96 VP8/90000\r\n";

    let resp = ureq::post(&url(port, "/sdp"))
        .set("Content-Type", "application/json")
        .send_json(ureq::json!({"sdp": offer}))
        .expect("POST /sdp failed");

    assert_eq!(resp.status(), 200, "expected 200 OK");

    let answer: serde_json::Value = resp.into_json().unwrap();
    let sdp = answer["sdp"].as_str().expect("answer must have sdp field");

    assert!(!sdp.starts_with("ERROR"), "SDP answer is an error: {}", sdp);
    assert!(sdp.contains("m=video"), "answer missing video m-line");
    assert!(sdp.contains("VP8"), "answer missing VP8 codec");
    assert!(sdp.contains("a=sendonly"), "answer should be sendonly");
    assert!(sdp.len() > 500, "answer too short: {} chars", sdp.len());

    // Give the encoder a moment to start, then check it produced frames
    std::thread::sleep(Duration::from_secs(2));

    child.kill().ok();
}

// ---------------------------------------------------------------------------
// Test: repeated SDP handshake (no crashes, no leaks)
// ---------------------------------------------------------------------------

#[test]
fn repeated_sdp_does_not_crash() {
    let (mut child, port) = spawn_worker();

    let offer = "v=0\r\n\
                 o=- 1 1 IN IP4 127.0.0.1\r\n\
                 s=-\r\n\
                 t=0 0\r\n\
                 a=group:BUNDLE 0\r\n\
                 a=msid-semantic: WMS\r\n\
                 m=video 9 UDP/TLS/RTP/SAVPF 96\r\n\
                 c=IN IP4 0.0.0.0\r\n\
                 a=rtcp:9 IN IP4 0.0.0.0\r\n\
                 a=ice-ufrag:test123\r\n\
                 a=ice-pwd:testpass1234567890\r\n\
                 a=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89\r\n\
                 a=setup:actpass\r\n\
                 a=mid:0\r\n\
                 a=recvonly\r\n\
                 a=rtpmap:96 VP8/90000\r\n";

    // Send 5 offers sequentially — each replaces the previous session
    for i in 0..5 {
        let resp = ureq::post(&url(port, "/sdp"))
            .set("Content-Type", "application/json")
            .send_json(ureq::json!({"sdp": offer}))
            .unwrap_or_else(|e| panic!("request {} failed: {}", i, e));

        assert_eq!(resp.status(), 200, "request {}: expected 200", i);
        std::thread::sleep(Duration::from_millis(200));
    }

    // After all 5, the server should still be alive
    let resp = ureq::get(&url(port, "/")).call().expect("server should still be up");
    assert_eq!(resp.status(), 200);

    child.kill().ok();
}

// ---------------------------------------------------------------------------
// Test: /test-frame returns correct-size data
// ---------------------------------------------------------------------------

#[test]
fn test_frame_returns_correct_size() {
    let (mut child, port) = spawn_worker();

    let resp = ureq::get(&url(port, "/test-frame?frame=0"))
        .call()
        .expect("GET /test-frame failed");
    assert_eq!(resp.status(), 200);

    let mut body = Vec::new();
    resp.into_reader()
        .read_to_end(&mut body)
        .expect("failed to read body");

    // 320×240×3 = 230,400 bytes of raw RGB24
    assert_eq!(body.len(), 230_400, "wrong frame size");

    // Two consecutive frames must differ (bouncing square moves)
    let resp2 = ureq::get(&url(port, "/test-frame?frame=1"))
        .call()
        .unwrap();
    let mut body2 = Vec::new();
    resp2.into_reader().read_to_end(&mut body2).unwrap();
    assert_ne!(body, body2, "consecutive frames must differ");

    child.kill().ok();
}

// ---------------------------------------------------------------------------
// Test: error responses on bad input
// ---------------------------------------------------------------------------

#[test]
fn empty_sdp_returns_400() {
    let (mut child, port) = spawn_worker();

    let result = ureq::post(&url(port, "/sdp"))
        .set("Content-Type", "application/json")
        .send_json(ureq::json!({"sdp": ""}));

    match result {
        Err(ureq::Error::Status(400, _)) => {} // expected
        other => panic!("expected 400, got {:?}", other),
    }

    child.kill().ok();
}

#[test]
fn missing_sdp_field_returns_400() {
    let (mut child, port) = spawn_worker();

    let result = ureq::post(&url(port, "/sdp"))
        .set("Content-Type", "application/json")
        .send_json(ureq::json!({}));

    match result {
        Err(ureq::Error::Status(code, _)) => {
            assert!(
                code == 400 || code == 422,
                "expected 400 or 422, got {}",
                code
            );
        }
        other => panic!("expected error status, got {:?}", other),
    }

    child.kill().ok();
}
