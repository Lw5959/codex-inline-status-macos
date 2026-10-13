"""Read-only, bounded Codex status adapter for the compact desktop overlay.

Run with TokenPulse's installed Python environment. The legacy response API
uses TokenPulse. The inline summary uses verified completed-turn wall time.
No conversation text or diagnostic log body is retained by this adapter.
"""

from __future__ import annotations

import math
import sqlite3
import time
from collections import OrderedDict, deque
from contextlib import closing
from pathlib import Path
from typing import Any

from token_pulse.collector import resolved_path
from token_pulse.domain import Context, Sample
from token_pulse.logs import LogEvidence, label, read_only
from token_pulse.rollout import REJECTIONS, Response, Rollout, timestamp
from token_pulse.tailer import JsonlTail
from turn_elapsed_meter import TurnElapsedMeter


INITIAL_BYTES = 4 * 1024 * 1024
INCREMENT_BYTES = 2 * 1024 * 1024
LOG_ROWS = 5000
THREAD_ROWS = 256
MAX_SAMPLES = 10000
SOURCE_UNAVAILABLE = {
    "state_unavailable", "source_unavailable", "no_thread", "logs_unavailable",
    "logs_index_unavailable", "inherited_history", "ownership_unverified",
    "catching_up", "logs_catching_up", "records_skipped",
}


def _database(root: Path, stem: str) -> Path | None:
    versions = []
    for path in root.glob(f"{stem}_*.sqlite"):
        version = path.stem.removeprefix(stem + "_")
        if version.isdigit():
            versions.append((int(version), path))
    return max(versions, default=(0, None))[1]


def _count(value: object) -> int | None:
    return value if type(value) is int and 0 <= value <= 2**63 - 1 else None


def _ratio(numerator: int | None, denominator: int | None) -> float | None:
    if numerator is None or denominator is None or denominator <= 0:
        return None
    return min(1.0, max(0.0, numerator / denominator))


def _empty(mode: str, thread_id: str | None = None, issue: str | None = None) -> dict:
    return {
        "thread_id": thread_id,
        "title": "",
        "model": None,
        "state": "unknown",
        "tps": None,
        "tps_at": None,
        "tokens": None,
        "seconds": None,
        "cache_hit": None,
        "context_used": None,
        "input_tokens": None,
        "cached_tokens": None,
        "context_window": None,
        "updated_at": None,
        "issue": issue,
        "selection_mode": mode,
    }


class _ThreadLogs:
    """Read at most 5,000 selected-thread rows, without global log backfill."""

    def __init__(self, root: Path, thread_id: str, evidence: LogEvidence):
        self.root, self.thread_id, self.evidence = root, thread_id, evidence
        self.identity: tuple | None = None
        self.cursor: int | None = None
        self.last_stamp: tuple | None = None
        self.changed_starts: set[tuple[str, str]] = set()

    def invalidate(self) -> None:
        self.identity = self.cursor = self.last_stamp = None
        self.evidence.starts.clear()
        self.evidence.requests.clear()
        self.evidence.notices.clear()
        self.evidence.submissions.clear()
        self.changed_starts.clear()

    def poll(self) -> str | None:
        self.changed_starts.clear()
        path = _database(self.root, "logs")
        if path is None:
            return "logs_unavailable"
        try:
            stat = path.stat()
            identity = (str(path), stat.st_dev, stat.st_ino)
            with closing(read_only(path)) as connection:
                # This index stores rowid after thread_id, so id-range polls are
                # bounded to one thread even when other threads are very busy.
                indexed = connection.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='index' "
                    "AND name='idx_logs_thread_id'"
                ).fetchone()
                if not indexed:
                    return "logs_index_unavailable"
                source = "logs INDEXED BY idx_logs_thread_id"
                latest = connection.execute(
                    f"SELECT id, ts, ts_nanos FROM {source} "
                    "WHERE thread_id=? ORDER BY id DESC LIMIT 1",
                    (self.thread_id,),
                ).fetchone()
                reset = self.identity != identity or self.cursor is None
                if latest is not None and self.cursor is not None:
                    reset |= latest[0] < self.cursor
                    reset |= latest[0] == self.cursor and latest != self.last_stamp
                elif latest is None and self.cursor:
                    reset = True
                if reset:
                    self.invalidate()
                self.identity = identity
                columns = (
                    "id,ts,ts_nanos,target,CASE WHEN length(feedback_log_body)<=16000 "
                    "THEN feedback_log_body END"
                )
                if self.cursor is None:
                    rows = connection.execute(
                        f"SELECT {columns} FROM {source} WHERE thread_id=? "
                        "ORDER BY id DESC LIMIT ?",
                        (self.thread_id, LOG_ROWS),
                    ).fetchall()[::-1]
                else:
                    rows = connection.execute(
                        f"SELECT {columns} FROM {source} WHERE thread_id=? AND id>? "
                        "ORDER BY id LIMIT ?",
                        (self.thread_id, self.cursor, LOG_ROWS),
                    ).fetchall()
                for row_id, seconds, nanos, target, body in rows:
                    if (
                        isinstance(target, str)
                        and isinstance(body, str)
                        and type(seconds) in (int, float)
                        and type(nanos) in (int, float)
                        and 0 <= seconds <= 2**53
                        and 0 <= nanos < 1e9
                    ):
                        before_key = next(reversed(self.evidence.starts), None)
                        before = self.evidence.starts.get(before_key)
                        self.evidence.accept(
                            self.thread_id, seconds + nanos / 1e9, target, body
                        )
                        after_key = next(reversed(self.evidence.starts), None)
                        if after_key is not None and (
                            after_key != before_key or self.evidence.starts[after_key] != before
                        ):
                            self.changed_starts.add(after_key)
                    self.cursor = row_id
                    self.last_stamp = (row_id, seconds, nanos)
                if self.cursor is None:
                    self.cursor = 0
                if latest is not None and latest[0] > self.cursor:
                    return "logs_catching_up"
        except (OSError, sqlite3.Error, TypeError, ValueError):
            return "logs_unavailable"
        return None


class StatusReader:
    """One selected Codex thread, with no source writes or background processes."""

    def __init__(self, codex_root: Path, thread_id: str | None = None):
        self.root = resolved_path(Path(codex_root))
        self.fixed_id = thread_id
        self.thread: dict[str, Any] | None = None
        self.rollout: Rollout | None = None
        self.tail: JsonlTail | None = None
        self.logs: _ThreadLogs | None = None
        self.evidence = LogEvidence(capacity=6000)
        self.input_tokens = self.cached_tokens = self.context_window = None
        self.latest_key: tuple[str, str] | None = None
        self.latest_at: float | None = None
        self.latest_tokens: int | None = None
        self.latest_unmatched = False
        self.last_issue: str | None = None
        self.total_input_tokens = self.total_cached_tokens = None
        self._sampled: OrderedDict[tuple[str, str, str], Sample] = OrderedDict()
        self._response_evidence: dict[tuple[str, str, str], Response] = {}
        self._item_samples: dict[str, set[tuple[str, str, str]]] = {}
        self._samples_limited = False
        self._owner_id: str | None = None
        self._last_usage_at: float | None = None
        self.turn_meter = TurnElapsedMeter(MAX_SAMPLES)

    @property
    def selection_mode(self) -> str:
        return "fixed" if self.fixed_id is not None else "auto"

    def select(self, thread_id: str | None) -> None:
        """None follows the most recently active main thread."""
        if thread_id != self.fixed_id:
            self.fixed_id = thread_id
            self._clear()

    def _clear(self) -> None:
        self.thread = self.rollout = self.tail = self.logs = None
        self.evidence = LogEvidence(capacity=6000)
        self.input_tokens = self.cached_tokens = self.context_window = None
        self.latest_key = self.latest_at = self.latest_tokens = None
        self.latest_unmatched = False
        self.total_input_tokens = self.total_cached_tokens = None
        self._sampled.clear()
        self._response_evidence.clear()
        self._item_samples.clear()
        self._samples_limited = False
        self._owner_id = None
        self._last_usage_at = None
        self.turn_meter.reset()

    def _threads(self, requested: str | None = None) -> list[dict]:
        state = _database(self.root, "state")
        if state is None:
            raise FileNotFoundError("state_unavailable")
        with closing(read_only(state)) as connection:
            columns = {row[1] for row in connection.execute("PRAGMA table_info(threads)")}
            optional = [
                name if name in columns else f"NULL AS {name}"
                for name in ("model", "reasoning_effort", "model_provider")
            ]
            fields = "id,rollout_path,title," + ",".join(optional)
            if requested is not None:
                rows = connection.execute(
                    f"SELECT {fields} FROM threads WHERE id=? LIMIT 1", (requested,)
                ).fetchall()
            else:
                rows = connection.execute(
                    f"SELECT {fields} FROM threads WHERE archived=0 "
                    "ORDER BY updated_at DESC,id DESC LIMIT ?",
                    (THREAD_ROWS,),
                ).fetchall()
                ids = [row[0] for row in rows]
                children = set()
                if ids:
                    # Only edge identifiers for the bounded candidate set are
                    # returned; no conversation/history tables are queried.
                    placeholders = ",".join("?" for _ in ids)
                    children = {
                        row[0]
                        for row in connection.execute(
                            "SELECT child_thread_id FROM thread_spawn_edges "
                            f"WHERE child_thread_id IN ({placeholders})",
                            ids,
                        )
                    }
                rows = [row for row in rows if row[0] not in children]
        found = []
        for ident, path, title, model, effort, provider in rows:
            try:
                path = resolved_path(Path(path))
                if not path.is_relative_to(self.root) or path.suffix != ".jsonl":
                    continue
            except (OSError, TypeError, ValueError):
                continue
            found.append(
                {
                    "id": ident,
                    "path": path,
                    "title": str(title or "")[:160],
                    "model": label(model),
                    "effort": label(effort),
                    "provider": label(provider),
                }
            )
        return found

    def list_threads(self) -> list[dict]:
        try:
            return [
                {key: thread[key] for key in ("id", "title", "model")}
                for thread in self._threads()
            ]
        except (OSError, sqlite3.Error, TypeError, ValueError):
            return []

    def _attach(self, thread: dict) -> None:
        self._clear()
        self.thread = thread
        context = Context(thread["model"], thread["effort"], thread["provider"])
        self.rollout = Rollout(thread["id"], thread["title"], context)
        self.tail = JsonlTail(
            thread["path"], budget=INITIAL_BYTES, backfill=INITIAL_BYTES,
            max_line=INITIAL_BYTES,
        )
        self.logs = _ThreadLogs(self.root, thread["id"], self.evidence)

    def _reset_rollout(self) -> None:
        assert self.thread is not None
        thread = self.thread
        self.rollout = Rollout(
            thread["id"], thread["title"],
            Context(thread["model"], thread["effort"], thread["provider"]),
        )
        self.rollout.reset()
        self.input_tokens = self.cached_tokens = self.context_window = None
        self.latest_key = self.latest_at = self.latest_tokens = None
        self.latest_unmatched = False
        self.total_input_tokens = self.total_cached_tokens = None
        self._sampled.clear()
        self._response_evidence.clear()
        self._item_samples.clear()
        self._samples_limited = False
        self._owner_id = None
        self._last_usage_at = None
        self.turn_meter.reset()

    def _feed(self, record: dict) -> None:
        assert self.rollout is not None and self.thread is not None
        value = record.get("payload")
        value = value if isinstance(value, dict) else {}
        kind, event = record.get("type"), value.get("type")
        if kind == "session_meta":
            owner = value.get("id")
            if not isinstance(owner, str) or not owner:
                return
            if owner != self._owner_id:
                self._reset_rollout()
                self._owner_id = owner
            self.rollout.feed(record)
            return
        if "thread_id" in value:
            owner = value["thread_id"]
            # Reject explicit foreign ownership before even the upstream parser
            # can use its counters to close a selected-thread response.
            if not isinstance(owner, str) or owner != self.thread["id"]:
                return
            if self._owner_id != owner:
                self._reset_rollout()
                self._owner_id = owner
        if self._owner_id != self.thread["id"]:
            # A bounded tail can begin inside copied ancestor history. Without
            # an owner boundary, implicit token_count records are not evidence
            # for the selected thread.
            return
        self.turn_meter.feed(record)
        at = timestamp(record.get("timestamp"))
        if kind == "event_msg" and event == "token_count":
            if at is None or (
                self._last_usage_at is not None and at < self._last_usage_at - 0.001
            ):
                return
            self._last_usage_at = at
        previous = self.rollout.responses[-1] if self.rollout.responses else None
        self.rollout.feed(record)
        current = self.rollout.responses[-1] if self.rollout.responses else None
        if self.rollout.inherited:
            return
        if kind == "event_msg" and event == "token_count":
            info = value.get("info")
            info = info if isinstance(info, dict) else {}
            usage = info.get("last_token_usage")
            usage = usage if isinstance(usage, dict) else {}
            self.input_tokens = _count(usage.get("input_tokens"))
            self.cached_tokens = _count(usage.get("cached_input_tokens"))
            self.context_window = _count(info.get("model_context_window"))
            total = info.get("total_token_usage")
            total = total if isinstance(total, dict) else {}
            if value.get("thread_id", self.thread["id"]) == self.thread["id"]:
                self.total_input_tokens = _count(total.get("input_tokens"))
                self.total_cached_tokens = _count(total.get("cached_input_tokens"))
        if current is not None and current is not previous:
            self.latest_key = (current.turn_id, current.id)
            self.latest_at = current.at
            self.latest_tokens = _count(current.tokens)
            self.latest_unmatched = False
        if kind == "token_usage_record" and value.get("thread_id", self.thread["id"]) == self.thread["id"]:
            response = value.get("response_id")
            if isinstance(response, str) and response:
                key = (value.get("turn_id", self.rollout.turn_id), response)
                if key != self.latest_key:
                    self.latest_key = key
                    self.latest_at = timestamp(record.get("timestamp"))
                    usage = value.get("usage")
                    self.latest_tokens = _count(usage.get("output_tokens")) if isinstance(usage, dict) else None
                    self.latest_unmatched = True

    def _remember_samples(self, samples: list[Sample] | None = None) -> None:
        if (self.rollout is None or self.thread is None or self.rollout.inherited
                or self._owner_id != self.thread["id"]):
            return
        observed = self.rollout.samples(self.evidence) if samples is None else samples
        # Rollout returns current responses before legacy correction records.
        # Prefer the current response when both name the same identity; then
        # let fresh evidence revise or withdraw the prior ledger observation.
        current: dict[tuple[str, str, str], Sample] = {}
        responses = {
            (self.thread["id"], response.turn_id, response.id): response
            for response in self.rollout.responses
        }
        for sample in observed:
            current.setdefault(sample.key, sample)
        for sample in current.values():
            response = responses.get(sample.key)
            self._store_sample(
                sample, response=response,
                correction_only=response is None and sample.issue in REJECTIONS,
            )

    def _forget_response(self, key: tuple[str, str, str]) -> None:
        response = self._response_evidence.pop(key, None)
        if response is None:
            return
        for item_id, _ in response.items:
            owners = self._item_samples.get(item_id)
            if owners is not None:
                owners.discard(key)
                if not owners:
                    self._item_samples.pop(item_id, None)

    def _store_sample(
        self, sample: Sample, *, response: Response | None = None,
        correction_only: bool = False,
    ) -> None:
        if self.thread is None or sample.task_id != self.thread["id"]:
            return
        previous = self._sampled.get(sample.key)
        if correction_only and previous is not None and previous.exclusion is None:
            # Legacy withdrawals refer to superseded parser scopes. They are
            # not new evidence against a response validated by this parser.
            return
        expired_log_only = (
            previous is not None
            and previous.exclusion is None
            and previous.timing_source == "stream-log"
            and sample.exclusion in {"missing_start", "missing_stream_start"}
            and sample.ended_at == previous.ended_at
            and sample.output_tokens == previous.output_tokens
            and sample.token_scope == previous.token_scope
        )
        self._sampled[sample.key] = previous if expired_log_only else sample
        if response is not None and self._response_evidence.get(sample.key) is not response:
            self._forget_response(sample.key)
            self._response_evidence[sample.key] = response
            for item_id, _ in response.items:
                self._item_samples.setdefault(item_id, set()).add(sample.key)
        self._sampled.move_to_end(sample.key)
        while len(self._sampled) > MAX_SAMPLES:
            key, _ = self._sampled.popitem(last=False)
            self._forget_response(key)
            self._samples_limited = True

    def _refresh_changed_starts(self) -> None:
        if (self.thread is None or self.rollout is None or self.logs is None
                or self._owner_id != self.thread["id"]):
            return
        affected = set()
        for owner, item_id in self.logs.changed_starts:
            if owner == self.thread["id"]:
                affected.update(self._item_samples.get(item_id, ()))
        responses = [self._response_evidence[key] for key in affected
                     if key in self._response_evidence and key in self._sampled]
        if not responses:
            return
        # Reuse TokenPulse's exact timing/exclusion rules for only the cached
        # responses whose item evidence changed. No source history is reread.
        probe = Rollout(self.thread["id"])
        probe.responses = deque(responses)
        for sample in probe.samples(self.evidence):
            self._store_sample(sample)

    def poll(self) -> dict:
        try:
            choices = self._threads(self.fixed_id)
        except (OSError, sqlite3.Error, TypeError, ValueError):
            return _empty(self.selection_mode, self.fixed_id, "state_unavailable")
        if not choices:
            self._clear()
            return _empty(self.selection_mode, self.fixed_id, "no_thread")
        selected = choices[0]
        if self.thread is None or any(
            self.thread[key] != selected[key] for key in ("id", "path")
        ):
            self._attach(selected)
        else:
            self.thread.update(selected)
            self.rollout.title = selected["title"]
        assert self.tail is not None and self.rollout is not None and self.logs is not None
        log_issue = self.logs.poll()
        batch = self.tail.read()
        self.tail.budget = INCREMENT_BYTES
        if batch.reset or batch.skipped_prefix:
            self._reset_rollout()
            if batch.reset:
                self.logs.invalidate()
                log_issue = self.logs.poll()
        gaps = set(batch.gaps)
        for index, record in enumerate(batch.records):
            if index in gaps:
                self.rollout.damage("record_gap")
                self.turn_meter.damage()
            self._feed(record)
            # Preserve observations before Rollout's bounded deque expires.
            # Source history is still limited to the initial 4 MiB tail plus
            # subsequent 2 MiB increments; this is never a history backfill.
            if index % 128 == 127:
                self._remember_samples()
        if len(batch.records) in gaps:
            self.rollout.damage("record_gap")
            self.turn_meter.damage()
        task = self.rollout.task(self.evidence)
        result = _empty(self.selection_mode, selected["id"])
        result.update(
            title=selected["title"], model=task.context.model or selected["model"],
            state=task.display_state(time.time()), updated_at=task.updated_at or None,
            cache_hit=_ratio(self.cached_tokens, self.input_tokens),
            context_used=_ratio(self.input_tokens, self.context_window),
            input_tokens=self.input_tokens, cached_tokens=self.cached_tokens,
            context_window=self.context_window,
        )
        candidates = self.rollout.samples(self.evidence)
        self._remember_samples(candidates)
        self._refresh_changed_starts()
        sample = next(
            (sample for sample in reversed(candidates)
             if (sample.turn_id, sample.response_id) == self.latest_key), None
        )
        if sample is not None:
            result.update(tps=sample.tps, tps_at=sample.ended_at,
                          tokens=_count(sample.output_tokens), seconds=sample.seconds,
                          issue=sample.exclusion)
        elif self.latest_at is not None:
            result.update(tps_at=self.latest_at, tokens=self.latest_tokens,
                          issue="missing_output_boundary")
        if self.tail.offset < batch.size:
            result.update(tps=None, seconds=None, state="catching_up", issue="catching_up")
        if log_issue:
            result.update(tps=None, seconds=None, issue=log_issue)
        if batch.error or batch.malformed or batch.oversized:
            result.update(tps=None, seconds=None,
                          issue=batch.error or "records_skipped")
            if batch.error:
                result["state"] = "unknown"
        if task.notice == "request_failed":
            result.update(tps=None, seconds=None, issue=task.notice)
        if self.rollout.inherited or self._owner_id != selected["id"]:
            issue = "inherited_history" if self.rollout.inherited else "ownership_unverified"
            result.update(tps=None, seconds=None, state="unknown", issue=issue,
                          cache_hit=None, context_used=None, input_tokens=None,
                          cached_tokens=None, context_window=None)
        # Numeric outputs stay JSON-safe even if a future dependency changes.
        for key in ("tps", "tps_at", "seconds", "updated_at"):
            value = result[key]
            if isinstance(value, float) and not math.isfinite(value):
                result[key] = None
        self.last_issue = result["issue"]
        return result

    def poll_response_summary(self) -> dict:
        """Legacy client-item timing diagnostics; not the inline UI metric."""
        result = self.poll()
        valid = [sample for sample in self._sampled.values() if sample.exclusion is None]
        tokens = sum(sample.output_tokens for sample in valid)
        seconds = math.fsum(sample.seconds for sample in valid)
        result.update(
            tps=tokens / seconds if seconds > 0 else None,
            tps_at=max((sample.ended_at for sample in valid), default=None),
            cache_hit=_ratio(self.total_cached_tokens, self.total_input_tokens),
            measured_samples=len(valid), measured_tokens=tokens,
            measured_seconds=seconds, scope="sampled_session",
            samples_limited=self._samples_limited,
        )
        if result["issue"] in SOURCE_UNAVAILABLE:
            result.update(tps=None, cache_hit=None)
        return result

    def poll_summary(self) -> dict:
        """Output tokens divided by complete, verified turn elapsed time.

        The startup tail is at most 4 MiB. This summarizes observed samples,
        not the entire conversation's history. Cache hit uses Codex's latest
        thread cumulative counters; context use remains the latest request.
        """
        result = self.poll()
        result.update(self.turn_meter.summary())
        result["cache_hit"] = _ratio(self.total_cached_tokens, self.total_input_tokens)
        result["samples_limited"] |= self._samples_limited
        turn_source_issues = SOURCE_UNAVAILABLE - {
            "logs_unavailable", "logs_index_unavailable", "logs_catching_up"
        }
        if result["issue"] not in turn_source_issues | {"request_failed"}:
            # Completed-turn measurement uses JSONL boundaries and counters;
            # legacy output-item exclusions and their logs are not inputs.
            result["issue"] = None
        if result["issue"] in turn_source_issues:
            result.update(tps=None, seconds=None, cache_hit=None)
        return result

