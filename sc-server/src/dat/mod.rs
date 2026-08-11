//! DAT catalog module — parse No-Intro/Logiqx XML DAT files and index
//! them for O(1) hash-based ROM identity lookup.
//!
//! ## Three-tier behavior (feature, not filter)
//!
//! | Scenario | Behavior |
//! |---|---|
//! | No DAT for platform | Auto-commit, file lands in ROM root as before |
//! | DAT exists, file matches | Show in review with confidence badge, admin confirms |
//! | DAT exists, file unmatched | Show in review as "unverified", admin can commit or reject |
//!
//! ## Architecture
//!
//! - `parser` — hardened XML parser with resource limits (No-Intro/Redump)
//! - `types` — ROM entry, index, match result, provenance
//! - The index lives here; the `platform` module maps platforms to their
//!   loaded DATs.

pub(crate) mod catalog;
pub(crate) mod parser;
pub(crate) mod types;

// Re-export the public API (used by downstream modules — child 3+)
#[allow(unused_imports)]
pub(crate) use parser::{parse_dat, ParseError, ParseLimits};
#[allow(unused_imports)]
pub(crate) use types::{DatIndex, DatMatch, DatProvenance, MatchConfidence, ParseResult, RomEntry};
