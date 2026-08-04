import { test, expect, Page } from '@playwright/test';

// The LAN player page declares `let dc` at the top of its inline script.
// It is NOT on window (top-level let), but IS visible as a global lexical
// binding to code injected into the page. Declare it here for TS.
declare const dc: RTCDataChannel | undefined;

/**
 * L1 browser-to-emulator E2E (#662 slice 2).
 *
 * Journey: headless Chrome -> sc-server standalone LAN player (8787)
 * -> WebRTC -> nestopia -> counter.nes fixture.
 *
 * Assertions (deterministic by fixture design):
 *   - game appears in the library
 *   - WebRTC connects, video+audio tracks attach, frames decode
 *   - boot frame decodes to digits "0000" (signature probe, not pixel hash)
 *   - A-press changes digits to "0001" (input acknowledgement)
 *   - save_state persists, counter advances to "0003", load_state restores "0001"
 *   - stop tears the session down; relaunch boots clean to "0000" again
 */

const DIGIT_ROW = 8;      // nametable row 1 -> pixel y=8..15 (256x240)
const DIGIT_COL = 80;     // nametable col 10 -> pixel x=80..111
const CELL = 8;

// Expected white-pixel row signatures per glyph (see fixture README).
// Derived from the 16-byte pattern-table font in rom/counter.s (plane 0,
// bit7=leftmost): each row = lit-pixel count.
const GLYPHS: Record<string, number[]> = {
  '0': [3, 2, 2, 2, 2, 2, 3, 0],
  '1': [1, 2, 1, 1, 1, 1, 3, 0],
  '2': [3, 2, 1, 2, 1, 1, 5, 0],
  '3': [3, 2, 1, 3, 1, 2, 3, 0],
  '4': [2, 2, 2, 5, 1, 1, 1, 0],
  '5': [5, 1, 1, 4, 1, 2, 3, 0],
  '6': [3, 1, 1, 4, 2, 2, 3, 0],
  '7': [5, 1, 1, 1, 1, 1, 1, 0],
  '8': [3, 2, 2, 3, 2, 2, 3, 0],
  '9': [3, 2, 2, 4, 1, 2, 3, 0],
};
const REVERSE = new Map(Object.entries(GLYPHS).map(([d, s]) => [s.join(','), d]));

/** Read the 4 digit glyphs off the live <video> element. */
async function probeDigits(page: Page): Promise<string> {
  const reverse = Object.fromEntries(
    Object.entries(GLYPHS).map(([d, s]) => [s.join(','), d]),
  );
  return page.evaluate(({ reverse, DIGIT_ROW, DIGIT_COL, CELL }) => {
    const video = document.getElementById('video') as HTMLVideoElement;
    if (!video || video.videoWidth === 0) return 'NOV';
    const c = document.createElement('canvas');
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(video, 0, 0);
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const W = c.width;
    const sig = (t: number): number[] => {
      const rows: number[] = [];
      for (let y = DIGIT_ROW; y < DIGIT_ROW + CELL; y++) {
        let n = 0;
        for (let x = DIGIT_COL + t * CELL; x < DIGIT_COL + (t + 1) * CELL; x++) {
          const i = (y * W + x) * 4;
          if (img.data[i] > 150 && img.data[i + 1] > 150 && img.data[i + 2] > 150) n++;
        }
        rows.push(n);
      }
      return rows;
    };
    const out: string[] = [];
    for (let t = 0; t < 4; t++) out.push(reverse[sig(t).join(',')] ?? '?');
    return out.join('');
  }, { reverse, DIGIT_ROW, DIGIT_COL, CELL });
}

/**
 * Wait until the digits settle to an expected value (polling probe).
 *
 * Determinism guard: each poll first waits for the decoded-frame counter to
 * ADVANCE, then reads. Without this, a stalled/torn video element returns
 * the same frozen frame on every poll — a cold CI runner hiccup would show
 * `????` for the whole timeout even though the emulator is fine.
 */
async function expectDigits(page: Page, expected: string, timeoutMs = 15000) {
  await expect
    .poll(
      async () => {
        // Wait for a fresh frame before trusting any reading.
        const before = await page.evaluate(() => (window as any).__decodedFrames ?? 0);
        await page.waitForFunction(
          (prev) => (window as any).__decodedFrames > prev,
          before,
          { timeout: 5000 },
        ).catch(() => {});
        return probeDigits(page);
      },
      { timeout: timeoutMs, intervals: [250, 500] },
    )
    .toBe(expected);
}

/**
 * Press A (x → libretro id 8 → NES A) and HOLD until the counter actually
 * increments, then release. Deterministic against emulator pause timing:
 * a press that lands while the core is (un)pausing (e.g. right after
 * save_state) is simply held until it registers — no fixed 250ms windows
 * that can drop input on a slow runner.
 *
 * After release we wait a frame: the ROM counts on the RISING edge of the
 * button bit, so the keyup must be seen by the 60fps poll loop before the
 * next press. Re-pressing in the same frame as the release would swallow
 * the edge (counter stuck at 0002→0003 — the original flake).
 */
async function pressA(page: Page, from: string) {
  const next = String(Number(from) + 1).padStart(4, '0');
  await page.keyboard.down('x');
  try {
    await expectDigits(page, next);
  } finally {
    await page.keyboard.up('x');
  }
  // Let the ROM's poll loop observe the falling edge (one frame @60fps).
  await page.waitForTimeout(100);
}

/** Count decoded video frames via requestVideoFrameCallback. */
async function installFrameCounter(page: Page) {
  await page.evaluate(() => {
    (window as any).__decodedFrames = 0;
    const video = document.getElementById('video') as HTMLVideoElement;
    if ('requestVideoFrameCallback' in video) {
      const tick = () => {
        (window as any).__decodedFrames++;
        video.requestVideoFrameCallback(tick);
      };
      video.requestVideoFrameCallback(tick);
    }
  });
}

/** Send a JSON command over the session DataChannel, resolve with the reply.
 *  The server's reply cmd drops the `_state` suffix (save_state ->
 *  save_result, load_state -> load_result). */
async function dcCommand(page: Page, cmd: string, extra: Record<string, unknown> = {}) {
  const expected = cmd === 'save_state' || cmd === 'load_state'
    ? cmd.replace('_state', '_result')
    : `${cmd}_result`;
  return page.evaluate(({ cmd, extra, expected }) => {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      // `dc` is a top-level `let` in the player page's inline script —
      // visible to injected code via the global lexical environment.
      // NOTE: must not name this local `dc` — `const dc = ... ?? eval('dc')`
      // would self-reference the binding being initialized (TDZ error).
      // eslint-disable-next-line no-eval, @typescript-eslint/no-implied-eval
      const chan = (window as any).__dc ?? (eval('dc') as RTCDataChannel | undefined);
      if (!chan || chan.readyState !== 'open') {
        reject(new Error('dc not open'));
        return;
      }
      const onMsg = (ev: MessageEvent) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.cmd === expected) {
          chan.removeEventListener('message', onMsg);
          clearTimeout(timer);
          resolve(msg);
        }
      };
      const timer = setTimeout(() => {
        chan.removeEventListener('message', onMsg);
        reject(new Error(`timeout waiting for ${expected}`));
      }, 8000);
      chan.addEventListener('message', onMsg);
      chan.send(JSON.stringify({ cmd, ...extra }));
    });
  }, { cmd, extra, expected });
}

/** Wait until the player page's DataChannel is open and reachable. */
async function exposeDataChannel(page: Page) {
  await page.waitForFunction(() => {
    try {
      // Direct identifier reference: `dc` is a top-level `let` in the
      // page's inline script, visible to code running in the page scope.
      // (NOTE: `eval` does NOT see it here — only direct references do.)
      // eslint-disable-next-line no-undef
      return (typeof (dc as any) !== 'undefined' && !!(dc as any) && (dc as any).readyState === 'open');
    } catch {
      return false;
    }
  }, { timeout: 20000 });
}

test('browser -> emulator: launch, input, save/load, stop, relaunch', async ({ page }) => {
  // ── library ─────────────────────────────────────────────────────
  await page.goto('/');
  // h1 is "<hostname>"/"🎮 <hostname>" — machine-specific; assert the
  // standalone page marker instead.
  await expect(page.locator('body')).toContainText('Standalone mode');
  await expect(page.locator('.play').first()).toBeVisible({ timeout: 15000 });
  const gameRow = page.locator('li', { hasText: 'counter' });
  await expect(gameRow).toBeVisible();

  // ── launch ──────────────────────────────────────────────────────
  await installFrameCounter(page);
  await gameRow.locator('.play').click();

  // DC open is the reliable readiness signal (the page's status text
  // races between "Connected" (DC onopen) and "connected" (ICE state)).
  await exposeDataChannel(page);

  // Video track attached + frames decoding
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const v = document.getElementById('video') as HTMLVideoElement;
        return v.videoWidth > 0 && v.videoHeight > 0 && !!v.srcObject;
      }),
      { timeout: 20000 },
    )
    .toBe(true);
  await expect
    .poll(async () => page.evaluate(() => (window as any).__decodedFrames), { timeout: 30000 })
    .toBeGreaterThan(30);
  const res = await page.evaluate(() => {
    const v = document.getElementById('video') as HTMLVideoElement;
    return `${v.videoWidth}x${v.videoHeight}`;
  });
  expect(res).toBe('256x240');

  // Boot frame is deterministic: 0000
  await expectDigits(page, '0000');

  // ── input ───────────────────────────────────────────────────────
  await pressA(page, '0000');

  // ── save/load round trip ────────────────────────────────────────
  const save = await dcCommand(page, 'save_state');
  expect(save.ok).toBe(true);
  expect(typeof save.index).toBe('number');

  await pressA(page, '0001');
  await pressA(page, '0002');

  const load = await dcCommand(page, 'load_state', { index: save.index as number });
  expect(load.ok).toBe(true);
  await expectDigits(page, '0001');

  // ── stop ────────────────────────────────────────────────────────
  await page.click('#closePlayer');
  await expect(page.locator('#player')).not.toHaveClass(/active/, { timeout: 10000 });

  // ── relaunch: clean boot again ──────────────────────────────────
  await installFrameCounter(page);
  await page.locator('.play').first().click();
  await exposeDataChannel(page);
  await expect
    .poll(async () => page.evaluate(() => (window as any).__decodedFrames), { timeout: 30000 })
    .toBeGreaterThan(30);
  await expectDigits(page, '0000');
});
