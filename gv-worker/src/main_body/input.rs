//! Keyboard-to-joypad mapping for browser input.
//!
//! Extracted from main_body/mod.rs.

/// Map a browser KeyboardEvent.key string to a RetroArch joypad button.
pub(super) fn map_key_to_joypad(key: &str) -> Option<libretro_runner::JoypadButton> {
    use libretro_runner::JoypadButton;
    match key {
        "ArrowUp" | "w" | "W" => Some(JoypadButton::Up),
        "ArrowDown" | "s" | "S" => Some(JoypadButton::Down),
        "ArrowLeft" | "a" | "A" => Some(JoypadButton::Left),
        "ArrowRight" | "d" | "D" => Some(JoypadButton::Right),
        "Enter" | " " => Some(JoypadButton::Start),
        "Shift" => Some(JoypadButton::Select),
        "z" | "Z" => Some(JoypadButton::B),
        "x" | "X" => Some(JoypadButton::A),
        _ => None,
    }
}
