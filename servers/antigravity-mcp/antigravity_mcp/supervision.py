"""Non-LLM supervision of explicitly registered jobs; no IDE or GPT polling."""
from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
from pathlib import Path

INTERVAL_SECONDS = 300
TERMINAL = {"completed", "failed", "cancelled"}
INTERVENTION_PREFIX = "MCP_GPT_INTERVENTION:\n"
SUPERVISION_HOST_INSTRUCTIONS = """\
GPT owns core design/implementation, multi-parent decomposition and final review.
Dispatch independent roots/workers/agents on one IDE, then end the GPT turn.
Native jobs get non-LLM local status checks every 300 seconds. Keep tunnel/MCP/IDE
running. Subscribe to agent_job.attention for that exact job_id when events are
available. Normal progress stays local. Use get_agent_job_status for compact
status; fetch check_agent_job details only for completion or problems. A local
timer alone cannot wake ChatGPT; do not promise automatic resume before a real
event subscription and end-to-end delivery have been verified.
"""
AUTONOMOUS_INSTRUCTIONS = """\
Execute your assigned independent work autonomously within its declared scope.
Implement, run meaningful checks, fix ordinary local errors and collect actual
results. Do not ask GPT for routine progress updates or fabricate success.
After two attempts at the same unresolved blocker, or when a core contract must
change, return a final message starting exactly MCP_GPT_INTERVENTION: followed
by a newline and JSON {"reason":"...","attempted":["..."],"needed":"..."}.
This requests GPT review and stops this task tree with owned-session cleanup;
it is not a successful completion. Include this blocker protocol in each worker
and leaf instruction. Propagate child blockers up to the root using the same
marker; never count them as successful results. Treat fixed inputs as
fixed. Never read other root conversations or modify sibling-owned outputs.
"""


def parse_intervention(steps):
    responses = [step.get("plannerResponse", {}) for step in steps
                 if step.get("type") == "CORTEX_STEP_TYPE_PLANNER_RESPONSE"]
    if not responses:
        return None
    text = responses[-1].get("modifiedResponse") or responses[-1].get("response") or ""
    if not text.startswith(INTERVENTION_PREFIX) or len(text) > 8192:
        return None
    try:
        value = json.loads(text[len(INTERVENTION_PREFIX):])
        if (not isinstance(value, dict) or set(value) != {"reason", "attempted", "needed"}
                or not all(isinstance(value[key], str) and value[key].strip() and len(value[key]) <= 2000
                           for key in ("reason", "needed"))
                or not isinstance(value["attempted"], list) or len(value["attempted"]) > 10
                or not all(isinstance(item, str) and len(item) <= 1000 for item in value["attempted"])):
            return None
        return value
    except (ValueError, TypeError):
        return None


class StateStore:
    """Durable private state. SQLite serializes concurrent callback/timer writes."""

    def __init__(self, path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(str(path), check_same_thread=False, timeout=10)
        self.db.execute("CREATE TABLE IF NOT EXISTS state (kind TEXT, id TEXT, value TEXT, PRIMARY KEY(kind,id))")
        self.db.commit()
        try:
            path.chmod(0o600)
        except OSError:
            pass  # Windows uses the current user's inherited profile ACL.

    def put(self, kind, ident, value):
        with self.lock, self.db:
            self.db.execute("INSERT OR REPLACE INTO state VALUES (?,?,?)",
                            (kind, ident, json.dumps(value, ensure_ascii=False)))

    def delete(self, kind, ident):
        with self.lock, self.db:
            self.db.execute("DELETE FROM state WHERE kind=? AND id=?", (kind, ident))

    def rows(self, kind):
        with self.lock:
            return {ident: json.loads(value) for ident, value in
                    self.db.execute("SELECT id,value FROM state WHERE kind=?", (kind,))}

    def close(self):
        with self.lock:
            self.db.close()


def progress_fingerprint(snapshot):
    metadata = snapshot.get("metadata", {})
    trees = metadata.get("native_forest_parents", {})
    rows = {key: (value.get("status"), value.get("nodes", {}))
            for key, value in trees.items()}
    # Do not hash wall clocks or elapsed duration: they are not progress.
    value = [snapshot["status"], len(snapshot.get("progress_logs", [])),
             metadata.get("native_tree", {}), rows]
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()


def compact_status(snapshot):
    """Operational fields only. Never copy task prompts, logs, outputs or auth."""
    metadata = snapshot.get("metadata", {})
    parents = metadata.get("native_forest_parents", {})
    nodes = {}
    for parent in parents.values():
        nodes.update(parent.get("nodes", {}))
    if not nodes:
        nodes = metadata.get("native_tree", {})
    forest = bool(metadata.get("native_forest"))
    cleanup_verified = None
    if snapshot["status"] in TERMINAL:
        if forest:
            cleanup_verified = bool(metadata.get("native_forest_executors_joined") and parents and all(
                (row.get("status") == "completed" and row.get("nodes") and
                 all(node.get("terminal_success") for node in row["nodes"].values())) or
                (row.get("cleanup") and all(value is True for value in row["cleanup"].values()))
                for row in parents.values()))
        elif metadata.get("native_plan"):
            cleanup = metadata.get("native_cleanup", {})
            cleanup_verified = (all(row.get("terminal_success") for row in nodes.values()) if snapshot["status"] == "completed" and nodes
                                else bool(cleanup and all(value is True for value in cleanup.values())))
    return {
        "job_id": snapshot["id"], "status": snapshot["status"],
        "model": snapshot["model"], "elapsed_seconds": snapshot["duration_seconds"],
        "parents": len(parents), "observed_sessions": len(nodes),
        "completed_sessions": sum(bool(row.get("terminal_success")) for row in nodes.values()),
        "cleanup_pending": bool(forest and not metadata.get("native_forest_executors_joined", False)),
        "cleanup_verified": cleanup_verified,
        "has_result": bool(snapshot.get("result")), "has_error": bool(snapshot.get("error")),
    }


class JobSupervisor:
    def __init__(self, manager, store, emit, *, clock=time.time,
                 interval=INTERVAL_SECONDS, stale_after=1800):
        self.manager, self.store, self.emit = manager, store, emit
        self.clock, self.interval, self.stale_after = clock, interval, stale_after
        self.lock = threading.RLock()
        self.watches = store.rows("watch")
        self.stop_event = threading.Event()
        self.thread = None

    def configure(self, job_id, *, enabled=True, acknowledge=False):
        job = self.manager.get_job(job_id)
        if job is None:
            raise ValueError("Unknown job_id; supervise only an explicitly dispatched job")
        with self.lock:
            now = self.clock()
            record = self.watches.get(job_id)
            if record is None:
                record = {"enabled": enabled, "last_checked_at": None,
                          "next_check_at": now + self.interval, "last_progress_at": now,
                          "fingerprint": progress_fingerprint(job.to_dict()),
                          "attention": None, "version": 0}
                self.watches[job_id] = record
            else:
                record["enabled"] = enabled
                if acknowledge:
                    record["last_progress_at"] = now
                    record["attention"] = None
                if enabled and record["next_check_at"] is None:
                    record["next_check_at"] = now + self.interval
            self.store.put("watch", job_id, record)
        return self.status(job_id)

    def status(self, job_id):
        job = self.manager.get_job(job_id)
        if job is None:
            raise ValueError("Unknown job_id")
        value = compact_status(job.to_dict())
        with self.lock:
            watch = self.watches.get(job_id)
            value["supervision"] = ({key: watch[key] for key in
                                     ("enabled", "last_checked_at", "next_check_at", "attention", "version")}
                                    if watch else None)
        value["check_interval_seconds"] = self.interval
        value["requires_gpt"] = bool(watch and watch["attention"])
        return value

    def check_job(self, job_id, *, force=False):
        with self.lock:
            watch = self.watches.get(job_id)
            now = self.clock()
            if not watch or not watch["enabled"]:
                return
            if not force and now < watch["next_check_at"]:
                return
            job = self.manager.get_job(job_id)
            if job is None:
                attention, snapshot = "unknown", None
            else:
                snapshot = job.to_dict()
                fingerprint = progress_fingerprint(snapshot)
                if fingerprint != watch["fingerprint"]:
                    watch["last_progress_at"] = now
                    watch["fingerprint"] = fingerprint
                status = snapshot["status"]
                metadata = snapshot.get("metadata", {})
                cleanup_pending = compact_status(snapshot)["cleanup_pending"]
                if cleanup_pending and status in TERMINAL:
                    attention = None  # Do not announce a finished tree before cleanup joins.
                elif metadata.get("gpt_intervention"):
                    attention = "blocked"
                elif status in TERMINAL:
                    attention = status
                elif now - watch["last_progress_at"] >= self.stale_after:
                    attention = "stalled"  # Observation, not proof of failure; never cancel here.
                else:
                    attention = None
            watch["last_checked_at"] = now
            watch["next_check_at"] = now + self.interval
            if attention != watch["attention"]:
                watch["attention"] = attention
                watch["version"] += 1
            if attention == "unknown" or (snapshot and snapshot["status"] in TERMINAL and attention):
                watch["enabled"] = False
                watch["next_check_at"] = None
            # Emit is idempotent by version; retry after a store/broker failure.
            if attention:
                self.emit({"job_id": job_id, "status": snapshot["status"] if snapshot else "unknown",
                           "attention": attention, "version": watch["version"],
                           "checked_at": now, "requires_gpt": True})
            self.store.put("watch", job_id, watch)

    def tick(self):
        with self.lock:
            ids = [ident for ident, row in self.watches.items() if row["enabled"]]
        for ident in ids:
            self.check_job(ident)

    def start(self):
        def loop():
            while not self.stop_event.wait(1):
                try:
                    self.tick()
                except Exception:
                    # Keep the timer alive on temporary disk/transport failures.
                    continue
        self.thread = threading.Thread(target=loop, name="mcp-local-supervisor", daemon=True)
        self.thread.start()

    def close(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=5)
