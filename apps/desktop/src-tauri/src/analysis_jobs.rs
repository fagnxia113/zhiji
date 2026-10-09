use std::{collections::HashMap, sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, Mutex}, time::{Duration, Instant}};

/// Keep the request count bounded and return results in transcript order.
/// A failure stops new work; already running requests finish so their results can be reused.
pub fn ordered_parallel_map<T: Send, F: Fn(usize) -> Result<T, String> + Sync>(
    count: usize, concurrency: usize, run: F,
) -> Result<Vec<T>, String> {
    let next = AtomicUsize::new(0);
    let failed = AtomicBool::new(false);
    let results = Mutex::new((0..count).map(|_| None).collect::<Vec<Option<Result<T, String>>>>());
    std::thread::scope(|scope| {
        for _ in 0..concurrency.max(1).min(count) {
            let run = &run;
            let next = &next;
            let failed = &failed;
            let results = &results;
            scope.spawn(move || loop {
                if failed.load(Ordering::SeqCst) { break; }
                let index = next.fetch_add(1, Ordering::SeqCst);
                if index >= count { break; }
                let result = run(index);
                if result.is_err() { failed.store(true, Ordering::SeqCst); }
                results.lock().unwrap()[index] = Some(result);
            });
        }
    });
    let results = results.into_inner().map_err(|_| "纪要任务中断，请重试".to_string())?;
    if let Some(error) = results.iter().filter_map(|r| r.as_ref()).find_map(|r| r.as_ref().err()) {
        return Err(error.clone());
    }
    results.into_iter().map(|r| r.ok_or_else(|| "纪要任务中断，请重试".to_string())?).collect()
}

/// Only unfinished jobs retain successful parts. Nothing is written to disk.
pub struct RetryCache<T> { entries: HashMap<u64, (Instant, T)> }

impl<T: Clone> RetryCache<T> {
    pub fn new() -> Self { Self { entries: HashMap::new() } }
    pub fn get(&mut self, key: u64) -> Option<T> {
        self.entries.retain(|_, (at, _)| at.elapsed() < Duration::from_secs(1800));
        self.entries.get(&key).map(|(_, value)| value.clone())
    }
    pub fn insert(&mut self, key: u64, value: T) {
        if self.entries.len() >= 64 && !self.entries.contains_key(&key) {
            if let Some(oldest) = self.entries.iter().min_by_key(|(_, (at, _))| *at).map(|(key, _)| *key) {
                self.entries.remove(&oldest);
            }
        }
        self.entries.insert(key, (Instant::now(), value));
    }
    pub fn remove(&mut self, keys: &[u64]) { for key in keys { self.entries.remove(key); } }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn concurrency_is_bounded_and_slow_parts_keep_their_order() {
        let active = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let barrier = std::sync::Barrier::new(2);
        let values = ordered_parallel_map(6, 2, |index| {
            let current = active.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(current, Ordering::SeqCst);
            if index < 2 { barrier.wait(); }
            if index == 0 { std::thread::sleep(Duration::from_millis(10)); }
            active.fetch_sub(1, Ordering::SeqCst);
            Ok(index)
        }).unwrap();
        assert_eq!(peak.load(Ordering::SeqCst), 2);
        assert_eq!(values, vec![0, 1, 2, 3, 4, 5]);
    }
    #[test]
    fn failure_stops_new_requests_and_successful_parts_survive_retry() {
        let cache = Mutex::new(RetryCache::new());
        assert!(ordered_parallel_map(5, 1, |index| {
            if index == 2 { return Err("failed".to_string()); }
            cache.lock().unwrap().insert(index as u64, index);
            Ok(index)
        }).is_err());
        let calls = AtomicUsize::new(0);
        let result = ordered_parallel_map(5, 2, |index| {
            if let Some(value) = cache.lock().unwrap().get(index as u64) { return Ok(value); }
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(index)
        }).unwrap();
        assert_eq!(result, vec![0, 1, 2, 3, 4]);
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        cache.lock().unwrap().remove(&[0, 1]);
        assert!(cache.lock().unwrap().get(0).is_none());
    }
}
