use sc_server::config::Config;

#[test]
fn save_and_load_roundtrip() {
    let cfg = Config {
        sc_web: sc_server::config::ScWeb {
            url: "http://localhost:3001".into(),
        },
        auth: sc_server::config::Auth {
            api_key: "scsk_test_key_12345".into(),
            server_id: "svr_test".into(),
        },
        rom: None,
        cores: None,
        ice: None,
    };

    let content = toml::to_string_pretty(&cfg).unwrap();
    let loaded: Config = toml::from_str(&content).unwrap();

    assert_eq!(loaded.sc_web.url, "http://localhost:3001");
    assert_eq!(loaded.auth.api_key, "scsk_test_key_12345");
    assert_eq!(loaded.auth.server_id, "svr_test");
}

#[test]
fn invalid_config_rejected() {
    assert!(toml::from_str::<Config>("not valid toml").is_err());
}

#[test]
fn missing_fields_rejected() {
    let partial = r#"
[sc_web]
url = "http://localhost:3001"
"#;
    assert!(toml::from_str::<Config>(partial).is_err());
}
