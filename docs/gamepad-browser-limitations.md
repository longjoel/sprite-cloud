# Browser gamepad limitations

Games Vault uses the browser Gamepad API for physical controllers in the Nosebleed web player. Some controller behavior is intentionally controlled by the browser for privacy/fingerprinting protection, so the app cannot always force discovery of a controller that was already plugged in before the page opened.

## Browser behavior

Firefox and Chromium-based browsers can gate gamepad visibility until the page has seen gamepad input. Firefox's source makes the browser-side gating explicit:

- `Navigator::GetGamepads` registers the page as a gamepad listener, then asks the window for the currently exposed pads.
- `GamepadManager::FireConnectionEvent` skips `gamepadconnected` for pages that have not `HasSeenGamepadInput()`.
- `GamepadManager::SetWindowHasSeenGamepad` only marks the window as having seen input after gamepad input arrives, then clones/adds that gamepad to the window.
- Firefox also suppresses Gamepad API events when fingerprinting resistance is enabled.

Source checked: Mozilla `mozilla-central`:

- `dom/base/Navigator.cpp`, `Navigator::GetGamepads`
- `dom/gamepad/GamepadManager.cpp`, `FireConnectionEvent`, `SetWindowHasSeenGamepad`, and `SetGamepadByEvent`

## User-facing guidance

If a controller was already plugged in before opening the game and the browser does not expose it to the page:

1. Focus the game page.
2. Press a controller button or move a stick.
3. If it still does not respond, unplug the controller, plug it back in, then press a button.

This is a browser privacy limitation, not a Nosebleed runtime failure. Keyboard and touch controls should continue to work while the browser has not exposed a physical controller.

## Product stance

Do not keep adding Gamepad API workarounds that imply Games Vault can force Firefox to enumerate hidden devices. Keep the player implementation defensive:

- poll `navigator.getGamepads()`;
- listen for `gamepadconnected` / `gamepaddisconnected`;
- ignore `null` or `connected === false` entries;
- cache event-provided gamepads;
- document the unplug/replug workaround where users can see it.
