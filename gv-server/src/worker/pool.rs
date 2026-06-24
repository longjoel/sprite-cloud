//! Warm worker pool — keeps idle no-ROM gv-worker processes ready
//! so the first play request avoids cold-start process spawn latency.
//!
//! Combined with fast-SDP (#475), this means the browser can establish
//! WebRTC before the game core finishes loading.
//!
//! # Lifecycle
//!
//! - On startup: spawn `size` idle workers with no ROM/platform
//! - On checkout: take an idle worker, kill it (warmed-up binary),
//!   spawn the real game worker, refill pool in background
//! - On session stop: the real worker is killed normally
//! - Pool workers are single-use: checkout kills them, never returns them

use anyhow::{Context, Result};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use super::spawn::{SpawnedWorker, spawn_worker};

/// Configuration for the warm worker pool.
#[derive(Debug, Clone)]
pub struct PoolConfig {
    pub enabled: bool,
    pub size: usize,
    pub max_size: usize,
}

impl Default for PoolConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            size: 0,
            max_size: 2,
        }
    }
}

/// A pool of idle no-ROM gv-worker processes.
///
/// Pool workers are spawned without `content_path` or `platform`,
/// so they start fast (no core download) and are immediately ready
/// for SDP thanks to #475.
pub struct WarmWorkerPool {
    config: PoolConfig,
    idle: Arc<Mutex<Vec<SpawnedWorker>>>,
    worker_bin: Option<String>,
    refill_handle: Mutex<Option<JoinHandle<()>>>,
}

impl WarmWorkerPool {
    /// Create a new pool and spawn initial workers.
    pub async fn new(config: PoolConfig, worker_bin: Option<String>) -> Result<Self> {
        let pool = Self {
            config: config.clone(),
            idle: Arc::new(Mutex::new(Vec::with_capacity(config.max_size))),
            worker_bin,
            refill_handle: Mutex::new(None),
        };

        if config.enabled && config.size > 0 {
            pool.fill(config.size).await?;
        }

        Ok(pool)
    }

    /// Fill the pool up to `target` idle workers.
    async fn fill(&self, target: usize) -> Result<()> {
        let mut idle = self.idle.lock().await;
        let current = idle.len();
        let to_spawn = target.saturating_sub(current);

        for i in 0..to_spawn {
            let pool_id = format!("pool-{}", current + i);
            tracing::info!("[POOL] spawning idle worker {pool_id}");

            match spawn_worker(
                &pool_id,
                self.worker_bin.as_deref(),
                None, // no host_token for pool workers
                None, // no content_path
                None, // no platform
                None, // no peer_tokens
            )
            .await
            {
                Ok(worker) => {
                    tracing::info!(
                        "[POOL] idle worker {pool_id} ready at {}",
                        worker.url
                    );
                    idle.push(worker);
                }
                Err(e) => {
                    tracing::error!("[POOL] failed to spawn idle worker {pool_id}: {e}");
                }
            }
        }

        Ok(())
    }

    /// Try to check out an idle worker from the pool.
    ///
    /// Returns `Some(worker)` if an idle worker was available,
    /// `None` if the pool is empty or disabled.
    ///
    /// The caller should kill the returned worker and spawn a
    /// real game worker in its place. The pool refill happens
    /// asynchronously.
    pub async fn try_checkout(&self) -> Option<SpawnedWorker> {
        if !self.config.enabled {
            return None;
        }

        let mut idle = self.idle.lock().await;
        let worker = idle.pop()?;

        let pool_id = worker.game_id.clone();
        tracing::info!("[POOL] checked out {pool_id} — refilling");

        // Refill in background
        let target = self.config.size;
        let idle_arc = self.idle.clone();
        let worker_bin = self.worker_bin.clone();
        tokio::spawn(async move {
            let current = idle_arc.lock().await.len();
            if current < target {
                let to_spawn = target - current;
                for i in 0..to_spawn {
                    let pool_id = format!("pool-refill-{}", i);
                    match spawn_worker(
                        &pool_id,
                        worker_bin.as_deref(),
                        None, None, None, None,
                    )
                    .await
                    {
                        Ok(w) => {
                            tracing::info!("[POOL] refill worker {pool_id} ready at {}", w.url);
                            idle_arc.lock().await.push(w);
                        }
                        Err(e) => {
                            tracing::error!("[POOL] refill spawn failed: {e}");
                        }
                    }
                }
            }
        });

        Some(worker)
    }

    /// Kill all idle pool workers (shutdown cleanup).
    pub async fn drain(&self) {
        let mut idle = self.idle.lock().await;
        while let Some(worker) = idle.pop() {
            tracing::info!("[POOL] draining {}", worker.game_id);
            worker.kill().await;
        }
    }
}
