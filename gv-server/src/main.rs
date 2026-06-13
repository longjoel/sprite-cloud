use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const GV_WEB_URL: &str = "http://localhost:3000";

#[derive(Debug, Serialize)]
struct PairRequest {
    code: String,
}

#[derive(Debug, Deserialize)]
struct PairResponse {
    status: String,
    #[serde(default)]
    device_id: Option<String>,
    #[serde(default)]
    auth_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CommandResponse {
    commands: Vec<Command>,
    poll_ms: u64,
}

#[derive(Debug, Deserialize)]
struct Command {
    id: String,
    #[serde(rename = "type")]
    cmd_type: String,
    payload: serde_json::Value,
}

#[tokio::main]
async fn main() {
    let client = Client::new();
    let code = generate_code();
    println!("Pairing code: {}", code);

    // Phase 1: Pair
    let pair_resp: PairResponse = loop {
        let resp = client
            .post(format!("{}/api/pair/poll", GV_WEB_URL))
            .json(&PairRequest {
                code: code.clone(),
            })
            .send()
            .await
            .unwrap()
            .json::<PairResponse>()
            .await
            .unwrap();

        if resp.status == "paired" {
            break resp;
        }
        println!("Waiting for pairing... (code: {})", code);
        tokio::time::sleep(Duration::from_secs(2)).await;
    };

    let auth_token = pair_resp.auth_token.unwrap();
    println!("Paired! device_id: {}", pair_resp.device_id.unwrap_or_default());

    // Phase 2: Poll for commands
    let mut poll_ms = 2000u64;
    loop {
        match client
            .get(format!("{}/api/commands", GV_WEB_URL))
            .header("Authorization", format!("Bearer {}", auth_token))
            .send()
            .await
        {
            Ok(resp) => match resp.json::<CommandResponse>().await {
                Ok(cr) => {
                    poll_ms = cr.poll_ms;
                    for cmd in cr.commands {
                        match cmd.cmd_type.as_str() {
                            "start_game" => {
                                println!("Starting game: {:?}", cmd.payload);
                            }
                            other => println!("Unknown command: {}", other),
                        }
                    }
                }
                Err(e) => eprintln!("Failed to parse commands: {}", e),
            },
            Err(e) => eprintln!("Poll failed: {}", e),
        }

        tokio::time::sleep(Duration::from_millis(poll_ms)).await;
    }
}

fn generate_code() -> String {
    use rand::Rng;
    let letters: Vec<char> = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".chars().collect();
    let mut rng = rand::thread_rng();
    (0..8).map(|_| letters[rng.gen_range(0..letters.len())]).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_code_produces_8_letters() {
        let code = generate_code();
        assert_eq!(code.len(), 8);
        assert!(code.chars().all(|c| c.is_ascii_uppercase()));
    }

    #[test]
    fn generate_code_is_random() {
        let a = generate_code();
        let b = generate_code();
        assert!(a != b || generate_code() != a);
    }
}
