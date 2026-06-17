use gv_server::gv_web::PollResponse;

#[test]
fn poll_response_with_commands() {
    let json = r#"{
        "commands": [
            {"id": "abc-123", "type": "start_game", "payload": {"game_id": "smw"}, "lease_token": "lease-abc", "lease_expires_at": "2026-06-17T00:00:30.000Z", "attempt": 1},
            {"id": "def-456", "type": "sdp_offer", "payload": {"sdp": "v=0\r\n"}, "lease_token": "lease-def", "lease_expires_at": "2026-06-17T00:00:30.000Z", "attempt": 2}
        ],
        "next_poll_ms": 250
    }"#;

    let resp: PollResponse = serde_json::from_str(json).unwrap();
    assert_eq!(resp.commands.len(), 2);
    assert_eq!(resp.next_poll_ms, 250);

    assert_eq!(resp.commands[0].id, "abc-123");
    assert_eq!(resp.commands[0].command_type, "start_game");
    assert_eq!(resp.commands[0].lease_token, "lease-abc");
    assert_eq!(resp.commands[0].attempt, 1);
    assert_eq!(
        resp.commands[0].payload["game_id"].as_str().unwrap(),
        "smw"
    );

    assert_eq!(resp.commands[1].id, "def-456");
    assert_eq!(resp.commands[1].command_type, "sdp_offer");
    assert_eq!(resp.commands[1].lease_token, "lease-def");
    assert_eq!(resp.commands[1].attempt, 2);
}

#[test]
fn poll_response_empty() {
    let json = r#"{"commands": [], "next_poll_ms": 2000}"#;
    let resp: PollResponse = serde_json::from_str(json).unwrap();
    assert!(resp.commands.is_empty());
    assert_eq!(resp.next_poll_ms, 2000);
}

#[test]
fn poll_response_missing_next_poll_ms_rejected() {
    let json = r#"{"commands": []}"#;
    let err = serde_json::from_str::<PollResponse>(json).unwrap_err();
    assert!(err.to_string().contains("next_poll_ms"));
}
