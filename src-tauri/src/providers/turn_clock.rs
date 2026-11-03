//! Work time per turn, read from a transcript in file order.
//!
//! A turn runs from the prompt that starts it to the reply that ends it, and
//! its time is booked on the call that ended it — so it lands in that call's
//! project, model and day. A turn still running when the log was read has no
//! end yet and books nothing; it is counted once the agent finishes and the
//! log is read again.
//!
//! A session closed mid-turn never logs an end. Once its log has been silent
//! for [`ABANDONED_AFTER_MS`], the open turn counts as over at its last call —
//! see [`TurnClock::pending`]. Should the session come back, the log changes,
//! is read again, and the turn is timed in full.
//!
//! Each method that closes a turn returns `(entry index, milliseconds)` for the
//! caller to store; an entry closes at most one turn, so the value replaces
//! rather than adds.

/// How long a log must sit untouched before its open turn counts as abandoned.
/// A working agent writes every call and tool result, so half an hour of
/// silence means the session is gone, not busy.
pub const ABANDONED_AFTER_MS: f64 = 30.0 * 60.0 * 1000.0;

/// An unfinished turn at the end of a log that has been silent long enough.
pub fn abandoned_turn(open_turn: Option<(usize, f64)>, log_mtime_ms: f64, now_ms: f64) -> Option<(usize, f64)> {
    open_turn.filter(|_| now_ms - log_mtime_ms >= ABANDONED_AFTER_MS)
}

#[derive(Default)]
pub struct TurnClock {
    /// When the open turn began: its prompt, or its first call if the log
    /// starts mid-turn (a resumed or truncated transcript).
    start_ms: Option<f64>,
    /// Newest call of the open turn: entry index and time.
    last_call: Option<(usize, f64)>,
    /// The entry that closed the previous turn, until the next prompt — so a
    /// duration the agent reports after finishing can still correct it.
    closed: Option<usize>,
}

impl TurnClock {
    /// A new prompt. A turn still open here was interrupted: it ends at its
    /// last call, which is the last moment the log shows it working.
    pub fn prompt(&mut self, at_ms: f64) -> Option<(usize, f64)> {
        let interrupted = self.last_call.map(|(_, last)| self.close(last));
        self.start_ms = Some(at_ms);
        self.closed = None;
        interrupted.flatten()
    }

    /// A call made inside the current turn.
    pub fn call(&mut self, index: usize, at_ms: f64) {
        self.start_ms.get_or_insert(at_ms);
        self.last_call = Some((index, at_ms));
    }

    /// The agent finished (or the turn was aborted) at `at_ms`.
    pub fn finish(&mut self, at_ms: f64) -> Option<(usize, f64)> {
        self.close(at_ms)
    }

    /// The agent's own measure of the turn it just ran, when the log has one.
    pub fn reported(&mut self, duration_ms: f64) -> Option<(usize, f64)> {
        if !(duration_ms.is_finite() && duration_ms >= 0.0) {
            return None;
        }
        if let Some((index, _)) = self.last_call {
            self.reset();
            self.closed = Some(index);
            return Some((index, duration_ms));
        }
        self.closed.take().map(|index| (index, duration_ms))
    }

    /// The turn still open when the log ends, as it would close at its last
    /// call: `(entry index, milliseconds)`. Not booked unless the log goes
    /// quiet — see [`abandoned_turn`].
    pub fn pending(&self) -> Option<(usize, f64)> {
        match (self.start_ms, self.last_call) {
            (Some(start), Some((index, last))) => Some((index, (last - start).max(0.0))),
            _ => None,
        }
    }

    fn close(&mut self, end_ms: f64) -> Option<(usize, f64)> {
        let result = match (self.start_ms, self.last_call) {
            (Some(start), Some((index, _))) => {
                self.closed = Some(index);
                Some((index, (end_ms - start).max(0.0)))
            }
            _ => None,
        };
        self.reset();
        result
    }

    fn reset(&mut self) {
        self.start_ms = None;
        self.last_call = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_turn_runs_from_prompt_to_final_reply() {
        let mut t = TurnClock::default();
        assert_eq!(t.prompt(1_000.0), None);
        t.call(0, 5_000.0);
        t.call(1, 9_000.0);
        assert_eq!(t.finish(9_000.0), Some((1, 8_000.0)));
    }

    #[test]
    fn an_interrupted_turn_ends_at_its_last_call() {
        let mut t = TurnClock::default();
        t.prompt(0.0);
        t.call(0, 2_000.0);
        t.call(1, 3_000.0);
        assert_eq!(t.prompt(60_000.0), Some((1, 3_000.0)));
    }

    #[test]
    fn a_reported_duration_replaces_the_measured_one() {
        let mut t = TurnClock::default();
        t.prompt(0.0);
        t.call(0, 4_000.0);
        assert_eq!(t.finish(4_000.0), Some((0, 4_000.0)));
        assert_eq!(t.reported(4_250.0), Some((0, 4_250.0)));
        // only once, and never across a new prompt
        assert_eq!(t.reported(9_999.0), None);
    }

    #[test]
    fn a_turn_without_calls_books_nothing() {
        let mut t = TurnClock::default();
        t.prompt(0.0);
        assert_eq!(t.finish(10_000.0), None);
        assert_eq!(t.prompt(20_000.0), None);
    }

    #[test]
    fn an_open_turn_counts_only_once_its_log_goes_quiet() {
        let mut t = TurnClock::default();
        t.prompt(0.0);
        t.call(0, 1_000.0);
        t.call(1, 90_000.0);
        let open = t.pending();
        assert_eq!(open, Some((1, 90_000.0)));
        let mtime = 90_000.0;
        assert_eq!(abandoned_turn(open, mtime, mtime + 60_000.0), None); // still running
        assert_eq!(abandoned_turn(open, mtime, mtime + ABANDONED_AFTER_MS), open); // closed
    }

    #[test]
    fn a_log_that_starts_mid_turn_counts_from_its_first_call() {
        let mut t = TurnClock::default();
        t.call(0, 10_000.0);
        t.call(1, 25_000.0);
        assert_eq!(t.finish(25_000.0), Some((1, 15_000.0)));
    }
}
