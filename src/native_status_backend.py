"""Bounded stdio JSONL worker for the native Codex status integration.

Requests: {"id": 1, "thread_id": "<uuid>"}. Responses contain the request id
and whitelisted numeric/status metrics only. This worker opens no listener,
discovers no threads, reads no credentials, and writes nothing to Codex.
At most 32 readers are retained. A new thread can replace only a reader that
has been unvisited for more than 30 seconds; otherwise capacity_exceeded is
returned without evicting an active thread.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
from collections import OrderedDict
from pathlib import Path
from typing import BinaryIO, TextIO

from codex_status_backend import StatusReader


MAX_LINE = 64 * 1024
MAX_READERS = 32
READER_IDLE_SECONDS = 30.0
UUID = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\Z")
NUMBER_FIELDS = {
    "tps", "tps_at", "tokens", "seconds", "cache_hit", "context_used",
    "input_tokens", "cached_tokens", "context_window", "updated_at",
    "measured_samples", "measured_tokens", "measured_seconds",
}
TEXT_FIELDS = {"model", "state", "issue", "selection_mode", "scope", "measurement_method"}
BOOL_FIELDS = {"samples_limited"}
METRIC_FIELDS = NUMBER_FIELDS | TEXT_FIELDS | BOOL_FIELDS


def safe_metrics(value: dict) -> dict:
    result = {}
    for key in sorted(METRIC_FIELDS):
        item = value.get(key)
        if key in BOOL_FIELDS:
            if type(item) is not bool:
                item = None
        elif key in NUMBER_FIELDS:
            if type(item) not in (int, float) or not math.isfinite(item):
                item = None
        elif not isinstance(item, str) or len(item) > 128:
            item = None
        result[key] = item
    return result


def correlation_id(request: object) -> int | str | None:
    if not isinstance(request, dict):
        return None
    value = request.get("id")
    if type(value) is int and -(2**53) < value < 2**53:
        return value
    if isinstance(value, str) and len(value) <= 128:
        return value
    return None


def serve(
    source: BinaryIO, destination: TextIO, codex_root: Path,
    reader_factory=StatusReader,
    clock=time.monotonic,
) -> None:
    readers: OrderedDict[str, tuple[StatusReader, float]] = OrderedDict()

    def emit(value: dict) -> None:
        destination.write(json.dumps(value, ensure_ascii=True, allow_nan=False) + "\n")
        destination.flush()

    while True:
        line = source.readline(MAX_LINE + 1)
        if not line:
            return
        if len(line) > MAX_LINE:
            while line and not line.endswith(b"\n"):
                line = source.readline(MAX_LINE + 1)
            emit({"id": None, "error": "invalid_request"})
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = correlation_id(request)
            if request_id is None or not isinstance(request, dict):
                emit({"id": request_id, "error": "invalid_request"})
                continue
            thread_id = request.get("thread_id")
            if not isinstance(thread_id, str) or UUID.fullmatch(thread_id) is None:
                emit({"id": request_id, "error": "invalid_request"})
                continue
            thread_id = thread_id.lower()
            now = clock()
            entry = readers.get(thread_id)
            if entry is None:
                if len(readers) >= MAX_READERS:
                    expired = next(
                        (ident for ident, (_, visited) in readers.items()
                         if now - visited > READER_IDLE_SECONDS),
                        None,
                    )
                    if expired is None:
                        emit({"id": request_id, "error": "capacity_exceeded"})
                        continue
                    readers.pop(expired)
                reader = reader_factory(codex_root, thread_id)
            else:
                reader = entry[0]
            readers[thread_id] = (reader, now)
            readers.move_to_end(thread_id)
            emit({"id": request_id, "metrics": safe_metrics(reader.poll_summary())})
        except (ValueError, TypeError, RecursionError):
            emit({"id": request_id, "error": "invalid_request"})
        except Exception:
            # Never serialize exception text: it may include file paths or data.
            emit({"id": request_id, "error": "backend_error"})


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--codex-root", type=Path,
        default=Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")),
    )
    options = parser.parse_args()
    serve(sys.stdin.buffer, sys.stdout, options.codex_root)


if __name__ == "__main__":
    main()
