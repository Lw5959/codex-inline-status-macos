"""Completed-turn throughput regressions; synthetic data only."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from turn_elapsed_meter import TurnElapsedMeter
from codex_status_backend import StatusReader
from test_status_backend import event, append, fixture_root, add_thread, EPOCH
from test_status_backend import start, response


def begin(ident="a", at=0):
    return event(at, "event_msg", {"type": "task_started", "turn_id": ident,
                                   "started_at": EPOCH + int(at)})


def usage(ident="a", response="r", at=4, tokens=100, total=100, thread="main"):
    payload = {"thread_id": thread, "turn_id": ident, "response_id": response,
               "usage": {"output_tokens": tokens, "reasoning_output_tokens": tokens}}
    if total is not None:
        payload["turn_token_usage"] = {"output_tokens": total}
    return event(at, "token_usage_record", payload)


def end(ident="a", at=10, start=0, duration=10000):
    payload = {"type": "task_complete", "turn_id": ident,
               "started_at": EPOCH + int(start), "completed_at": EPOCH + int(at)}
    if duration is not None:
        payload["duration_ms"] = duration
    return event(at, "event_msg", payload)


def feed(meter, records):
    for record in records:
        meter.feed(record)
    return meter.summary()


class TurnElapsedTests(unittest.TestCase):
    def test_full_turn_weighting_and_duplicate_no_reasoning_double_add(self):
        m = TurnElapsedMeter()
        result = feed(m, [begin(), usage(tokens=40, total=40),
                          usage(response="r2", at=8, tokens=60, total=100),
                          usage(response="r2", at=8, tokens=60, total=100), end(),
                          begin("b", 11), usage("b", "r3", 15, 300, 300),
                          end("b", 31, 11, 20000)])
        self.assertEqual(result["measured_samples"], 2)
        self.assertEqual(result["measured_tokens"], 400)
        self.assertEqual(result["measured_seconds"], 30)
        self.assertEqual(result["tps"], 400 / 30)
        self.assertEqual(result["measurement_method"], "turn_elapsed")

    def test_missing_start_end_tokens_zero_and_invalid_counters(self):
        cases = [
            [usage(), end()], [begin(), usage()], [begin(), end()],
            [begin(), usage(tokens=-1, total=-1), end()],
            [begin(), usage(tokens=True, total=1), end()],
            [begin(), usage(tokens=2**64, total=2**64), end()],
            [begin(), usage(total=101), end()],
            [begin(), usage(), end(at=0, duration=0)],
        ]
        for records in cases:
            with self.subTest(records=records):
                self.assertIsNone(feed(TurnElapsedMeter(), records)["tps"])
        result = feed(TurnElapsedMeter(), [begin(), usage(tokens=0, total=0), end()])
        self.assertEqual(result["tps"], 0)
        self.assertEqual(result["measured_samples"], 1)

    def test_duplicate_conflict_withdraws_completed_turn(self):
        m = TurnElapsedMeter()
        self.assertEqual(feed(m, [begin(), usage(), end()])["tps"], 10)
        self.assertIsNone(feed(m, [usage(tokens=101, total=101)])["tps"])
        m = TurnElapsedMeter()
        feed(m, [begin(), usage(), end()])
        changed = end()
        changed["payload"]["duration_ms"] = 9999
        self.assertIsNone(feed(m, [changed])["tps"])

    def test_cross_turn_response_id_conflict_invalidates_both(self):
        m = TurnElapsedMeter()
        feed(m, [begin(), usage(), end()])
        result = feed(m, [begin("b", 11), usage("b", "r", 12), end("b", 21, 11)])
        self.assertIsNone(result["tps"])

    def test_no_cumulative_uses_unique_response_sum(self):
        result = feed(TurnElapsedMeter(), [begin(), usage(total=None),
                      usage(response="r2", at=7, tokens=50, total=None), end()])
        self.assertEqual(result["tps"], 15)

    def test_duration_fallback_and_boundary_conflict(self):
        for duration in (None, 12345):
            with self.subTest(duration=duration):
                result = feed(TurnElapsedMeter(), [begin(), usage(), end(duration=duration)])
                self.assertEqual(result["measured_seconds"], 10)
        for key, value in (("started_at", EPOCH + 1), ("completed_at", EPOCH + 11),
                           ("duration_ms", -1), ("duration_ms", float("nan"))):
            bad = end()
            bad["payload"][key] = value
            self.assertIsNone(feed(TurnElapsedMeter(), [begin(), usage(), bad])["tps"])

    def test_gap_only_withdraws_open_turn_and_reset_clears(self):
        m = TurnElapsedMeter()
        feed(m, [begin(), usage(), end(), begin("b", 11), usage("b", "r2", 12)])
        m.damage()
        self.assertEqual(feed(m, [end("b", 21, 11)])["measured_samples"], 1)
        m.reset()
        self.assertIsNone(m.summary()["tps"])

    def test_limits_bound_both_turn_and_response_evidence(self):
        m = TurnElapsedMeter(2)
        for n in range(4):
            feed(m, [begin(str(n), n*20), usage(str(n), str(n), n*20+1),
                     end(str(n), n*20+10, n*20)])
        self.assertEqual(len(m.turns), 2)
        self.assertEqual(len(m.responses), 2)
        self.assertTrue(m.summary()["samples_limited"])
        m = TurnElapsedMeter(2)
        result = feed(m, [begin(), usage(response="1", total=100),
                          usage(response="2", at=5, total=200),
                          usage(response="3", at=6, total=300), end()])
        self.assertEqual(len(m.responses), 2)
        self.assertEqual(len(m.turns["a"].responses), 2)
        self.assertIsNone(result["tps"])
        self.assertTrue(result["samples_limited"])

    def test_reader_completed_turns_only_and_no_item_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, state = fixture_root(root)
            path = add_thread(state, source)
            state.close()
            append(path, [begin(), usage(), end()])
            reader = StatusReader(root, "main")
            result = reader.poll_summary()
            self.assertEqual(result["tps"], 10)
            self.assertEqual(result["measured_samples"], 1)
            self.assertIsNone(result["issue"])
            append(path, [begin("b", 11), usage("b", "r2", 12)])
            self.assertEqual(reader.poll_summary()["tps"], 10)
            append(path, [end("b", 31, 11, 20000)])
            self.assertEqual(reader.poll_summary()["tps"], 200 / 30)
            path.write_text("", encoding="utf-8")
            self.assertIsNone(reader.poll_summary()["tps"])

    def test_reader_gap_ownership_and_missing_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, state = fixture_root(root)
            path = add_thread(state, source)
            state.close()
            append(path, [begin(), usage(thread="foreign"), end()])
            reader = StatusReader(root, "main")
            self.assertIsNone(reader.poll_summary()["tps"])
            append(path, [begin("b", 11), usage("b", "r2", 12)])
            with path.open("a", encoding="utf-8") as stream:
                stream.write("corrupt-record\n")
            append(path, [end("b", 21, 11)])
            self.assertIsNone(reader.poll_summary()["tps"])
            append(path, [begin("c", 22), usage("c", "r3", 23), end("c", 32, 22)])
            self.assertEqual(reader.poll_summary()["tps"], 10)
            path.unlink()
            self.assertIsNone(reader.poll_summary()["tps"])

    def test_reader_has_no_legacy_item_fallback_and_needs_no_logs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, state = fixture_root(root)
            path = add_thread(state, source)
            state.close()
            append(path, start() + response())
            reader = StatusReader(root, "main")
            self.assertEqual(reader.poll()["tps"], 50)
            self.assertIsNone(reader.poll_summary()["tps"])
            append(path, [begin("verified", 20), usage("verified", "r2", 21),
                          end("verified", 30, 20)])
            (root / "logs_2.sqlite").unlink()
            result = reader.poll_summary()
            self.assertEqual(result["tps"], 10)
            self.assertIsNone(result["issue"])

    def test_fractional_milliseconds_and_completed_replay(self):
        m = TurnElapsedMeter()
        records = [begin(at=.886), usage(at=2), end(at=92.884, duration=91998)]
        result = feed(m, records)
        self.assertEqual(result["measured_seconds"], 91.998)
        self.assertEqual(feed(m, records)["measured_samples"], 1)
        bad_start = begin(at=.886)
        bad_start["payload"]["started_at"] += 1
        self.assertIsNone(feed(m, [bad_start])["tps"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
