"""Track only native descendants created by a validated GPT plan."""
from __future__ import annotations

import hashlib
import json
import time
import uuid
from dataclasses import dataclass, field

from .native_completion import NativeCompletionError, validate_report

IDLE = "CASCADE_RUN_STATUS_IDLE"
DONE = "CORTEX_STEP_STATUS_DONE"
ERROR = "CORTEX_STEP_STATUS_ERROR"
PLANNER = "CORTEX_STEP_TYPE_PLANNER_RESPONSE"
CHECKPOINT = "CORTEX_STEP_TYPE_CHECKPOINT"
INVOKE = "CORTEX_STEP_TYPE_INVOKE_SUBAGENT"


class NativeExecutionError(RuntimeError):
    pass


def canonical(value):
    if not isinstance(value, str):
        raise NativeExecutionError("Native invocation returned a non-string conversation ID")
    try:
        result = str(uuid.UUID(value))
    except ValueError as exc:
        raise NativeExecutionError("Native invocation returned an invalid conversation ID") from exc
    if value.casefold() != result:
        raise NativeExecutionError("Native conversation ID is not canonical")
    return result


def planner_text(step):
    planner = step.get("plannerResponse", {})
    return planner.get("modifiedResponse") or planner.get("response") or ""


@dataclass
class Node:
    cid: str
    parent_id: str | None
    role: str | None
    confirmed: bool = False
    model_verified: bool = False
    children: set = field(default_factory=set)
    response: dict = field(default_factory=dict)
    signature: str | None = None
    changed_at: float = 0.0
    terminal_success: bool = False
    first_seen: float = 0.0
    busy_seen: bool = False

    @property
    def steps(self):
        return self.response.get("trajectory", {}).get("steps", [])

    def last_planner(self):
        for index in range(len(self.steps) - 1, -1, -1):
            step = self.steps[index]
            if step.get("type") == PLANNER and planner_text(step).strip():
                return index, planner_text(step)
        return -1, ""


class NativeTreeTracker:
    def __init__(self, rpc, root_id, model_id, plan, token, log=None, clock=None, timeout=None,
                 cancelled=None):
        self.rpc, self.root_id, self.model_id = rpc, canonical(root_id), model_id
        self.plan, self.token = plan, token
        self.log = log or (lambda message: None)
        self.clock = clock or time.monotonic
        self.deadline = self.clock() + timeout if timeout is not None else None
        self.cancelled = cancelled or (lambda: False)
        self.nodes = {self.root_id: Node(self.root_id, None, None, confirmed=True,
                                         model_verified=True, first_seen=self.clock())}
        self.last_progress = None
        self.pending_invocations = False
        self.stale_report = None
        self.collection_requested = False
        self.collection_signature = None
        self.max_active_workers = 0

    def _register(self, parent, spec, result, check_model=True):
        if not isinstance(spec, dict) or not isinstance(result, dict):
            raise NativeExecutionError("Malformed native invocation result")
        cid, role = canonical(result.get("conversationId")), spec.get("role")
        if not isinstance(role, str) or not role:
            if check_model:
                raise NativeExecutionError("Native invocation omitted its exact plan role")
            role = "(undeclared)"
        if cid == self.root_id:
            raise NativeExecutionError("A native child cannot be its own ancestor")
        existing = self.nodes.get(cid)
        if existing and existing.parent_id != parent.cid:
            raise NativeExecutionError("Native ownership or role changed")
        if existing and existing.role != role:
            if check_model:
                raise NativeExecutionError("Native ownership or role changed")
            role = existing.role
        if not existing:
            self.nodes[cid] = Node(cid, parent.cid, role, first_seen=self.clock())
            self.log(f"Observed native role {role!r}: {cid}, parent={parent.cid}")
        parent.children.add(cid)
        if check_model and spec.get("model") not in (None, self.model_id):
            raise NativeExecutionError("Native invocation selected a model other than its High parent")

    def _ingest(self, node, response):
        if not isinstance(response, dict):
            raise NativeExecutionError("Malformed native trajectory response")
        trajectory = response.get("trajectory")
        if not isinstance(trajectory, dict) or not trajectory.get("cascadeId"):
            node.terminal_success = False
            return
        if canonical(trajectory["cascadeId"]) != node.cid:
            node.confirmed = False
            raise NativeExecutionError("Native trajectory identity mismatch")
        metadata = trajectory.get("metadata", {})
        if node.parent_id:
            if metadata.get("parentConversationId") is None:
                node.terminal_success = False
                return
            if (metadata.get("parentConversationId") != node.parent_id
                    or metadata.get("rootConversationId") != self.root_id):
                node.confirmed = False
                raise NativeExecutionError("Native trajectory is outside this task's owned tree")
            node.confirmed = True
            spec = metadata.get("subagentSpec", {})
            if spec.get("model") not in (None, self.model_id):
                raise NativeExecutionError("A native descendant did not inherit the High model")
            if spec.get("modelTier") not in (None, "MODEL_TIER_INHERIT"):
                raise NativeExecutionError("A native descendant overrode model inheritance")
            node.model_verified = (spec.get("model") == self.model_id
                                   and spec.get("modelTier") == "MODEL_TIER_INHERIT")
        elif metadata.get("parentConversationId"):
            node.confirmed = False
            raise NativeExecutionError("The MCP root unexpectedly belongs to another parent")
        elif metadata.get("rootConversationId") not in (None, self.root_id):
            node.confirmed = False
            raise NativeExecutionError("Native root identity mismatch")
        node.response = response
        fingerprints = []
        for step in node.steps:
            if step.get("type") == "CORTEX_STEP_TYPE_ERROR_MESSAGE":
                raise NativeExecutionError(f"Native conversation {node.cid} reported an engine error")
            invocation = step.get("invokeSubagent", {})
            message = step.get("systemMessage", {}).get("agentMessage", {})
            fingerprints.append((step.get("type"), step.get("status"), planner_text(step),
                                 invocation.get("results"), message.get("id"),
                                 message.get("sender"), message.get("recipient")))
            if step.get("type") == INVOKE:
                specs, results = invocation.get("subagents", []), invocation.get("results", [])
                if step.get("status") not in (DONE, ERROR):
                    self.pending_invocations = True
                if step.get("status") == DONE and (not specs or not results or len(specs) != len(results)):
                    self.pending_invocations = True
                if results and len(specs) == len(results):
                    for spec, result in zip(specs, results):
                        if isinstance(result, dict) and result.get("conversationId"):
                            self._register(node, spec, result)
                elif results:
                    for result in results:
                        if isinstance(result, dict) and result.get("conversationId"):
                            self._register(node, {"role": "(unmatched native result)"}, result)
        signature = hashlib.sha256(json.dumps((response.get("status"), fingerprints),
                                              sort_keys=True).encode()).hexdigest()
        if signature != node.signature:
            node.signature, node.changed_at = signature, self.clock()
        if response.get("status") != IDLE:
            node.busy_seen = True
        terminal_steps = {DONE, ERROR, "CORTEX_STEP_STATUS_CANCELLED", "CORTEX_STEP_STATUS_CANCELED"}
        tail = node.steps[-1] if node.steps else {}
        settle = 12.0 if tail.get("type") == CHECKPOINT else 4.0
        node.terminal_success = bool(
            node.confirmed and node.model_verified and response.get("status") == IDLE
            and node.steps and all(s.get("status") in terminal_steps for s in node.steps)
            and tail.get("type") in (PLANNER, CHECKPOINT) and tail.get("status") == DONE
            and node.last_planner()[1] and self.clock() - node.changed_at >= settle)

    def _timeout(self):
        if self.cancelled():
            raise NativeExecutionError("Native workflow cancelled")
        if self.deadline is None:
            return 5.0
        remaining = self.deadline - self.clock()
        if remaining <= 0:
            raise NativeExecutionError("Native tree deadline reached before all results were joined")
        return min(5.0, remaining)

    def _structure_error(self):
        root = self.nodes[self.root_id]
        workers = {self.nodes[cid].role: self.nodes[cid] for cid in root.children}
        expected = {w["id"]: w for w in self.plan["workers"]}
        if len(workers) != len(root.children) or set(workers) != set(expected):
            return f"Expected native worker roles {sorted(expected)}, observed {sorted(workers)}"
        for role, node in workers.items():
            agents = [self.nodes[cid] for cid in node.children]
            wanted = {a["id"] for a in expected[role]["agents"]}
            if len(agents) != len(wanted) or {a.role for a in agents} != wanted:
                return f"Worker {role} did not create exactly its declared native agents"
            if any(a.children for a in agents):
                return "A native leaf created undeclared descendants"
        return None

    def observe(self, root_response):
        self.pending_invocations = False
        queue = [self.root_id]
        index = 0
        while index < len(queue):
            cid = queue[index]
            index += 1
            node = self.nodes[cid]
            try:
                response = (root_response if cid == self.root_id else
                            self.rpc("GetCascadeTrajectory", {"cascadeId": cid}, timeout=self._timeout()))
            except NativeExecutionError:
                raise
            except Exception:
                node.terminal_success = False
                continue
            self._ingest(node, response)
            if node.confirmed:
                queue.extend(child for child in node.children if child not in queue)
        complete = (all(n.terminal_success for n in self.nodes.values())
                    and not self.pending_invocations)
        structure_error = self._structure_error()
        if structure_error:
            if complete and all(self.clock() - n.changed_at >= 12.0 for n in self.nodes.values()):
                raise NativeExecutionError(structure_error)
            complete = False
        root = self.nodes[self.root_id]
        terminal_steps = {DONE, ERROR, "CORTEX_STEP_STATUS_CANCELLED", "CORTEX_STEP_STATUS_CANCELED"}
        descendants_active = any(
            not n.confirmed or not n.model_verified or n.response.get("status") != IDLE
            or not n.last_planner()[1]
            or any(s.get("status") not in terminal_steps for s in n.steps)
            for cid, n in self.nodes.items() if cid != self.root_id)
        if descendants_active and '"native_completion"' in root.last_planner()[1]:
            self.stale_report = root.last_planner()
        active_workers = sum(self.nodes[cid].confirmed
                             and self.nodes[cid].response.get("status") not in (None, IDLE)
                             for cid in root.children)
        self.max_active_workers = max(self.max_active_workers, active_workers)
        progress = (len(self.nodes) - 1,
                    sum(n.terminal_success for cid, n in self.nodes.items() if cid != self.root_id))
        if progress != self.last_progress:
            self.last_progress = progress
            self.log(f"Native descendants observed={progress[0]}, terminal-success={progress[1]}, "
                     f"active-worker-peak={self.max_active_workers}")
        return complete

    def observed(self):
        return {cid: {"parent_id": n.parent_id, "role": n.role,
                      "terminal_success": n.terminal_success,
                      "engine_status": n.response.get("status"),
                      "model_verified": n.model_verified, "busy_seen": n.busy_seen,
                      "model_id": (self.model_id if cid == self.root_id else
                                   n.response.get("trajectory", {}).get("metadata", {})
                                   .get("subagentSpec", {}).get("model")),
                      "model_tier": ("parent" if cid == self.root_id else
                                     n.response.get("trajectory", {}).get("metadata", {})
                                     .get("subagentSpec", {}).get("modelTier")),
                      "first_seen": n.first_seen}
                for cid, n in self.nodes.items()}

    def _root_received_results(self):
        root = self.nodes[self.root_id]
        received = {}
        for index, step in enumerate(root.steps):
            message = step.get("systemMessage", {}).get("agentMessage", {})
            if (message.get("sender") in root.children
                    and message.get("recipient") == self.root_id):
                received[message["sender"]] = index
        return (set(received) == root.children
                and root.last_planner()[0] > max(received.values(), default=-1))

    def validate_final(self):
        """Called only after graph/engine/settle checks passed in this poll."""
        if self.cancelled():
            raise NativeExecutionError("Native workflow cancelled")
        root = self.nodes[self.root_id]
        current = root.last_planner()
        if self.collection_requested and current == self.collection_signature:
            return None
        error = None
        report = None
        try:
            if current == self.stale_report:
                error = "The completion report was produced while descendants were still active"
            elif not self._root_received_results():
                error = "The parent has not received and answered every worker's result message"
            else:
                report = validate_report(current[1], self.plan, self.token,
                                         self.root_id, self.observed())
                if report is None:
                    error = "The parent has not produced its final native completion report"
        except NativeCompletionError as exc:
            error = str(exc)
        if not error:
            return report
        if self.collection_requested:
            raise NativeExecutionError(error)
        prompt = (
            "All declared native descendants are now observed idle and completed. "
            "Collect each worker's actual result message in THIS existing parent, "
            "request any missing final reports from your existing workers, and return "
            "the required native_completion JSON. Do not create new workers or agents. "
            f"Completion token: {self.token}; parent_id: {self.root_id}. "
            f"Observed native IDs/roles/parents: {json.dumps(self.observed())}. "
            f"Correction needed: {error}")
        self.rpc("SendUserCascadeMessage", {
            "cascadeId": self.root_id, "items": [{"text": prompt}],
            "cascadeConfig": {"plannerConfig": {"requestedModel": {"model": self.model_id}}}
        }, timeout=self._timeout())
        self.collection_requested = True
        self.collection_signature = current
        self.log("Collecting final native results in the existing parent conversation")
        return None

    def cleanup(self):
        """Cancel and verify only ownership-confirmed members of this task's tree."""
        queue = list(self.nodes)
        visited, outcomes = set(), {}
        while queue:
            cid = queue.pop(0)
            if cid in visited:
                continue
            visited.add(cid)
            node = self.nodes[cid]
            if node.parent_id and not self.nodes[node.parent_id].confirmed:
                outcomes[cid] = False
                continue
            for phase in ("before", "after"):
                try:
                    response = self.rpc("GetCascadeTrajectory", {"cascadeId": cid}, timeout=2.0)
                    trajectory = response.get("trajectory", {})
                    metadata = trajectory.get("metadata", {})
                    identity_ok = trajectory.get("cascadeId") == cid
                    ownership_ok = ((cid == self.root_id
                                     and metadata.get("parentConversationId") is None
                                     and metadata.get("rootConversationId") in (None, self.root_id)) or
                                    (metadata.get("parentConversationId") == node.parent_id
                                     and metadata.get("rootConversationId") == self.root_id))
                    if not (identity_ok and ownership_ok):
                        node.confirmed = False
                        outcomes[cid] = False
                        break
                    node.confirmed = True
                    for step in trajectory.get("steps", []):
                        if step.get("type") != INVOKE:
                            continue
                        invocation = step.get("invokeSubagent", {})
                        specs, results = invocation.get("subagents", []), invocation.get("results", [])
                        for index, result in enumerate(results):
                            if not isinstance(result, dict) or not result.get("conversationId"):
                                continue
                            spec = specs[index] if len(specs) == len(results) else {}
                            self._register(node, spec, result, check_model=False)
                    queue.extend(child for child in node.children if child not in visited)
                    if phase == "before":
                        self.rpc("CancelCascadeInvocation", {"cascadeId": cid}, timeout=2.0)
                    else:
                        outcomes[cid] = response.get("status") == IDLE
                except Exception:
                    outcomes[cid] = False
                    if phase == "before" and node.confirmed:
                        try:
                            self.rpc("CancelCascadeInvocation", {"cascadeId": cid}, timeout=2.0)
                        except Exception:
                            pass
            # A failed verification never authorizes following unconfirmed nodes.
        if self.nodes[self.root_id].confirmed:
            try:
                self.rpc("CancelCascadeInvocation", {"cascadeId": self.root_id}, timeout=2.0)
                final = self.rpc("GetCascadeTrajectory", {"cascadeId": self.root_id}, timeout=2.0)
                outcomes[self.root_id] = final.get("status") == IDLE
            except Exception:
                outcomes[self.root_id] = False
        self.log(f"Native cleanup verified={bool(outcomes) and all(outcomes.values())}; states={outcomes}")
        return outcomes
