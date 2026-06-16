1|# Standard Platform → Core Mapping Implementation Plan
2|
3|> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.
4|
5|**Goal:** Replace the ad-hoc `core_for_platform()` match statement with a data-driven lookup table covering all major game platforms (~25 systems), expand ROM extension detection to match, and fix the broken auto-download test.
6|
7|**Architecture:** A single `const CORE_MAP: &[(&str, &str)]` static slice in `worker.rs` maps platform names (both short and full DAT names) to core filenames. `core_for_platform()` becomes a linear scan with first-match-wins semantics. The `EXTENSION_MAP` in `scan.rs` grows to cover all common ROM extensions for these platforms.
8|
9|**Tech Stack:** Rust (edition 2024), existing gv-server crate, serde for optional serialization.
10|
11|---
12|
13|## Security model (baked into each task)
14|
15|| Threat | Mitigation | Where |
16||---|---|---|
17|| Zip bomb from buildbot | Validate zip contains exactly 1 `.so` file (already exists) | Task 1 |
18|| Wrong core loaded for platform | Test table coverage matches EXTENSION_MAP entries | Task 4 |
19|| Silent fallback to test pattern | `core_for_platform` returns `None` only for genuinely unknown platforms; all EXTENSION_MAP platforms have entries | Task 3 |
20|
21|---
22|
23|### Task 1: Fix the `ensure_core_skips_when_cached` test
24|
25|**Objective:** The test sets `GV_CORES_DIR` env var but the function falls through to download. Root cause: the test is an integration test in `tests/`, and `CARGO_MANIFEST_DIR` points to `gv-server/`, not the workspace root. The `resolve_core_path()` fallback path (`../../../cores/`) may already resolve to a valid directory (the workspace `test-data/cores/`), so even when `GV_CORES_DIR` is set, the function may still pick up the workspace path.
26|
27|**Files:**
28|- Modify: `gv-server/tests/core_download_test.rs`
29|- Modify: `gv-server/src/worker.rs` — `resolve_core_path()`
30|
31|**Step 1: Fix `resolve_core_path` fallback logic**
32|
33|The current fallback path `p.pop(); p.pop(); p.push("cores")` after the `test-data/cores` block is wrong — it pops twice after already popping once from `CARGO_MANIFEST_DIR`. That's 3 pops from `gv-server/`, which goes up to `/` and then down to `cores/`. The correct fallback should be:
34|
35|```rust
36|fn resolve_core_path(core_filename: &str) -> PathBuf {
37|    if let Ok(dir) = std::env::var("GV_CORES_DIR") {
38|        return PathBuf::from(&dir).join(core_filename);
39|    }
40|    // Default: workspace/test-data/cores/
41|    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
42|    p.pop(); // gv-server → workspace
43|    p.push("test-data/cores");
44|    if p.exists() {
45|        return p.join(core_filename);
46|    }
47|    // Fallback: workspace/cores/
48|    p.pop(); // remove test-data/cores
49|    p.pop(); // remove cores
50|    p.push("cores");
51|    p.join(core_filename)
52|}
53|```
54|
55|**Step 2: Fix the test to use the temp dir**
56|
57|The test already sets `GV_CORES_DIR` correctly. With the fix above, `resolve_core_path` will return the temp dir path and the fast-path check (`core_path.exists()`) will find the file.
58|
59|**Step 3: Run the test**
60|
61|```bash
62|cargo test -p gv-server --test core_download_test
63|```
64|Expected: 2 passed.
65|
66|**Step 4: Commit**
67|
68|```bash
69|git add gv-server/src/worker.rs gv-server/tests/core_download_test.rs
70|git commit -m "fix: correct resolve_core_path fallback and fix cached-core test"
71|```
72|
73|---
74|
75|### Task 2: Convert `core_for_platform()` to a data-driven table
76|
77|**Objective:** Replace the `match` statement with a `static` slice. First-match-wins — put more specific names before broader ones (e.g., "Game Boy Advance" before "Game Boy").
78|
79|**Files:**
80|- Modify: `gv-server/src/worker.rs`
81|
82|**Step 1: Define the mapping table**
83|
84|Replace the entire `core_for_platform()` function and the match block with:
85|
86|```rust
87|/// Platform → core filename mapping.
88|///
89|/// First match wins — put specific names before broad ones.
90|/// Both full RetroArch DAT names and short aliases are included.
91|/// Override any entry via `GV_CORE_OVERRIDE_<sanitized_platform>` env var.
92|const CORE_MAP: &[(&str, &str)] = &[
93|    // ── Nintendo — Game Boy family ─────────────────────────────────
94|    ("Nintendo - Game Boy Advance", "mgba_libretro.so"),
95|    ("Nintendo - Game Boy Color", "gambatte_libretro.so"),
96|    ("Nintendo - Game Boy", "gambatte_libretro.so"),
97|    ("Game Boy Advance", "mgba_libretro.so"),
98|    ("Game Boy Color", "gambatte_libretro.so"),
99|    ("Game Boy", "gambatte_libretro.so"),
100|
101|    // ── Nintendo — NES ────────────────────────────────────────────
102|    ("Nintendo - Nintendo Entertainment System", "nestopia_libretro.so"),
103|    ("Nintendo - Family Computer Disk System", "nestopia_libretro.so"),
104|    ("NES", "nestopia_libretro.so"),
105|    ("Family Computer Disk System", "nestopia_libretro.so"),
106|
107|    // ── Nintendo — SNES ───────────────────────────────────────────
108|    ("Nintendo - Super Nintendo Entertainment System", "snes9x_libretro.so"),
109|    ("SNES", "snes9x_libretro.so"),
110|
111|    // ── Nintendo — N64 ────────────────────────────────────────────
112|    ("Nintendo - Nintendo 64", "mupen64plus_next_libretro.so"),
113|    ("Nintendo 64", "mupen64plus_next_libretro.so"),
114|
115|    // ── Nintendo — Nintendo DS ────────────────────────────────────
116|    ("Nintendo - Nintendo DS", "desmume_libretro.so"),
117|    ("Nintendo DS", "desmume_libretro.so"),
118|
119|    // ── Nintendo — Virtual Boy ────────────────────────────────────
120|    ("Nintendo - Virtual Boy", "mednafen_vb_libretro.so"),
121|    ("Virtual Boy", "mednafen_vb_libretro.so"),
122|
123|    // ── Nintendo — Pokemon Mini ───────────────────────────────────
124|    ("Nintendo - Pokemon Mini", "pokemini_libretro.so"),
125|    ("Pokemon Mini", "pokemini_libretro.so"),
126|
127|    // ── Sega — Master System / Genesis / Game Gear ─────────────────
128|    ("Sega - Mega Drive - Genesis", "genesis_plus_gx_libretro.so"),
129|    ("Sega - Master System - Mark III", "genesis_plus_gx_libretro.so"),
130|    ("Sega - Game Gear", "genesis_plus_gx_libretro.so"),
131|    ("Sega - Sega CD - Mega CD", "genesis_plus_gx_libretro.so"),
132|    ("Genesis", "genesis_plus_gx_libretro.so"),
133|    ("Master System", "genesis_plus_gx_libretro.so"),
134|    ("Game Gear", "genesis_plus_gx_libretro.so"),
135|    ("Sega CD", "genesis_plus_gx_libretro.so"),
136|
137|    // ── Sega — 32X ────────────────────────────────────────────────
138|    ("Sega - Sega 32X", "picodrive_libretro.so"),
139|    ("Sega 32X", "picodrive_libretro.so"),
140|
141|    // ── Sega — Saturn ─────────────────────────────────────────────
142|    ("Sega - Saturn", "yabause_libretro.so"),
143|    ("Saturn", "yabause_libretro.so"),
144|
145|    // ── Sega — Dreamcast ──────────────────────────────────────────
146|    ("Sega - Dreamcast", "flycast_libretro.so"),
147|    ("Dreamcast", "flycast_libretro.so"),
148|
149|    // ── Sony — PlayStation ────────────────────────────────────────
150|    ("Sony - PlayStation", "pcsx_rearmed_libretro.so"),
151|    ("PlayStation", "pcsx_rearmed_libretro.so"),
152|
153|    // ── Sony — PlayStation Portable ───────────────────────────────
154|    ("Sony - PlayStation Portable", "ppsspp_libretro.so"),
155|    ("PlayStation Portable", "ppsspp_libretro.so"),
156|    ("PSP", "ppsspp_libretro.so"),
157|
158|    // ── Atari — 2600 / 5200 / 7800 / Lynx ─────────────────────────
159|    ("Atari - 2600", "stella_libretro.so"),
160|    ("Atari 2600", "stella_libretro.so"),
161|    ("Atari - 5200", "a5200_libretro.so"),
162|    ("Atari 5200", "a5200_libretro.so"),
163|    ("Atari - 7800", "prosystem_libretro.so"),
164|    ("Atari 7800", "prosystem_libretro.so"),
165|    ("Atari - Lynx", "handy_libretro.so"),
166|    ("Atari Lynx", "handy_libretro.so"),
167|
168|    // ── NEC — PC Engine / TurboGrafx ──────────────────────────────
169|    ("NEC - PC Engine - TurboGrafx-16", "mednafen_pce_fast_libretro.so"),
170|    ("NEC - PC Engine CD - TurboGrafx-CD", "mednafen_pce_fast_libretro.so"),
171|    ("PC Engine", "mednafen_pce_fast_libretro.so"),
172|    ("TurboGrafx-16", "mednafen_pce_fast_libretro.so"),
173|    ("TurboGrafx-CD", "mednafen_pce_fast_libretro.so"),
174|
175|    // ── SNK — Neo Geo / Neo Geo CD / Neo Geo Pocket ───────────────
176|    ("SNK - Neo Geo Pocket", "mednafen_ngp_libretro.so"),
177|    ("SNK - Neo Geo Pocket Color", "mednafen_ngp_libretro.so"),
178|    ("SNK - Neo Geo CD", "neocd_libretro.so"),
179|    ("Neo Geo Pocket", "mednafen_ngp_libretro.so"),
180|    ("Neo Geo Pocket Color", "mednafen_ngp_libretro.so"),
181|    ("Neo Geo CD", "neocd_libretro.so"),
182|
183|    // ── Bandai — WonderSwan ───────────────────────────────────────
184|    ("Bandai - WonderSwan", "mednafen_wswan_libretro.so"),
185|    ("Bandai - WonderSwan Color", "mednafen_wswan_libretro.so"),
186|    ("WonderSwan", "mednafen_wswan_libretro.so"),
187|    ("WonderSwan Color", "mednafen_wswan_libretro.so"),
188|
189|    // ── Arcade ────────────────────────────────────────────────────
190|    ("Arcade", "fbneo_libretro.so"),
191|];
192|
193|/// Resolve a platform name to a core filename.
194|///
195|/// Scans [`CORE_MAP`] and returns the first matching core filename.
196|/// Falls back to `GV_CORE_OVERRIDE_<sanitized>` env var before
197|/// consulting the table.
198|pub fn core_for_platform(platform: &str) -> Option<&'static str> {
199|    // Env var override takes priority
200|    let override_key = platform.replace(' ', "_").replace('-', "_");
201|    let env_key = format!("GV_CORE_OVERRIDE_{override_key}");
202|    if let Ok(custom) = std::env::var(&env_key) {
203|        return Some(Box::leak(custom.into_boxed_str()));
204|    }
205|
206|    // Linear scan — first match wins
207|    for &(name, core) in CORE_MAP {
208|        if name == platform {
209|            return Some(core);
210|        }
211|    }
212|
213|    tracing::debug!("[CORE] no mapping for platform: {platform}");
214|    None
215|}
216|```
217|
218|**Note:** The env var override leaks a small string. This is intentional — the override is read once per worker spawn, and the lifetime of the string is the life of the process. It's a ~50-byte leak at most. If this is a concern, we can use a `Mutex<HashMap<String, String>>` instead, but the tuple return type change from `Option<String>` to `Option<&'static str>` requires updating the call site.
219|
220|**Step 2: Update call sites**
221|
222|In `spawn_worker()`, the call currently does:
223|```rust
224|if let Some(plat) = platform {
225|    if let Some(core_file) = core_for_platform(plat) {
226|        // core_file is now &'static str instead of String
227|```
228|
229|This works directly since the usage is just `cmd.env("GV_CORE_PATH", ...)`.
230|
231|**Step 3: Run existing tests**
232|
233|```bash
234|cargo test -p gv-server
235|```
236|Expected: all tests pass (13 tests).
237|
238|**Step 4: Commit**
239|
240|```bash
241|git add gv-server/src/worker.rs
242|git commit -m "refactor: data-driven platform→core mapping table (25 platforms)"
243|```
244|
245|---
246|
247|### Task 3: Test the core mapping table
248|
249|**Objective:** Add unit tests that verify every platform the scanner can detect has a core mapping. This prevents silent test-pattern fallback when a new extension is added.
250|
251|**Files:**
252|- Modify: `gv-server/src/worker.rs` (add tests to existing `#[cfg(test)] mod tests`)
253|
254|**Step 1: Add mapping coverage tests**
255|
256|Add the following tests to the existing `mod tests` block in `worker.rs`:
257|
258|```rust
259|/// Every platform in EXTENSION_MAP must have a core mapping.
260|/// Catches gaps where a scanner-detected platform silently
261|/// falls back to test pattern.
262|#[test]
263|fn every_scan_platform_has_core_mapping() {
264|    use crate::scan::EXTENSION_MAP;
265|
266|    let mut platforms: std::collections::HashSet<&str> =
267|        EXTENSION_MAP.iter().map(|(_, p)| *p).collect();
268|
269|    let missing: Vec<_> = platforms
270|        .iter()
271|        .filter(|p| core_for_platform(p).is_none())
272|        .collect();
273|
274|    assert!(
275|        missing.is_empty(),
276|        "EXTENSION_MAP platforms without core mappings: {missing:?}"
277|    );
278|}
279|
280|/// Full DAT names come from RetroArch DAT files and are the
281|/// canonical platform identifiers. Verify they all have mappings.
282|#[test]
283|fn retroarch_dat_platforms_have_core_mapping() {
284|    let dat_platforms = &[
285|        "Nintendo - Game Boy",
286|        "Nintendo - Game Boy Color",
287|        "Nintendo - Game Boy Advance",
288|        "Nintendo - Nintendo Entertainment System",
289|        "Nintendo - Family Computer Disk System",
290|        "Nintendo - Super Nintendo Entertainment System",
291|        "Nintendo - Nintendo 64",
292|        "Nintendo - Nintendo DS",
293|        "Nintendo - Virtual Boy",
294|        "Nintendo - Pokemon Mini",
295|        "Sega - Mega Drive - Genesis",
296|        "Sega - Master System - Mark III",
297|        "Sega - Game Gear",
298|        "Sega - Sega CD - Mega CD",
299|        "Sega - Sega 32X",
300|        "Sega - Saturn",
301|        "Sega - Dreamcast",
302|        "Sony - PlayStation",
303|        "Sony - PlayStation Portable",
304|        "Atari - 2600",
305|        "Atari - 5200",
306|        "Atari - 7800",
307|        "Atari - Lynx",
308|        "NEC - PC Engine - TurboGrafx-16",
309|        "NEC - PC Engine CD - TurboGrafx-CD",
310|        "SNK - Neo Geo Pocket",
311|        "SNK - Neo Geo Pocket Color",
312|        "SNK - Neo Geo CD",
313|        "Bandai - WonderSwan",
314|        "Bandai - WonderSwan Color",
315|        "Arcade",
316|    ];
317|
318|    let missing: Vec<_> = dat_platforms
319|        .iter()
320|        .filter(|p| core_for_platform(p).is_none())
321|        .collect();
322|
323|    assert!(
324|        missing.is_empty(),
325|        "DAT platforms without core mappings: {missing:?}"
326|    );
327|}
328|
329|/// First-match-wins: "Game Boy Advance" must not match "Game Boy".
330|#[test]
331|fn specific_platform_matches_before_broad() {
332|    assert_eq!(core_for_platform("Game Boy Advance").as_deref(), Some("mgba_libretro.so"));
333|    assert_eq!(core_for_platform("Game Boy").as_deref(), Some("gambatte_libretro.so"));
334|}
335|```
336|
337|**Step 2: Run the tests**
338|
339|```bash
340|cargo test -p gv-server
341|```
342|Expected: all tests pass (16 tests — 13 existing + 3 new).
343|
344|**Step 3: Commit**
345|
346|```bash
347|git add gv-server/src/worker.rs
348|git commit -m "test: core mapping table coverage for EXTENSION_MAP and DAT platforms"
349|```
350|
351|---
352|
353|### Task 4: Expand EXTENSION_MAP with new platforms
354|
355|**Objective:** Add ROM extensions for the newly mapped platforms so the scanner can detect them.
356|
357|**Files:**
358|- Modify: `gv-server/src/scan.rs`
359|
360|**Step 1: Add extensions**
361|
362|Replace the existing `EXTENSION_MAP` with the expanded version:
363|
364|```rust
365|/// Known ROM file extensions mapped to short platform display names.
366|///
367|/// Extension order within a platform isn't significant, but platforms
368|/// are grouped by system for readability.
369|pub const EXTENSION_MAP: &[(&str, &str)] = &[
370|    // Nintendo — NES
371|    ("nes", "NES"),
372|    ("fds", "Family Computer Disk System"),
373|    // Nintendo — SNES
374|    ("sfc", "SNES"),
375|    ("smc", "SNES"),
376|    // Nintendo — Game Boy family
377|    ("gb", "Game Boy"),
378|    ("gbc", "Game Boy Color"),
379|    ("gba", "Game Boy Advance"),
380|    // Nintendo — N64
381|    ("n64", "Nintendo 64"),
382|    ("z64", "Nintendo 64"),
383|    ("v64", "Nintendo 64"),
384|    // Nintendo — DS
385|    ("nds", "Nintendo DS"),
386|    // Nintendo — misc
387|    ("vb", "Virtual Boy"),
388|    ("min", "Pokemon Mini"),
389|    // Sega — Genesis / Master System / Game Gear / CD
390|    ("gen", "Genesis"),
391|    ("md", "Genesis"),
392|    ("smd", "Genesis"),
393|    ("sms", "Master System"),
394|    ("gg", "Game Gear"),
395|    ("32x", "Sega 32X"),
396|    // Sega — Saturn
397|    ("mdf", "Saturn"),  // disc image — Saturn
398|    // Sega — Dreamcast
399|    ("cdi", "Dreamcast"),
400|    ("gdi", "Dreamcast"),
401|    // Sony — PlayStation / PSP
402|    ("iso", "PlayStation"),
403|    ("cue", "PlayStation"),
404|    ("cso", "PSP"),
405|    // Atari
406|    ("a26", "Atari 2600"),
407|    ("a52", "Atari 5200"),
408|    ("a78", "Atari 7800"),
409|    ("lnx", "Atari Lynx"),
410|    // NEC — PC Engine
411|    ("pce", "PC Engine"),
412|    // SNK
413|    ("ngp", "Neo Geo Pocket"),
414|    ("ngc", "Neo Geo Pocket Color"),
415|    // Bandai
416|    ("ws", "WonderSwan"),
417|    ("wsc", "WonderSwan Color"),
418|    // Arcade
419|    ("zip", "Arcade"),
420|];
421|```
422|
423|**Step 2: Update existing scan tests**
424|
425|The test `detect_platform_from_extension` currently checks `.sfc` → "SNES", `.nes` → "NES". These still work. Add tests for the new extensions:
426|
427|```rust
428|#[test]
429|fn detect_platform_new_extensions() {
430|    assert_eq!(detect_platform(Path::new("/roms/game.a26")), Some("Atari 2600".into()));
431|    assert_eq!(detect_platform(Path::new("/roms/game.nds")), Some("Nintendo DS".into()));
432|    assert_eq!(detect_platform(Path::new("/roms/game.pce")), Some("PC Engine".into()));
433|    assert_eq!(detect_platform(Path::new("/roms/game.gdi")), Some("Dreamcast".into()));
434|    assert_eq!(detect_platform(Path::new("/roms/game.32x")), Some("Sega 32X".into()));
435|    assert_eq!(detect_platform(Path::new("/roms/game.vb")), Some("Virtual Boy".into()));
436|    assert_eq!(detect_platform(Path::new("/roms/game.ngp")), Some("Neo Geo Pocket".into()));
437|    assert_eq!(detect_platform(Path::new("/roms/game.ws")), Some("WonderSwan".into()));
438|}
439|```
440|
441|**Step 3: Run scan tests**
442|
443|```bash
444|cargo test -p gv-server scan
445|```
446|Expected: all scan tests pass.
447|
448|**Step 4: Run mapping coverage test** (from Task 3)
449|
450|```bash
451|cargo test -p gv-server every_scan_platform_has_core_mapping
452|```
453|Expected: PASS — this proves every platform the scanner detects has a core.
454|
455|**Step 5: Commit**
456|
457|```bash
458|git add gv-server/src/scan.rs
459|git commit -m "feat: expand EXTENSION_MAP with 16 new platforms"
460|```
461|
462|---
463|
464|### Task 5: Add .env.example entries
465|
466|**Objective:** Document the new `GV_CORE_OVERRIDE_*` env vars for the expanded platform set, plus any new env vars.
467|
468|**Files:**
469|- Modify: `gv-server/.env.example` (or root `.env.example`)
470|
471|**Step 1: Add env var documentation**
472|
473|```bash
474|# ── Core overrides ──────────────────────────────────────────────
475|# Override the default core for any platform. Sanitize the platform
476|# name: replace spaces with _, hyphens with _.
477|#
478|# Current default mappings:
479|#   NES → nestopia_libretro.so
480|#   SNES → snes9x_libretro.so
481|#   Game Boy → gambatte_libretro.so
482|#   Game Boy Color → gambatte_libretro.so
483|#   Game Boy Advance → mgba_libretro.so
484|#   Nintendo 64 → mupen64plus_next_libretro.so
485|#   Nintendo DS → desmume_libretro.so
486|#   Genesis → genesis_plus_gx_libretro.so
487|#   Master System → genesis_plus_gx_libretro.so
488|#   Game Gear → genesis_plus_gx_libretro.so
489|#   Sega CD → genesis_plus_gx_libretro.so
490|#   Sega 32X → picodrive_libretro.so
491|#   Saturn → yabause_libretro.so
492|#   Dreamcast → flycast_libretro.so
493|#   PlayStation → pcsx_rearmed_libretro.so
494|#   PSP → ppsspp_libretro.so
495|#   Atari 2600 → stella_libretro.so
496|#   Atari 5200 → a5200_libretro.so
497|#   Atari 7800 → prosystem_libretro.so
498|#   Atari Lynx → handy_libretro.so
499|#   PC Engine → mednafen_pce_fast_libretro.so
500|#   Neo Geo Pocket → mednafen_ngp_libretro.so
501|