//! Shared retry helper — single source of truth for backoff strategy.
//!
//! Extracted so every call site uses the same mechanism.  When we add
//! more retry-needing calls (health checks, status updates, etc.),
//! they all funnel through here.

use std::time::Duration;

/// Retry an async fallible operation with exponential backoff.
///
/// `base_delay` is the delay before the *first* retry.  Subsequent
/// retries double it: `base * 2^(attempt-1)`.
///
/// Returns `Ok(v)` on the first successful attempt, or the last
/// `Err(e)` after `max_attempts` failures.
pub async fn with_retry<F, Fut, T, E>(
    max_attempts: u32,
    base_delay: Duration,
    mut f: F,
) -> Result<T, E>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, E>>,
{
    let mut last_err = None;

    for attempt in 1..=max_attempts {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) => {
                last_err = Some(e);
                if attempt < max_attempts {
                    let delay = base_delay * 2u32.pow(attempt - 1);
                    tokio::time::sleep(delay).await;
                }
            }
        }
    }

    // SAFETY: last_err is always Some when the loop exits because
    // max_attempts >= 1 and the Err branch always sets it.
    Err(last_err.expect("last_err always Some after retry loop"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[tokio::test]
    async fn succeeds_on_first_try() {
        let calls = AtomicU32::new(0);
        let result = with_retry(3, Duration::from_millis(1), || {
            let calls = &calls;
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok::<_, &str>(42)
            }
        })
        .await;
        assert_eq!(result.unwrap(), 42);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn retries_until_success() {
        let calls = AtomicU32::new(0);
        let result = with_retry(3, Duration::from_millis(1), || {
            let calls = &calls;
            async move {
                let n = calls.fetch_add(1, Ordering::SeqCst) + 1;
                if n < 3 {
                    Err("fail")
                } else {
                    Ok(99)
                }
            }
        })
        .await;
        assert_eq!(result.unwrap(), 99);
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn exhausts_all_attempts() {
        let calls = AtomicU32::new(0);
        let result: Result<(), &str> = with_retry(3, Duration::from_millis(1), || {
            let calls = &calls;
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                Err("nope")
            }
        })
        .await;
        assert_eq!(result.unwrap_err(), "nope");
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }
}
