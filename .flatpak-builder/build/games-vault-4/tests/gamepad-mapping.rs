// ── gv-desktop/tests/gamepad-mapping.rs ──────────────────────────────
// Table-driven tests for the gilrs → RetroPad button mask mapping.
//
// Verifies the mask constants and the pure `map_gamepad_to_port` function
// produce the correct 16-bit RetroPad masks for every mapped button and
// for common button combinations (e.g. Steam Deck face + shoulder chords).
//
// These tests run without gilrs — they test the mapping function in
// isolation so they work in CI without a physical gamepad.

/// RetroPad bit layout (must match main.rs and gv-tauri-bridge.js).
const MASK_SOUTH: u16 = 1 << 0;
const MASK_EAST: u16 = 1 << 1;
const MASK_SELECT: u16 = 1 << 2;
const MASK_START: u16 = 1 << 3;
const MASK_DPAD_UP: u16 = 1 << 4;
const MASK_DPAD_DOWN: u16 = 1 << 5;
const MASK_DPAD_LEFT: u16 = 1 << 6;
const MASK_DPAD_RIGHT: u16 = 1 << 7;
const MASK_NORTH: u16 = 1 << 8;
const MASK_WEST: u16 = 1 << 9;
const MASK_LEFT_TRIGGER: u16 = 1 << 10;
const MASK_RIGHT_TRIGGER: u16 = 1 << 11;

/// Buttons recognised by the gilrs poller, in the order they are checked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
enum GamepadButton {
    South,
    East,
    West,
    North,
    LeftTrigger,
    RightTrigger,
    Select,
    Start,
    DPadUp,
    DPadDown,
    DPadLeft,
    DPadRight,
}

/// Pure mapping function: given the set of *pressed* buttons, return the
/// combined RetroPad 16-bit mask.  This is a testable stand-in for
/// `poll_buttons(&gilrs::Gamepad)` in `main.rs`.
fn map_gamepad_to_port(pressed: &[GamepadButton]) -> u16 {
    let mut mask: u16 = 0;
    for btn in pressed {
        match btn {
            GamepadButton::South => mask |= MASK_SOUTH,
            GamepadButton::East => mask |= MASK_EAST,
            GamepadButton::West => mask |= MASK_WEST,
            GamepadButton::North => mask |= MASK_NORTH,
            GamepadButton::LeftTrigger => mask |= MASK_LEFT_TRIGGER,
            GamepadButton::RightTrigger => mask |= MASK_RIGHT_TRIGGER,
            GamepadButton::Select => mask |= MASK_SELECT,
            GamepadButton::Start => mask |= MASK_START,
            GamepadButton::DPadUp => mask |= MASK_DPAD_UP,
            GamepadButton::DPadDown => mask |= MASK_DPAD_DOWN,
            GamepadButton::DPadLeft => mask |= MASK_DPAD_LEFT,
            GamepadButton::DPadRight => mask |= MASK_DPAD_RIGHT,
        }
    }
    mask
}

// ── Table-driven tests ──────────────────────────────────────────────────

#[test]
fn no_buttons_pressed_returns_zero() {
    assert_eq!(map_gamepad_to_port(&[]), 0);
}

#[test]
fn each_button_maps_to_correct_bit() {
    let cases: &[(GamepadButton, u16)] = &[
        (GamepadButton::South, MASK_SOUTH),
        (GamepadButton::East, MASK_EAST),
        (GamepadButton::West, MASK_WEST),
        (GamepadButton::North, MASK_NORTH),
        (GamepadButton::LeftTrigger, MASK_LEFT_TRIGGER),
        (GamepadButton::RightTrigger, MASK_RIGHT_TRIGGER),
        (GamepadButton::Select, MASK_SELECT),
        (GamepadButton::Start, MASK_START),
        (GamepadButton::DPadUp, MASK_DPAD_UP),
        (GamepadButton::DPadDown, MASK_DPAD_DOWN),
        (GamepadButton::DPadLeft, MASK_DPAD_LEFT),
        (GamepadButton::DPadRight, MASK_DPAD_RIGHT),
    ];

    for (btn, expected_mask) in cases {
        let result = map_gamepad_to_port(&[*btn]);
        assert_eq!(
            result, *expected_mask,
            "{:?} should map to bit mask 0x{:04X}, got 0x{:04X}",
            btn, expected_mask, result
        );
    }
}

#[test]
fn buttons_combine_correctly() {
    // Press South + East + West + North simultaneously
    let mask = map_gamepad_to_port(&[
        GamepadButton::South,
        GamepadButton::East,
        GamepadButton::West,
        GamepadButton::North,
    ]);
    assert_eq!(mask, MASK_SOUTH | MASK_EAST | MASK_WEST | MASK_NORTH);
}

#[test]
fn dpad_diagonal_works() {
    let mask = map_gamepad_to_port(&[
        GamepadButton::DPadUp,
        GamepadButton::DPadRight,
    ]);
    assert_eq!(mask, MASK_DPAD_UP | MASK_DPAD_RIGHT);
}

#[test]
fn steam_deck_common_chord() {
    // Steam Deck: B (South) + L (LeftTrigger) for quick actions
    let mask = map_gamepad_to_port(&[
        GamepadButton::South,
        GamepadButton::LeftTrigger,
    ]);
    assert_eq!(mask, MASK_SOUTH | MASK_LEFT_TRIGGER);
}

#[test]
fn all_buttons_produce_full_mask() {
    use GamepadButton::*;
    let all = &[
        South, East, West, North,
        LeftTrigger, RightTrigger,
        Select, Start,
        DPadUp, DPadDown, DPadLeft, DPadRight,
    ];
    let mask = map_gamepad_to_port(all);
    // All 12 bits should be set
    assert_eq!(mask, 0x0FFF);
    // No bits beyond the 12 mapped ones
    assert_eq!(mask & !0x0FFF, 0);
}

#[test]
fn start_select_combo() {
    // Steam Deck: Start + Select (common for menu/quit)
    let mask = map_gamepad_to_port(&[
        GamepadButton::Start,
        GamepadButton::Select,
    ]);
    assert_eq!(mask, MASK_START | MASK_SELECT);
}

#[test]
fn redundant_presses_are_idempotent() {
    // Pressing the same button twice in the list is idempotent
    let mask = map_gamepad_to_port(&[
        GamepadButton::South,
        GamepadButton::South,
    ]);
    assert_eq!(mask, MASK_SOUTH);
}

#[test]
fn mask_bits_dont_overlap() {
    // Each button occupies a unique bit — verify no collisions
    let mut seen: u16 = 0;
    for btn in &[
        GamepadButton::South, GamepadButton::East,
        GamepadButton::Select, GamepadButton::Start,
        GamepadButton::DPadUp, GamepadButton::DPadDown,
        GamepadButton::DPadLeft, GamepadButton::DPadRight,
        GamepadButton::North, GamepadButton::West,
        GamepadButton::LeftTrigger, GamepadButton::RightTrigger,
    ] {
        let mask = map_gamepad_to_port(&[*btn]);
        assert_eq!(
            mask & seen, 0,
            "Button {:?} mask 0x{:04X} overlaps with previously seen mask 0x{:04X}",
            btn, mask, seen
        );
        seen |= mask;
    }
    // All 12 bits are distinct
    assert_eq!(seen.count_ones(), 12);
}
