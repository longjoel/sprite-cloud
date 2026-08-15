//! Bounded, non-secret host telemetry for the authenticated server heartbeat.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PressureLevel {
    Normal,
    Elevated,
    Critical,
}

#[derive(Debug, Clone, Copy)]
struct CpuSample {
    total: u64,
    idle: u64,
}

#[derive(Debug, Clone, Copy)]
struct MemorySample {
    total_bytes: u64,
    available_bytes: u64,
    used_bytes: u64,
    used_percent: f64,
}

#[derive(Debug, Serialize, Clone)]
pub struct HostTelemetry {
    pub cpu_percent: f64,
    pub memory_total_bytes: u64,
    pub memory_available_bytes: u64,
    pub memory_used_bytes: u64,
    pub memory_used_percent: f64,
    pub uptime_seconds: u64,
    pub active_session_count: usize,
}

#[derive(Debug, Default)]
pub struct HostTelemetrySampler {
    previous_cpu: Option<CpuSample>,
}

impl HostTelemetrySampler {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn sample(&mut self, active_session_count: usize) -> HostTelemetry {
        let current_cpu = std::fs::read_to_string("/proc/stat").ok().and_then(|body| {
            body.lines()
                .find(|line| line.starts_with("cpu "))
                .and_then(parse_cpu_stat)
        });
        let cpu_percent = current_cpu
            .zip(self.previous_cpu)
            .map(|(current, previous)| {
                let total_delta = current.total.saturating_sub(previous.total);
                let idle_delta = current.idle.saturating_sub(previous.idle);
                if total_delta == 0 {
                    0.0
                } else {
                    ((total_delta.saturating_sub(idle_delta) as f64 / total_delta as f64) * 100.0)
                        .clamp(0.0, 100.0)
                }
            })
            .unwrap_or(0.0);
        self.previous_cpu = current_cpu;

        let memory = std::fs::read_to_string("/proc/meminfo")
            .ok()
            .and_then(|body| parse_meminfo(&body))
            .unwrap_or(MemorySample {
                total_bytes: 0,
                available_bytes: 0,
                used_bytes: 0,
                used_percent: 0.0,
            });
        let uptime_seconds = std::fs::read_to_string("/proc/uptime")
            .ok()
            .and_then(|value| value.split_whitespace().next()?.parse::<f64>().ok())
            .map(|value| value.max(0.0) as u64)
            .unwrap_or(0);

        HostTelemetry {
            cpu_percent,
            memory_total_bytes: memory.total_bytes,
            memory_available_bytes: memory.available_bytes,
            memory_used_bytes: memory.used_bytes,
            memory_used_percent: memory.used_percent,
            uptime_seconds,
            active_session_count,
        }
    }
}

fn parse_cpu_stat(line: &str) -> Option<CpuSample> {
    let mut values = line.split_whitespace();
    if values.next()? != "cpu" {
        return None;
    }
    let numbers = values
        .take(8)
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    if numbers.len() < 4 {
        return None;
    }
    Some(CpuSample {
        total: numbers.iter().sum(),
        idle: numbers[3].saturating_add(*numbers.get(4).unwrap_or(&0)),
    })
}

fn parse_meminfo(body: &str) -> Option<MemorySample> {
    let mut total_kb = None;
    let mut available_kb = None;
    for line in body.lines() {
        let (name, value) = line.split_once(':')?;
        let value = value.split_whitespace().next()?.parse::<u64>().ok()?;
        match name {
            "MemTotal" => total_kb = Some(value),
            "MemAvailable" => available_kb = Some(value),
            _ => {}
        }
    }
    let total_bytes = total_kb?.saturating_mul(1024);
    let available_bytes = available_kb?.saturating_mul(1024).min(total_bytes);
    let used_bytes = total_bytes.saturating_sub(available_bytes);
    let used_percent = if total_bytes == 0 {
        0.0
    } else {
        (used_bytes as f64 / total_bytes as f64) * 100.0
    };
    Some(MemorySample {
        total_bytes,
        available_bytes,
        used_bytes,
        used_percent,
    })
}

fn pressure_level(cpu_percent: f64, memory_percent: f64) -> PressureLevel {
    let peak = cpu_percent.max(memory_percent);
    if peak >= 90.0 {
        PressureLevel::Critical
    } else if peak >= 75.0 {
        PressureLevel::Elevated
    } else {
        PressureLevel::Normal
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_linux_memory_info_without_exposing_raw_lines() {
        let memory = parse_meminfo("MemTotal:       1000 kB\nMemAvailable:    250 kB\n").unwrap();

        assert_eq!(memory.total_bytes, 1_024_000);
        assert_eq!(memory.available_bytes, 256_000);
        assert_eq!(memory.used_bytes, 768_000);
        assert!((memory.used_percent - 75.0).abs() < f64::EPSILON);
    }

    #[test]
    fn parses_cpu_totals_and_idle_time() {
        let sample = parse_cpu_stat("cpu  100 20 30 400 10 5 6 2 0 0").unwrap();

        assert_eq!(sample.total, 573);
        assert_eq!(sample.idle, 410);
    }

    #[test]
    fn pressure_is_critical_at_ninety_percent() {
        assert_eq!(pressure_level(89.9, 89.9), PressureLevel::Elevated);
        assert_eq!(pressure_level(90.0, 10.0), PressureLevel::Critical);
        assert_eq!(pressure_level(10.0, 90.0), PressureLevel::Critical);
    }
}
