//! Lightweight process-memory probe for diagnosing the resident footprint of the
//! in-process speech engines. `log_rss(label)` prints the current working set (RSS,
//! the physical memory resident in RAM) and the private commit. Called at three points
//! (baseline at startup, after Whisper loads, after Kokoro loads), the log charts the
//! co-resident cost of running both engines in one process, so a decision about
//! unloading an idle engine can be made from real numbers instead of estimates.
//!
//! Windows is the shipping target; a `/proc/self/statm` fallback keeps it compiling
//! (and roughly useful) on Linux/CI.

/// `(working_set_bytes, private_bytes)` for the current process, or `None` if the
/// platform query fails. Working set is the headline "resident footprint".
#[cfg(windows)]
pub fn process_mem_bytes() -> Option<(u64, u64)> {
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX};
    use windows::Win32::System::Threading::GetCurrentProcess;

    unsafe {
        let mut counters = PROCESS_MEMORY_COUNTERS_EX {
            cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
            ..Default::default()
        };
        // PROCESS_MEMORY_COUNTERS_EX is layout-compatible with PROCESS_MEMORY_COUNTERS
        // (it appends PrivateUsage); GetProcessMemoryInfo fills `cb` bytes, so the EX
        // fields below are populated. GetCurrentProcess returns a pseudo-handle (no close).
        GetProcessMemoryInfo(GetCurrentProcess(), &mut counters as *mut _ as *mut _, counters.cb)
            .ok()?;
        Some((counters.WorkingSetSize as u64, counters.PrivateUsage as u64))
    }
}

/// Linux/CI fallback: RSS pages from `/proc/self/statm` (field 1) times the page size.
/// No direct private-commit equivalent, so the second value is 0.
#[cfg(not(windows))]
pub fn process_mem_bytes() -> Option<(u64, u64)> {
    let statm = std::fs::read_to_string("/proc/self/statm").ok()?;
    let rss_pages: u64 = statm.split_whitespace().nth(1)?.parse().ok()?;
    Some((rss_pages * 4096, 0))
}

/// Log the current resident set + private commit (in MB) under `label`. Cheap; used to
/// chart the speech-engine footprint at `baseline` / `whisper_loaded` / `kokoro_loaded`.
pub fn log_rss(label: &str) {
    if let Some((working_set, private)) = process_mem_bytes() {
        log::info!("[rss] {label}: ws={} MB priv={} MB", working_set >> 20, private >> 20);
    }
}
