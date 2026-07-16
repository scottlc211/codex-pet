// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(result) = codex_pet_lib::run_agent_hook_cli() {
        if let Err(error) = result {
            eprintln!("Codex Pet hook bridge failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    codex_pet_lib::run()
}
