use gv_server::config::Config;

#[test]
fn save_and_load_roundtrip() {
    let cfg = Config {
        gv_web: gv_server::config::GvWeb {
            url: "http://localhost:3001".into(),
        },
        auth: gv_server::config::Auth {
            api_key: "gvsk_test_key_12345".into(),
            server_id: "svr_test".into(),
        },
    };

    let content = toml::to_string_pretty(&cfg).unwrap();
    let loaded: Config = toml::from_str(&content).unwrap();

    assert_eq!(loaded.gv_web.url, "http://localhost:3001");
    assert_eq!(loaded.auth.api_key, "gvsk_test_key_12345");
    assert_eq!(loaded.auth.server_id, "svr_test");
}

#[test]
fn invalid_config_rejected() {
    assert!(toml::from_str::<Config>("not valid toml").is_err());
}

#[test]
fn missing_fields_rejected() {
    let partial = r#"
[gv_web]
url = "http://localhost:3001"
"#;
    assert!(toml::from_str::<Config>(partial).is_err());
}
