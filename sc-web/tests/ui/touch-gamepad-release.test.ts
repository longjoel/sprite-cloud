import { describe, expect, it, vi } from "vitest";
import { releaseVisibleTouchGamepad } from "@/lib/ui/player-overlay-state";

describe("releaseVisibleTouchGamepad", () => {
  it("releases active input without changing a visible preference", () => {
    const touchGamepad = { hide: vi.fn(), show: vi.fn() };

    releaseVisibleTouchGamepad(touchGamepad, true);

    expect(touchGamepad.hide).toHaveBeenCalledOnce();
    expect(touchGamepad.show).toHaveBeenCalledOnce();
    expect(touchGamepad.hide.mock.invocationCallOrder[0]).toBeLessThan(
      touchGamepad.show.mock.invocationCallOrder[0],
    );
  });

  it("does nothing when the touch gamepad preference is hidden", () => {
    const touchGamepad = { hide: vi.fn(), show: vi.fn() };

    releaseVisibleTouchGamepad(touchGamepad, false);

    expect(touchGamepad.hide).not.toHaveBeenCalled();
    expect(touchGamepad.show).not.toHaveBeenCalled();
  });
});
