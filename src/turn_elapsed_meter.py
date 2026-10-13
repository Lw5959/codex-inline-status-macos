"""Bounded, text-free evidence for completed-turn wall-clock throughput.

This measures the entire turn, including waiting and tools. It never derives
request or decoding time from the arrival time of an output item.
"""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timezone


def _count(value: object) -> int | None:
    return value if type(value) is int and 0 <= value <= 2**63 - 1 else None


def _ident(value: object) -> str | None:
    return value if isinstance(value, str) and 0 < len(value) <= 160 else None


def _micros(value: object) -> int | None:
    if not isinstance(value, str):
        return None
    try:
        instant = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if instant.tzinfo is None:
            return None
        delta = instant.astimezone(timezone.utc) - datetime(1970, 1, 1, tzinfo=timezone.utc)
        result = ((delta.days * 86400 + delta.seconds) * 1_000_000 + delta.microseconds)
        return result if result >= 0 else None
    except (ValueError, OverflowError):
        return None


@dataclass
class _Turn:
    started: int | None = None
    ended: int | None = None
    end_signature: tuple | None = None
    duration_us: int | None = None
    invalid: bool = False
    # Only response identity, timestamp and token counters are retained.
    responses: dict[str, tuple[int, int, int | None]] = field(default_factory=dict)
    tokens: int = 0
    last_cumulative: int | None = None


class TurnElapsedMeter:
    def __init__(self, capacity: int = 10000):
        self.capacity = capacity
        self.turns: OrderedDict[str, _Turn] = OrderedDict()
        self.responses: OrderedDict[str, str] = OrderedDict()
        self.limited = False

    def reset(self) -> None:
        self.turns.clear()
        self.responses.clear()
        self.limited = False

    def damage(self) -> None:
        """A skipped record makes every currently open turn unverifiable."""
        for turn in self.turns.values():
            if turn.ended is None:
                turn.invalid = True

    def _turn(self, ident: str) -> _Turn:
        turn = self.turns.get(ident)
        if turn is None:
            turn = self.turns[ident] = _Turn()
            while len(self.turns) > self.capacity:
                _, removed = self.turns.popitem(last=False)
                for response in removed.responses:
                    self.responses.pop(response, None)
                self.limited = True
        return turn

    def feed(self, record: dict) -> None:
        value = record.get("payload")
        if not isinstance(value, dict):
            return
        kind = record.get("type")
        event = value.get("type") if kind == "event_msg" else kind
        if event not in {"task_started", "task_complete", "token_usage_record", "task_aborted"}:
            return
        ident = _ident(value.get("turn_id"))
        if ident is None:
            self.damage()
            return
        turn = self._turn(ident)
        at = _micros(record.get("timestamp"))
        if at is None:
            turn.invalid = True
            return
        if event == "task_started":
            if "started_at" in value and _count(value["started_at"]) != at // 1_000_000:
                turn.invalid = True
            # Duplicate identical boundaries are harmless; a second start for
            # the same id or events preceding its start are not a new turn.
            if turn.started is not None:
                turn.invalid |= turn.started != at
                return
            if turn.responses or turn.ended is not None:
                turn.invalid = True
            turn.started = at
            return
        if event == "task_aborted":
            turn.invalid = True
            return
        if turn.started is None or at < turn.started:
            turn.invalid = True
        if event == "task_complete":
            signature = (at, value.get("started_at"), value.get("completed_at"),
                         value.get("duration_ms"))
            if turn.ended is not None:
                turn.invalid |= turn.end_signature != signature
                return
            turn.ended, turn.end_signature = at, signature
            if turn.started is None or at <= turn.started:
                turn.invalid = True
                return
            if ("started_at" in value and
                    _count(value["started_at"]) != turn.started // 1_000_000):
                turn.invalid = True
            if ("completed_at" in value and
                    _count(value["completed_at"]) != at // 1_000_000):
                turn.invalid = True
            elapsed = at - turn.started
            duration = _count(value.get("duration_ms"))
            if "duration_ms" in value and duration is None:
                turn.invalid = True
            # Exact agreement, without an empirical tolerance. Missing or
            # inconsistent duration_ms falls back to the observed full span.
            turn.duration_us = duration * 1000 if duration and duration * 1000 == elapsed else elapsed
            if any(stamp > at for stamp, _, _ in turn.responses.values()):
                turn.invalid = True
            return
        response = _ident(value.get("response_id"))
        usage = value.get("usage")
        tokens = _count(usage.get("output_tokens")) if isinstance(usage, dict) else None
        cumulative = value.get("turn_token_usage")
        total = _count(cumulative.get("output_tokens")) if isinstance(cumulative, dict) else None
        if (response is None or tokens is None or
                ("turn_token_usage" in value and total is None)):
            turn.invalid = True
            return
        if turn.ended is not None and at > turn.ended:
            turn.invalid = True
        previous = turn.responses.get(response)
        if previous is not None:
            # A replay must carry the identical usage and cumulative snapshot.
            # Conflicting revisions withdraw the entire turn, never double-add.
            turn.invalid |= previous[1:] != (tokens, total)
            return
        other = self.responses.get(response)
        if other is not None and other != ident:
            self.turns[other].invalid = turn.invalid = True
            return
        turn.tokens += tokens
        if turn.tokens > 2**63 - 1 or (total is not None and total != turn.tokens):
            turn.invalid = True
        turn.last_cumulative = total
        turn.responses[response] = (at, tokens, total)
        self.responses[response] = ident
        while len(self.responses) > self.capacity:
            removed, owner = self.responses.popitem(last=False)
            self.turns[owner].responses.pop(removed, None)
            self.turns[owner].invalid = True
            self.limited = True

    def summary(self) -> dict:
        valid = [turn for turn in self.turns.values()
                 if not turn.invalid and turn.started is not None and
                 turn.ended is not None and turn.duration_us and turn.responses]
        tokens = sum(turn.last_cumulative if turn.last_cumulative is not None else turn.tokens
                     for turn in valid)
        micros = sum(turn.duration_us for turn in valid)
        seconds = micros / 1_000_000
        return {
            "tps": tokens / seconds if seconds > 0 else None,
            "tps_at": max((turn.ended / 1_000_000 for turn in valid), default=None),
            "tokens": tokens if valid else None,
            "seconds": seconds if valid else None,
            "measured_samples": len(valid),
            "measured_tokens": tokens,
            "measured_seconds": seconds,
            "scope": "sampled_session",
            "measurement_method": "turn_elapsed",
            "samples_limited": self.limited,
        }
