"""Privacy/protocol tests for the stdio worker, with synthetic readers."""
import io
import json
import math
import sys
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from native_status_backend import MAX_LINE, MAX_READERS, METRIC_FIELDS, safe_metrics, serve


class WorkerTests(unittest.TestCase):
    def test_whitelist_and_one_reader_per_thread(self):
        constructed = []

        class Reader:
            def __init__(self, root, ident):
                constructed.append((root, ident))

            def poll_summary(self):
                return {"thread_id": "PRIVATE_ID", "title": "PRIVATE_TITLE",
                        "logs": "PRIVATE_LOG", "tps": 0, "cache_hit": 0.0,
                        "scope": "sampled_session", "measured_samples": 2,
                        "samples_limited": True, "measurement_method": "turn_elapsed"}

        ident = str(uuid.UUID(int=1))
        requests = [{"id": n, "thread_id": ident} for n in range(2)]
        output = io.StringIO()
        serve(io.BytesIO(("\n".join(map(json.dumps, requests))+"\n").encode()),
              output, Path("synthetic"), Reader)
        results = [json.loads(line) for line in output.getvalue().splitlines()]
        assert len(constructed) == 1
        assert [row["id"] for row in results] == [0, 1]
        assert results[0]["metrics"]["tps"] == 0
        assert results[0]["metrics"]["cache_hit"] == 0.0
        assert results[0]["metrics"]["samples_limited"] is True
        assert results[0]["metrics"]["measurement_method"] == "turn_elapsed"
        assert set(results[0]["metrics"]) == METRIC_FIELDS
        assert "PRIVATE" not in output.getvalue()
        assert ident not in output.getvalue()

    def test_nine_active_threads_keep_their_readers(self):
        created = []

        class Reader:
            def __init__(self, root, ident):
                created.append(ident)
                self.count = 0

            def poll_summary(self):
                self.count += 1
                return {"measured_samples": self.count}

        ids = [str(uuid.UUID(int=n)) for n in range(1, 10)]
        order = ids + ids
        data = "".join(json.dumps({"id": n, "thread_id": ident})+"\n"
                       for n, ident in enumerate(order))
        output = io.StringIO()
        serve(io.BytesIO(data.encode()), output, Path("synthetic"), Reader, clock=lambda: 0)
        results = [json.loads(line) for line in output.getvalue().splitlines()]
        assert created == ids
        assert all(result["metrics"]["measured_samples"] == 2 for result in results[9:])

    def test_33rd_active_thread_is_rejected_without_eviction(self):
        created = []

        class Reader:
            def __init__(self, root, ident):
                created.append(ident)

            def poll_summary(self):
                return {}

        assert MAX_READERS == 32
        ids = [str(uuid.UUID(int=n)) for n in range(1, 34)]
        order = ids + [ids[0]]
        data = "".join(json.dumps({"id": n, "thread_id": ident})+"\n"
                       for n, ident in enumerate(order))
        output = io.StringIO()
        serve(io.BytesIO(data.encode()), output, Path("synthetic"), Reader, clock=lambda: 0)
        results = [json.loads(line) for line in output.getvalue().splitlines()]
        assert created == ids[:32]
        assert results[32] == {"id": 32, "error": "capacity_exceeded"}
        assert "metrics" in results[33]

    def test_only_readers_inactive_over_30_seconds_are_recycled(self):
        created = []

        class Reader:
            def __init__(self, root, ident):
                created.append(ident)

            def poll_summary(self):
                return {}

        ids = [str(uuid.UUID(int=n)) for n in range(1, 34)]
        order = ids[:32] + [ids[0], ids[32], ids[32], ids[0], ids[1]]
        times = iter([0.0]*32 + [29.0, 30.0, 30.01, 30.02, 30.03])
        data = "".join(json.dumps({"id": n, "thread_id": ident})+"\n"
                       for n, ident in enumerate(order))
        output = io.StringIO()
        serve(io.BytesIO(data.encode()), output, Path("synthetic"), Reader,
              clock=lambda: next(times))
        results = [json.loads(line) for line in output.getvalue().splitlines()]
        assert results[33] == {"id": 33, "error": "capacity_exceeded"}
        assert "metrics" in results[34]
        assert created == ids[:32] + [ids[32], ids[1]]

    def test_invalid_and_oversized_requests_recover(self):
        calls = []

        class Reader:
            def __init__(self, root, ident):
                calls.append(ident)

            def poll_summary(self):
                return {}

        ident = str(uuid.UUID(int=1))
        bad = json.dumps({"id": "bad", "thread_id": "../private"}).encode()+b"\n"
        huge = b"x"*(MAX_LINE+50)+b"\n"
        good = json.dumps({"id": 2, "thread_id": ident}).encode()+b"\n"
        output = io.StringIO()
        serve(io.BytesIO(bad+huge+good), output, Path("synthetic"), Reader)
        results = [json.loads(line) for line in output.getvalue().splitlines()]
        assert len(results) == 3
        assert results[0] == {"id": "bad", "error": "invalid_request"}
        assert results[1] == {"id": None, "error": "invalid_request"}
        assert "metrics" in results[2]
        assert calls == [ident]

    def test_backend_exception_is_generic(self):
        class Reader:
            def __init__(self, root, ident):
                raise RuntimeError("PRIVATE_PATH SECRET_CONTENT")

        data = json.dumps({"id": "request", "thread_id": str(uuid.UUID(int=1))})
        output = io.StringIO()
        serve(io.BytesIO(data.encode()), output, Path("synthetic"), Reader)
        assert json.loads(output.getvalue()) == {"id": "request", "error": "backend_error"}
        assert "PRIVATE" not in output.getvalue()

    def test_nonfinite_values_do_not_escape(self):
        result = safe_metrics({"tps": math.nan, "seconds": math.inf, "tokens": True,
                               "model": "x"*129, "unexpected": "private"})
        assert result["tps"] is None
        assert result["seconds"] is None
        assert result["tokens"] is None
        assert result["model"] is None
        json.dumps(result, allow_nan=False)


if __name__ == "__main__":
    unittest.main(verbosity=2)
