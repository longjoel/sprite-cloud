use std::env;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    let mut shm_name = String::new();
    let mut input_shm_name = String::new();

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--shm" => {
                i += 1;
                shm_name = args.get(i).cloned().unwrap_or_default();
            }
            "--input-shm" => {
                i += 1;
                input_shm_name = args.get(i).cloned().unwrap_or_default();
            }
            _ => {}
        }
        i += 1;
    }

    if shm_name.is_empty() {
        eprintln!("usage: gv-worker --shm <name> [--input-shm <name>]");
        std::process::exit(1);
    }

    gv_worker::run_worker(&shm_name, if input_shm_name.is_empty() { None } else { Some(&input_shm_name) }).await
}
