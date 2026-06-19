use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static LAST_USE_MS: AtomicU64 = AtomicU64::new(0);
static WANTED_MS: AtomicU64 = AtomicU64::new(0);
static LLAMA_UP: AtomicBool = AtomicBool::new(false);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Records that the bind phase attempted to use llama-server.
pub fn record_llama_use() {
    LAST_USE_MS.store(now_ms(), Ordering::Relaxed);
}

/// Records that llama-server was wanted but not yet healthy.
pub fn record_llama_wanted() {
    WANTED_MS.store(now_ms(), Ordering::Relaxed);
}

/// Updates whether llama-server responded healthy on the last probe.
pub fn mark_llama_up(up: bool) {
    LLAMA_UP.store(up, Ordering::Relaxed);
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySnapshot {
    pub last_use_ms: u64,
    pub wanted_ms: u64,
    pub now_ms: u64,
    pub up: bool,
}

/// Returns current llama activity timestamps for the extension lifecycle manager.
pub fn snapshot() -> ActivitySnapshot {
    ActivitySnapshot {
        last_use_ms: LAST_USE_MS.load(Ordering::Relaxed),
        wanted_ms: WANTED_MS.load(Ordering::Relaxed),
        now_ms: now_ms(),
        up: LLAMA_UP.load(Ordering::Relaxed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_use_and_wanted_update_snapshots() {
        record_llama_use();
        let snap = snapshot();
        assert!(snap.last_use_ms > 0);
        record_llama_wanted();
        let snap2 = snapshot();
        assert!(snap2.wanted_ms > 0);
        assert!(snap2.wanted_ms >= snap.wanted_ms);
    }

    #[test]
    fn mark_llama_up_reflects_in_snapshot() {
        mark_llama_up(true);
        assert!(snapshot().up);
        mark_llama_up(false);
        assert!(!snapshot().up);
    }
}
