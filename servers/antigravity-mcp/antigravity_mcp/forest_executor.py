"""Run independent native root trees on one pinned local IDE endpoint."""
from __future__ import annotations

import json
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED

from .forest_plan import parent_plan, validate_forest
from .job_manager import Job
from .native_completion import NATIVE_INSTRUCTIONS, validate_report
from .native_plan import HIGH_MODEL, PREFIX


class ForestExecutionError(RuntimeError):
    pass


def validate_forest_results(plan, children):
    """Recheck every real root tree and reject reused IDs across independent roots."""
    expected = {parent["id"]: parent for parent in plan["parents"]}
    if set(children) != set(expected):
        raise ForestExecutionError("Missing or unexpected parent executions")
    seen, reports, trees = set(), [], {}
    for ident, parent in expected.items():
        child = children[ident]
        snapshot = child.to_dict()
        metadata = snapshot["metadata"]
        if snapshot["status"] != "completed" or snapshot["model"] != HIGH_MODEL:
            raise ForestExecutionError(f"Parent {ident} did not complete with the High model")
        root = metadata.get("cascade_id")
        tree = metadata.get("native_tree", {})
        native = metadata.get("native_completion")
        if not root or not isinstance(tree, dict) or root not in tree or not native:
            raise ForestExecutionError(f"Parent {ident} lacks verified native runtime evidence")
        if seen.intersection(tree):
            raise ForestExecutionError("Independent parent trees reused a conversation ID")
        seen.update(tree)
        if tree[root].get("parent_id") is not None:
            raise ForestExecutionError("A declared parent is not an independent root")
        if not all(row.get("terminal_success") and row.get("model_verified")
                   and row.get("engine_status") == "CASCADE_RUN_STATUS_IDLE"
                   for row in tree.values()):
            raise ForestExecutionError("A parent tree contains unverified or nonterminal work")
        validate_report(json.dumps({"native_completion": native}), parent_plan(plan, parent),
                        metadata["native_completion_token"], root, tree)
        reports.append({"id": ident, "parent_id": root, "status": "completed",
                        "workers": native["workers"]})
        trees[ident] = tree
    return reports, trees


def run_forest(job, context_files=None, system_instruction=None, *, timeout=300.0,
               endpoint=None, local_factory=None):
    # Imports stay lazy so ordinary/REST execution does not need this backend.
    from .antigravity_local import AntigravityLocalExecutor, discover_language_server

    if not job.start():
        return
    children, pool, pending = {}, None, set()
    failure = None
    started = time.monotonic()
    active_peak = busy_peak = 0
    try:
        plan = validate_forest(job.metadata["native_forest"])
        if job.model != HIGH_MODEL:
            raise ForestExecutionError("Multi-parent collaboration requires Gemini 3.8 Flash (High)")
        if context_files:
            raise ForestExecutionError("Declare multi-parent input scopes in the plan; context_files is not allowed")
        if job.is_cancelled():
            return
        endpoint = endpoint or discover_language_server()
        if endpoint is None:
            raise ForestExecutionError("Multi-parent collaboration requires the local Antigravity IDE")
        # The endpoint object (including its private transport auth) never enters
        # job metadata. Every root receives this same object, with no rediscovery.
        job.metadata["native_forest_ide"] = {"host": endpoint.host, "port": endpoint.port,
                                            "pid": getattr(endpoint, "pid", None)}
        token = job.metadata["native_forest_token"]
        local_factory = local_factory or AntigravityLocalExecutor
        deadline = started + timeout
        for parent in plan["parents"]:
            subplan = parent_plan(plan, parent)
            child = Job(id=f"{job.id}/{parent['id']}", task=PREFIX + json.dumps(subplan, ensure_ascii=False),
                        model=HIGH_MODEL, status="pending", metadata={
                            "native_plan": subplan, "native_completion_token": str(uuid.uuid4()),
                            "forest_group_id": job.id, "forest_parent_role": parent["id"]})
            children[parent["id"]] = child
        job.log(f"Launching {len(children)} independent root trees on one pinned IDE endpoint")

        def execute(child):
            if job.is_cancelled():
                child.cancel()
                return
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                child.fail("Multi-parent group deadline reached before start")
                return
            local_factory(endpoint=endpoint, timeout=remaining).run_job_sync(
                child, context_files=[],
                system_instruction=(system_instruction or "")
                + "\nYou are ONE assigned independent root in an already launched multi-parent group. "
                  "Execute only your own declared workers and agents. The MCP owns root fanout; "
                  "do not create, address, enumerate or inspect other root conversations.\n"
                + NATIVE_INSTRUCTIONS)

        # Group fanout does not submit back into the outer MCP queue. Its size is
        # the reviewed plan length, so the outer queue's 3-job default cannot
        # become an accidental 3-parent limit or nested-pool deadlock.
        pool = ThreadPoolExecutor(max_workers=len(children), thread_name_prefix="native-parent")
        future_children = {pool.submit(execute, child): child for child in children.values()}
        pending = set(future_children)
        last_progress = None
        while pending:
            if job.is_cancelled():
                failure = "Multi-parent workflow cancelled"
            elif time.monotonic() >= deadline:
                failure = "Multi-parent group deadline reached"
            elif failure is None:
                failed = next((child for child in children.values()
                               if child.status in ("failed", "cancelled")), None)
                if failed:
                    failure = f"Parent {failed.metadata['forest_parent_role']} {failed.status}: {failed.error or ''}"
            if failure:
                for child in children.values():
                    if child.status in ("pending", "running"):
                        child.cancel()
            done, pending = wait(pending, timeout=0.2, return_when=FIRST_COMPLETED)
            for future in done:
                try:
                    future.result()
                except Exception as exc:
                    child = future_children[future]
                    child.fail(f"{type(exc).__name__}: {exc}")
                    failure = failure or f"Parent {child.metadata['forest_parent_role']} execution failed"
            parent_states = snapshot_parents(children)
            job.metadata["native_forest_parents"] = parent_states
            active = sum(row["status"] == "running" and bool(row["parent_id"])
                         for row in parent_states.values())
            busy = sum(row["nodes"].get(row["parent_id"], {}).get("engine_status")
                       not in (None, "CASCADE_RUN_STATUS_IDLE") for row in parent_states.values())
            active_peak, busy_peak = max(active_peak, active), max(busy_peak, busy)
            job.metadata["native_forest_active_parent_peak"] = active_peak
            job.metadata["native_forest_busy_parent_peak"] = busy_peak
            progress = tuple((ident, row["status"], len(row["nodes"]),
                              sum(bool(n.get("terminal_success")) for n in row["nodes"].values()))
                             for ident, row in parent_states.items())
            if progress != last_progress:
                last_progress = progress
                job.log("Multi-parent progress " + json.dumps(progress)
                        + f"; active-parent-peak={active_peak}")
        if failure:
            raise ForestExecutionError(failure)
        if job.is_cancelled():
            return
        pool.shutdown(wait=True)
        pool = None
        job.metadata["native_forest_executors_joined"] = True
        reports, trees = validate_forest_results(plan, children)
        result = {"token": token, "status": "completed", "parents": reports}
        job.metadata["native_forest_completion"] = result
        job.metadata["native_forest_trees"] = trees
        if not job.complete(json.dumps({"native_forest_completion": result}, ensure_ascii=False)):
            job.log("Multi-parent result arrived after cancellation")
    except Exception as exc:
        job.fail(f"{type(exc).__name__}: {exc}")
        job.log(f"Multi-parent lifecycle failed: {exc}")
    finally:
        if pool is not None:
            if job.status != "completed":
                for child in children.values():
                    if child.status in ("pending", "running"):
                        child.cancel()
            # A group's terminal record never implies cleanup finished until
            # every root executor's existing owned-tree finally has returned.
            pool.shutdown(wait=True)
        job.metadata["native_forest_parents"] = snapshot_parents(children)
        job.metadata["native_forest_executors_joined"] = True
        job.metadata["native_forest_elapsed"] = time.monotonic() - started
        blockers = {ident: child.metadata["gpt_intervention"] for ident, child in children.items()
                    if child.metadata.get("gpt_intervention")}
        if blockers:
            job.metadata["gpt_intervention"] = {"parents": blockers}


def snapshot_parents(children):
    rows = {}
    for ident, child in children.items():
        snapshot = child.to_dict()
        metadata = snapshot["metadata"]
        rows[ident] = {"execution_id": child.id, "parent_id": metadata.get("cascade_id"),
                       "status": snapshot["status"], "model": snapshot["model"],
                       "error": snapshot.get("error"), "nodes": metadata.get("native_tree", {}),
                       "active_worker_peak": metadata.get("native_worker_peak", 0),
                       "cleanup": metadata.get("native_cleanup")}
    return rows


def forest_runtime_evidence(snapshot):
    metadata = snapshot["metadata"]
    if metadata.get("native_forest_completion") is None:
        return ""
    return "\n\n### Native multi-parent runtime evidence\n" + json.dumps({
        "protocol": 2, "requested_model": snapshot["model"],
        "same_ide": metadata.get("native_forest_ide"),
        "active_parent_peak": metadata.get("native_forest_active_parent_peak", 0),
        "busy_parent_peak": metadata.get("native_forest_busy_parent_peak", 0),
        "executors_joined": metadata.get("native_forest_executors_joined", False),
        "parents": metadata.get("native_forest_parents", {})
    }, ensure_ascii=False)
