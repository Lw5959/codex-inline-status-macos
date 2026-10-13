"""Legacy response-timing API and cache regressions; synthetic data only.

Completed-turn UI metrics are tested separately in test_turn_elapsed.py.
"""
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from codex_status_backend import StatusReader
import codex_status_backend


EPOCH = 1767225600


def event(second, kind, payload):
    return {"type": kind, "timestamp": datetime.fromtimestamp(
        EPOCH + second, timezone.utc).isoformat(), "payload": payload}


def append(path, records):
    with path.open("a", encoding="utf-8") as stream:
        for record in records:
            stream.write(json.dumps(record) + "\n")


def fixture_root(tmp_path):
    source = tmp_path / "sessions"
    source.mkdir()
    state = sqlite3.connect(tmp_path / "state_5.sqlite")
    state.executescript("""
        CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT,
            model TEXT, reasoning_effort TEXT, model_provider TEXT,
            archived INTEGER, updated_at INTEGER);
        CREATE INDEX idx_threads_updated_at ON threads(updated_at DESC, id DESC);
        CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT);
    """)
    logs = sqlite3.connect(tmp_path / "logs_2.sqlite")
    logs.executescript("""
        CREATE TABLE logs(id INTEGER PRIMARY KEY,ts INTEGER,ts_nanos INTEGER,
            target TEXT,feedback_log_body TEXT,thread_id TEXT);
        CREATE INDEX idx_logs_thread_id ON logs(thread_id);
    """)
    logs.close()
    return source, state


def add_thread(state, source, ident="main", updated=10):
    path = source / (ident + ".jsonl")
    path.touch()
    append(path, [event(0, "session_meta", {"id": ident})])
    state.execute("INSERT INTO threads VALUES(?,?,?,?,?,?,?,?)",
                  (ident, str(path), ident, "test-model", "high", "test", 0, updated))
    state.commit()
    return path


def start():
    return [event(0, "event_msg", {"type": "task_started", "turn_id": "turn"}),
            event(0, "turn_context", {"turn_id": "turn", "model": "test-model"})]


def response(item="item", response="response", second=12, tokens=100):
    return [
        event(second, "response_item", {"type": "message", "id": item,
                                       "role": "assistant", "content": []}),
        event(second, "event_msg", {"type": "item_completed", "thread_id": "main",
              "turn_id": "turn", "item": {"type": "AgentMessage", "id": item},
              "started_at_ms": (EPOCH+second-2)*1000,
              "completed_at_ms": (EPOCH+second)*1000}),
        event(second+1, "token_usage_record", {"thread_id": "main", "turn_id": "turn",
              "response_id": response, "usage": {"output_tokens": tokens}}),
    ]


def usage(input_tokens=None, cached_tokens=None, window=None):
    values = {}
    if input_tokens is not None:
        values["input_tokens"] = input_tokens
    if cached_tokens is not None:
        values["cached_input_tokens"] = cached_tokens
    info = {"last_token_usage": values}
    if window is not None:
        info["model_context_window"] = window
    return event(20, "event_msg", {"type": "token_count", "info": info})


CACHE_CASES = [
    (100, 25, 1000, .25, .1),
    (100, 0, 1000, 0.0, .1),
    (0, 0, 1000, None, 0.0),
    (100, 25, 0, .25, None),
    (None, None, None, None, None),
    (100, None, 1000, None, .1),
    (2000, 3000, 1000, 1.0, 1.0),
]


def check_cache_context_missing_and_zero(tmp_path, inputs, cached, window, cache, context):
    source, state = fixture_root(tmp_path)
    path = add_thread(state, source)
    state.close()
    append(path, start() + [usage(inputs, cached, window)])
    result = StatusReader(tmp_path, "main").poll()
    assert result["cache_hit"] == cache
    assert result["context_used"] == context
    json.dumps(result, allow_nan=False)


def check_latest_excluded_response_never_reuses_prior_speed(tmp_path):
    source, state = fixture_root(tmp_path)
    path = add_thread(state, source)
    state.close()
    append(path, start() + response())
    reader = StatusReader(tmp_path, "main")
    first = reader.poll()
    assert first["tps"] == 50
    assert first["seconds"] == 2
    append(path, [event(30, "response_item", {"type": "custom_tool_call",
          "id": "tool-item", "call_id": "call"}),
          event(31, "token_usage_record", {"thread_id": "main", "turn_id": "turn",
          "response_id": "tool-response", "usage": {"output_tokens": 10}})])
    second = reader.poll()
    assert second["tps"] is None
    assert second["tokens"] == 10
    assert second["issue"] == "unconfirmed_tool_start"
    assert second["tps_at"] > first["tps_at"]


def check_missing_latest_boundary_does_not_reuse_prior_speed(tmp_path):
    source, state = fixture_root(tmp_path)
    path = add_thread(state, source)
    state.close()
    append(path, start() + response())
    reader = StatusReader(tmp_path, "main")
    assert reader.poll()["tps"] == 50
    append(path, [event(31, "token_usage_record", {"thread_id": "main", "turn_id": "turn",
          "response_id": "missing-items", "usage": {"output_tokens": 17}})])
    result = reader.poll()
    assert result["tps"] is None
    assert result["tokens"] == 17
    assert result["issue"] == "missing_output_boundary"


def check_auto_selection_excludes_child_and_switches(tmp_path):
    source, state = fixture_root(tmp_path)
    add_thread(state, source, "older", 10)
    add_thread(state, source, "main", 20)
    add_thread(state, source, "child", 30)
    state.execute("INSERT INTO thread_spawn_edges VALUES('main','child')")
    state.commit()
    reader = StatusReader(tmp_path)
    assert [row["id"] for row in reader.list_threads()] == ["main", "older"]
    assert reader.poll()["thread_id"] == "main"
    assert reader.poll()["selection_mode"] == "auto"
    reader.select("older")
    assert reader.poll()["thread_id"] == "older"
    assert reader.poll()["selection_mode"] == "fixed"
    reader.select(None)
    state.execute("UPDATE threads SET updated_at=40 WHERE id='older'")
    state.commit()
    assert reader.poll()["thread_id"] == "older"
    state.close()


def check_rollout_truncation_clears_previous_measurement(tmp_path):
    source, state = fixture_root(tmp_path)
    path = add_thread(state, source)
    state.close()
    append(path, start() + response())
    reader = StatusReader(tmp_path, "main")
    assert reader.poll()["tps"] == 50
    path.write_text("", encoding="utf-8")
    result = reader.poll()
    assert result["tps"] is None
    assert result["tokens"] is None


def check_logs_are_read_from_selected_thread_with_exact_item_ids(tmp_path):
    source, state = fixture_root(tmp_path)
    path = add_thread(state, source)
    state.close()
    records = response()
    append(path, start() + [records[0], records[2]])
    prefix = "session_loop{thread_id=main}:turn{turn.id=turn}:try_run_sampling_request: "
    connection = sqlite3.connect(tmp_path / "logs_2.sqlite")
    connection.execute("INSERT INTO logs VALUES(?,?,?,?,?,?)", (1, EPOCH+10, 0,
                       "codex_core::stream_events_utils",
                       prefix+'Output item item_type="message" item_id="item"', "main"))
    connection.execute("INSERT INTO logs VALUES(?,?,?,?,?,?)", (2, EPOCH+11, 0,
                       "codex_core::stream_events_utils",
                       prefix+'Output item item_type="message" item_id="item"', "other"))
    connection.commit()
    connection.close()
    result = StatusReader(tmp_path, "main").poll()
    assert result["tps"] == 50
    assert result["seconds"] == 2


def check_replaced_log_database_drops_stale_start_evidence(tmp_path):
    source, state = fixture_root(tmp_path)
    path = add_thread(state, source)
    state.close()
    records = response()
    append(path, start() + [records[0], records[2]])
    original = tmp_path / "logs_2.sqlite"
    connection = sqlite3.connect(original)
    connection.execute("INSERT INTO logs VALUES(?,?,?,?,?,?)", (1, EPOCH+10, 0,
        "codex_core::stream_events_utils", 'turn{turn.id=turn}: '
        'Output item item_type="message" item_id="item"', "main"))
    connection.commit()
    connection.close()
    reader = StatusReader(tmp_path, "main")
    assert reader.poll()["tps"] == 50
    replacement = tmp_path / "replacement.sqlite"
    connection = sqlite3.connect(replacement)
    connection.executescript("""
        CREATE TABLE logs(id INTEGER PRIMARY KEY,ts INTEGER,ts_nanos INTEGER,
            target TEXT,feedback_log_body TEXT,thread_id TEXT);
        CREATE INDEX idx_logs_thread_id ON logs(thread_id);
    """)
    connection.close()
    os.replace(replacement, original)
    result = reader.poll()
    assert result["tps"] is None
    assert result["issue"] == "missing_start"


def check_windows_extended_path(tmp_path):
    source, state = fixture_root(tmp_path)
    path = add_thread(state, source)
    extended_path = "\\\\?\\" + str(path.resolve())
    state.execute("UPDATE threads SET rollout_path=? WHERE id='main'", (extended_path,))
    state.commit()
    state.close()
    append(path, start() + response())
    reader = StatusReader(Path("\\\\?\\" + str(tmp_path.resolve())), "main")
    assert reader.poll()["tps"] == 50


def check_summary_weighted_deduplicated_and_keeps_reliable_samples(tmp_path):
    source, state = fixture_root(tmp_path)
    path = add_thread(state, source)
    state.close()
    second = response("item-2", "response-2", second=22, tokens=300)
    second[1]["payload"]["started_at_ms"] = (EPOCH+19)*1000
    cache = usage(100, 50, 1000)
    cache["timestamp"] = event(24, "event_msg", {})["timestamp"]
    cache["payload"]["info"]["total_token_usage"] = {
        "input_tokens": 400, "cached_input_tokens": 300}
    append(path, start() + response() + second + [cache])
    reader = StatusReader(tmp_path, "main")
    result = reader.poll_response_summary()
    assert result["tps"] == 80  # 400 / 5, not arithmetic mean(50, 100).
    assert result["measured_samples"] == 2
    assert result["measured_tokens"] == 400
    assert result["measured_seconds"] == 5
    assert result["scope"] == "sampled_session"
    assert result["cache_hit"] == .75
    assert result["context_used"] == .1
    assert reader.poll()["cache_hit"] == .5  # Original per-response API unchanged.
    append(path, [event(30, "response_item", {"type": "custom_tool_call",
          "id": "invalid-tool", "call_id": "call"}),
          event(31, "token_usage_record", {"thread_id": "main", "turn_id": "turn",
          "response_id": "invalid-response", "usage": {"output_tokens": 10}})])
    result = reader.poll_response_summary()
    assert result["tps"] == 80
    assert result["measured_samples"] == 2
    assert result["issue"] == "unconfirmed_tool_start"
    assert reader.poll()["tps"] is None
    for _ in range(3):
        assert reader.poll_response_summary()["measured_samples"] == 2


def check_summary_excludes_fork_inheritance_and_other_thread(tmp_path):
    source, state = fixture_root(tmp_path)
    path = add_thread(state, source)
    add_thread(state, source, "other")
    state.close()
    inherited = response("inherited-item", "inherited-response", tokens=900)
    for record in inherited:
        if "thread_id" in record["payload"]:
            record["payload"]["thread_id"] = "parent"
    own_start = [event(20, "session_meta", {"id": "main"}),
                 event(20, "event_msg", {"type": "task_started", "turn_id": "turn"}),
                 event(20, "turn_context", {"turn_id": "turn", "model": "test-model"})]
    append(path, [event(0, "session_meta", {"id": "parent"})] + start() + inherited +
           own_start + response("own-item", "own-response", second=32))
    reader = StatusReader(tmp_path, "main")
    result = reader.poll_response_summary()
    assert result["measured_samples"] == 1
    assert result["measured_tokens"] == 100
    assert result["tps"] == 50
    assert result["cache_hit"] is None
    reader.select("other")
    result = reader.poll_response_summary()
    assert result["measured_samples"] == 0
    assert result["measured_tokens"] == 0
    assert result["tps"] is None


def check_summary_preserves_samples_beyond_parser_deque(tmp_path):
    source, state = fixture_root(tmp_path)
    path = add_thread(state, source)
    state.close()
    records = start()
    for number in range(360):
        records += response(f"item-{number}", f"response-{number}",
                            second=12+3*number, tokens=1)
    append(path, records)
    reader = StatusReader(tmp_path, "main")
    result = reader.poll_response_summary()
    assert result["measured_samples"] == 360
    assert result["measured_tokens"] == 360
    assert result["measured_seconds"] == 720
    assert result["tps"] == .5
    assert reader.poll_response_summary()["measured_samples"] == 360
    path.write_text("", encoding="utf-8")
    assert reader.poll_response_summary()["measured_samples"] == 0


def check_foreign_token_count_rejected_before_parser(tmp_path):
    source, state = fixture_root(tmp_path)
    path = add_thread(state, source)
    state.close()
    records = response()
    foreign = usage(100, 90, 1000)
    foreign["timestamp"] = event(13, "event_msg", {})["timestamp"]
    foreign["payload"]["thread_id"] = "foreign"
    foreign["payload"]["info"]["last_token_usage"]["output_tokens"] = 900
    foreign["payload"]["info"]["total_token_usage"] = {
        "input_tokens": 100, "cached_input_tokens": 90, "output_tokens": 900}
    append(path, start() + records[:2] + [foreign])
    reader = StatusReader(tmp_path, "main")
    result = reader.poll_response_summary()
    assert result["measured_samples"] == 0
    assert result["tps"] is None
    assert result["cache_hit"] is None
    assert result["context_used"] is None
    append(path, [records[2]])
    result = reader.poll_response_summary()
    assert result["measured_samples"] == 1
    assert result["measured_tokens"] == 100
    assert result["tps"] == 50


def check_clipped_fork_prefix_does_not_leak_parent_cache(tmp_path):
    source, state = fixture_root(tmp_path)
    path = add_thread(state, source, "child")
    state.close()
    parent_usage = usage(100, 90, 1000)
    parent_usage["payload"]["info"]["total_token_usage"] = {
        "input_tokens": 10000, "cached_input_tokens": 9000, "output_tokens": 100}
    padding = event(0, "padding", {"filler": "x" * codex_status_backend.INITIAL_BYTES})
    append(path, [event(0, "session_meta", {"id": "parent"}), padding] + start() +
           [parent_usage, event(21, "event_msg", {
               "type": "thread_settings_applied", "thread_id": "child"})])
    reader = StatusReader(tmp_path, "child")
    result = reader.poll_response_summary()
    assert result["measured_samples"] == 0
    assert result["cache_hit"] is None
    assert result["context_used"] is None
    assert result["input_tokens"] is None


def check_owner_switch_clears_ledger_and_cache(tmp_path):
    source, state = fixture_root(tmp_path)
    path = add_thread(state, source)
    state.close()
    cache = usage(100, 50, 1000)
    cache["payload"]["info"]["total_token_usage"] = {
        "input_tokens": 400, "cached_input_tokens": 300}
    append(path, start() + response() + [cache])
    reader = StatusReader(tmp_path, "main")
    assert reader.poll_response_summary()["measured_samples"] == 1
    append(path, [event(25, "session_meta", {"id": "parent"})])
    result = reader.poll_response_summary()
    assert result["issue"] == "inherited_history"
    assert result["measured_samples"] == 0
    assert result["tps"] is None
    assert result["cache_hit"] is None
    append(path, [event(26, "session_meta", {"id": "main"})])
    result = reader.poll_response_summary()
    assert result["measured_samples"] == 0
    assert result["cache_hit"] is None


def check_missing_source_blanks_summary_metrics(tmp_path):
    source, state = fixture_root(tmp_path)
    path = add_thread(state, source)
    state.close()
    cache = usage(100, 50, 1000)
    cache["payload"]["info"]["total_token_usage"] = {
        "input_tokens": 400, "cached_input_tokens": 300}
    append(path, start() + response() + [cache])
    reader = StatusReader(tmp_path, "main")
    assert reader.poll_response_summary()["tps"] == 50
    (tmp_path / "logs_2.sqlite").unlink()
    result = reader.poll_response_summary()
    assert result["issue"] == "logs_unavailable"
    assert result["tps"] is None
    assert result["cache_hit"] is None
    assert result["measured_samples"] == 1
    path.unlink()
    result = reader.poll_response_summary()
    assert result["issue"] == "source_unavailable"
    assert result["tps"] is None
    assert result["cache_hit"] is None


def check_old_token_snapshot_cannot_regress_cache(tmp_path):
    source, state = fixture_root(tmp_path)
    path = add_thread(state, source)
    state.close()
    cache = usage(100, 50, 1000)
    cache["payload"]["info"]["total_token_usage"] = {
        "input_tokens": 400, "cached_input_tokens": 300, "output_tokens": 100}
    append(path, start() + response() + [cache])
    reader = StatusReader(tmp_path, "main")
    assert reader.poll_response_summary()["cache_hit"] == .75
    old = usage(20, 19, 1000)
    old["timestamp"] = event(5, "event_msg", {})["timestamp"]
    old["payload"]["info"]["total_token_usage"] = {
        "input_tokens": 100, "cached_input_tokens": 95, "output_tokens": 100}
    append(path, [old])
    result = reader.poll_response_summary()
    assert result["cache_hit"] == .75
    assert result["context_used"] == .1


def check_sample_store_limit_is_explicit(tmp_path):
    original_limit = codex_status_backend.MAX_SAMPLES
    codex_status_backend.MAX_SAMPLES = 3
    try:
        source, state = fixture_root(tmp_path)
        path = add_thread(state, source)
        state.close()
        records = start()
        for number in range(5):
            records += response(f"limit-item-{number}", f"limit-response-{number}",
                                second=12+3*number, tokens=1)
        append(path, records)
        reader = StatusReader(tmp_path, "main")
        result = reader.poll_response_summary()
        assert result["measured_samples"] == 3
        assert result["samples_limited"] is True
        assert len(reader._sampled) == 3
        assert len(reader._response_evidence) == 3
        assert len(reader._item_samples) == 3
        assert set().union(*reader._item_samples.values()) == set(reader._sampled)
        assert result["measured_tokens"] == 3
        assert reader.poll_response_summary()["measured_samples"] == 3
        path.write_text("", encoding="utf-8")
        result = reader.poll_response_summary()
        assert result["measured_samples"] == 0
        assert result["samples_limited"] is False
        assert reader._response_evidence == {}
        assert reader._item_samples == {}
    finally:
        codex_status_backend.MAX_SAMPLES = original_limit


def check_same_revision_timing_updates_and_ambiguity_withdraws(tmp_path):
    source, state = fixture_root(tmp_path)
    path = add_thread(state, source)
    state.close()
    append(path, start() + response())
    reader = StatusReader(tmp_path, "main")
    assert reader.poll_response_summary()["tps"] == 50

    def log_start(ident, second):
        database = sqlite3.connect(tmp_path / "logs_2.sqlite")
        database.execute("INSERT INTO logs VALUES(?,?,?,?,?,?)", (
            ident, EPOCH+second, 0, "codex_core::stream_events_utils",
            'turn{turn.id=turn}: Output item item_type="message" item_id="item"',
            "main"))
        database.commit()
        database.close()

    log_start(1, 9)
    assert reader.poll()["tps"] == 100/3
    result = reader.poll_response_summary()
    assert result["tps"] == 100/3
    assert result["measured_seconds"] == 3
    assert result["measured_samples"] == 1
    log_start(2, 8)
    assert reader.poll()["issue"] == "ambiguous_response"
    result = reader.poll_response_summary()
    assert result["tps"] is None
    assert result["measured_samples"] == 0
    assert result["measured_tokens"] == 0


def check_expired_log_start_preserves_verified_sample(tmp_path):
    source, state = fixture_root(tmp_path)
    path = add_thread(state, source)
    state.close()
    records = response()
    append(path, start() + [records[0], records[2]])
    database = sqlite3.connect(tmp_path / "logs_2.sqlite")
    database.execute("INSERT INTO logs VALUES(?,?,?,?,?,?)", (
        1, EPOCH+10, 0, "codex_core::stream_events_utils",
        'turn{turn.id=turn}: Output item item_type="message" item_id="item"', "main"))
    database.commit()
    reader = StatusReader(tmp_path, "main")
    assert reader.poll_response_summary()["tps"] == 50
    database.execute("DELETE FROM logs")
    database.commit()
    database.close()
    assert reader.poll()["issue"] == "missing_start"
    result = reader.poll_response_summary()
    assert result["tps"] == 50
    assert result["measured_tokens"] == 100
    assert result["measured_samples"] == 1


def check_late_old_response_evidence_revises_and_withdraws(tmp_path):
    source, state = fixture_root(tmp_path)
    path = add_thread(state, source)
    state.close()
    records = start()
    for number in range(360):
        records += response(f"old-item-{number}", f"old-response-{number}",
                            second=12+3*number, tokens=1)
    records[2]["payload"]["content"] = [{"text": "PRIVATE_BODY_NOT_RETAINED"}]
    append(path, records)
    reader = StatusReader(tmp_path, "main")
    assert reader.poll_response_summary()["measured_samples"] == 360
    key = ("main", "turn", "old-response-0")
    assert key in reader._response_evidence
    assert not any(item.id == "old-response-0" for item in reader.rollout.responses)
    assert "PRIVATE_BODY_NOT_RETAINED" not in repr(reader._response_evidence)

    def add_start(ident, second):
        database = sqlite3.connect(tmp_path / "logs_2.sqlite")
        database.execute("INSERT INTO logs VALUES(?,?,?,?,?,?)", (
            ident, EPOCH+second, 0, "codex_core::stream_events_utils",
            'turn{turn.id=turn}: Output item item_type="message" item_id="old-item-0"',
            "main"))
        database.commit()
        database.close()

    add_start(1, 9)
    result = reader.poll_response_summary()
    assert result["measured_samples"] == 360
    assert result["measured_seconds"] == 721
    assert result["tps"] == 360/721
    add_start(2, 8)
    result = reader.poll_response_summary()
    assert result["measured_samples"] == 359
    assert result["measured_tokens"] == 359
    assert reader._sampled[key].exclusion == "ambiguous_response"


def check_legacy_correction_cannot_withdraw_evicted_modern_response(tmp_path):
    source, state = fixture_root(tmp_path)
    path = add_thread(state, source)
    state.close()
    records = start() + response()
    records += [event(14, "event_msg", {"type": "token_count", "info": {
        "last_token_usage": {"output_tokens": 100},
        "total_token_usage": {"output_tokens": 100}}})]
    second = response("reasoning-next", "modern-response", second=16, tokens=200)
    records += second[:2]
    records += [event(17, "event_msg", {"type": "token_count", "info": {
        "last_token_usage": {"output_tokens": 100},
        "total_token_usage": {"output_tokens": 100}}}),
        event(20, "response_item", {"type": "custom_tool_call",
                                    "id": "tool-next", "call_id": "call"}),
        event(21, "token_usage_record", {"thread_id": "main", "turn_id": "turn",
              "response_id": "modern-response", "usage": {"output_tokens": 200}})]
    append(path, records)
    reader = StatusReader(tmp_path, "main")
    assert reader.poll_response_summary()["measured_samples"] == 2
    follow = []
    for number in range(305):
        follow += response(f"follow-{number}", f"follow-response-{number}",
                           second=25+3*number, tokens=1)
    append(path, follow)
    result = reader.poll_response_summary()
    key = ("main", "turn", "modern-response")
    assert result["measured_samples"] == 307
    assert result["measured_tokens"] == 605
    assert reader._sampled[key].exclusion is None
    assert reader._response_evidence[key].tokens == 200
    assert not any(item.id == "modern-response" for item in reader.rollout.responses)


class StatusBackendTests(unittest.TestCase):
    def run_check(self, check):
        with tempfile.TemporaryDirectory() as directory:
            check(Path(directory))

    def test_cache_context_missing_and_zero(self):
        for case in CACHE_CASES:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                check_cache_context_missing_and_zero(Path(directory), *case)

    def test_latest_excluded_response(self):
        self.run_check(check_latest_excluded_response_never_reuses_prior_speed)

    def test_missing_latest_boundary(self):
        self.run_check(check_missing_latest_boundary_does_not_reuse_prior_speed)

    def test_auto_selection(self):
        self.run_check(check_auto_selection_excludes_child_and_switches)

    def test_rollout_truncation(self):
        self.run_check(check_rollout_truncation_clears_previous_measurement)

    def test_exact_log_pairing(self):
        self.run_check(check_logs_are_read_from_selected_thread_with_exact_item_ids)

    def test_replaced_log_database(self):
        self.run_check(check_replaced_log_database_drops_stale_start_evidence)

    @unittest.skipUnless(os.name == "nt", "Windows extended path spelling")
    def test_windows_extended_path(self):
        self.run_check(check_windows_extended_path)

    def test_summary_weighted_deduplicated(self):
        self.run_check(check_summary_weighted_deduplicated_and_keeps_reliable_samples)

    def test_summary_excludes_inheritance_and_other_thread(self):
        self.run_check(check_summary_excludes_fork_inheritance_and_other_thread)

    def test_summary_beyond_parser_deque(self):
        self.run_check(check_summary_preserves_samples_beyond_parser_deque)

    def test_foreign_token_count_rejected(self):
        self.run_check(check_foreign_token_count_rejected_before_parser)

    def test_clipped_fork_parent_cache(self):
        self.run_check(check_clipped_fork_prefix_does_not_leak_parent_cache)

    def test_owner_switch_clears_samples(self):
        self.run_check(check_owner_switch_clears_ledger_and_cache)

    def test_missing_source_blanks_summary(self):
        self.run_check(check_missing_source_blanks_summary_metrics)

    def test_old_usage_cannot_regress_cache(self):
        self.run_check(check_old_token_snapshot_cannot_regress_cache)

    def test_sample_store_limit(self):
        self.run_check(check_sample_store_limit_is_explicit)

    def test_same_revision_update_and_withdrawal(self):
        self.run_check(check_same_revision_timing_updates_and_ambiguity_withdraws)

    def test_expired_log_evidence_preserved(self):
        self.run_check(check_expired_log_start_preserves_verified_sample)

    def test_old_response_late_evidence(self):
        self.run_check(check_late_old_response_evidence_revises_and_withdraws)

    def test_old_modern_response_legacy_correction(self):
        self.run_check(check_legacy_correction_cannot_withdraw_evicted_modern_response)


if __name__ == "__main__":
    unittest.main(verbosity=2)
