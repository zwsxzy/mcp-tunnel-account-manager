"""Validate GPT plans before the MCP creates a native worker tree."""
from __future__ import annotations
import json
import ntpath

PREFIX = "Execute this GPT-approved independent task plan:\n"
HIGH_MODEL = "Gemini 3.8 Flash (High)"

NATIVE_HOST_INSTRUCTIONS = """\
Default model: Gemini 3.8 Flash (High). GPT owns planning and final review.
For substantial implementation, GPT first fixes the core design, immutable
inputs, interfaces and acceptance criteria, then prepares independent tasks.
Use exactly ONE dispatch_gemini_agent call for the reviewed worker tree.
Its task must begin exactly 'Execute this GPT-approved independent task plan:'
followed by a newline and the JSON object {core_plan, workers}.
Each worker has id, objective, inputs, outputs, depends_on: [], agents.
Each agent has id, objective, inputs, outputs, depends_on: []. Each worker
requires at least two genuine agents; the worker count is the plan length,
with no fixed three-worker cap. Use workspace-relative paths and disjoint
write scopes; no peer-output reads or execution dependencies are allowed.
The MCP validates this contract before launching. The parent model must be
Gemini 3.8 Flash (High), descendants inherit it, and real native IDs/states
plus the final completion report are checked before the job succeeds.
Poll check_agent_job while waiting; an interim awaiting reply is not success.
Administrative diagnostics may use ordinary task text without a worker tree.
"""

class PlanValidationError(ValueError):
    pass

def normalize_path(value, case_fold=False):
    if not isinstance(value, str) or not value.strip() or value != value.strip():
        raise PlanValidationError("Paths must be nonempty strings without surrounding whitespace")
    if any(ord(c) < 32 for c in value) or any(c in value for c in '*?<>|"'):
        raise PlanValidationError(f"Invalid path: {value!r}")
    if ntpath.splitdrive(value)[0] or ntpath.isabs(value) or ":" in value:
        raise PlanValidationError("Use paths relative to the authorized workspace")
    parts = value.replace("\\", "/").split("/")
    reserved = {"con", "prn", "aux", "nul"} | {f"{p}{n}" for p in ("com", "lpt") for n in range(1, 10)}
    for part in parts:
        if part in (".", "..") or part.endswith((".", " ")):
            raise PlanValidationError(f"Ambiguous or traversing path: {value!r}")
        if part.split(".", 1)[0].casefold() in reserved:
            raise PlanValidationError(f"Reserved Windows path: {value!r}")
    normalized = ntpath.normpath(value).replace("\\", "/")
    return normalized.casefold() if case_fold else normalized

def case_fold_path(value):
    return normalize_path(value, case_fold=True)

def _covers(parent, child):
    parent, child = parent.casefold(), child.casefold()
    return child == parent or child.startswith(parent + "/")

def _overlap(left, right):
    return _covers(left, right) or _covers(right, left)

def _text(value, name):
    if not isinstance(value, str) or not value.strip():
        raise PlanValidationError(f"{name} must be a nonempty string")
    return value.strip()

def _independent(nodes):
    for index, left in enumerate(nodes):
        for right in nodes[index + 1:]:
            for writer, other in ((left, right), (right, left)):
                if any(_overlap(out, path) for out in writer["outputs"]
                       for path in other["outputs"] + other["inputs"]):
                    raise PlanValidationError(f"Coupled paths: {left['id']} and {right['id']}")

def validate_plan(plan):
    if not isinstance(plan, dict) or set(plan) != {"core_plan", "workers"}:
        raise PlanValidationError("Plan requires exactly core_plan and workers")
    core = _text(plan["core_plan"], "core_plan")
    if not isinstance(plan["workers"], list) or not plan["workers"]:
        raise PlanValidationError("workers must be a nonempty list")
    identifiers = set()

    def node(source, worker=False):
        keys = {"id", "objective", "inputs", "outputs", "depends_on"} | ({"agents"} if worker else set())
        if not isinstance(source, dict) or set(source) != keys:
            raise PlanValidationError(f"Invalid {'worker' if worker else 'agent'} fields")
        ident = _text(source["id"], "id")
        if ident.casefold() in identifiers:
            raise PlanValidationError(f"Duplicate task ID: {ident}")
        identifiers.add(ident.casefold())
        if not isinstance(source["depends_on"], list) or source["depends_on"]:
            raise PlanValidationError(f"Dependencies are not allowed: {ident}")
        result = {"id": ident, "objective": _text(source["objective"], "objective"), "depends_on": []}
        for field in ("inputs", "outputs"):
            if not isinstance(source[field], list):
                raise PlanValidationError(f"{ident}.{field} must be a list")
            result[field] = [normalize_path(path) for path in source[field]]
            if len({path.casefold() for path in result[field]}) != len(result[field]):
                raise PlanValidationError(f"Duplicate paths in {ident}.{field}")
        if worker:
            if not isinstance(source["agents"], list) or len(source["agents"]) < 2:
                raise PlanValidationError(f"{ident} requires at least two independent agents")
            result["agents"] = [node(agent) for agent in source["agents"]]
            for agent in result["agents"]:
                for field, allowed in (("inputs", result["inputs"] + result["outputs"]),
                                       ("outputs", result["outputs"])):
                    if any(not any(_covers(parent, path) for parent in allowed) for path in agent[field]):
                        raise PlanValidationError(f"{agent['id']}.{field} exceeds its worker scope")
            _independent(result["agents"])
        return result

    workers = [node(source, worker=True) for source in plan["workers"]]
    _independent(workers)
    return {"core_plan": core, "workers": workers}

def parse_native_task(task):
    if not isinstance(task, str) or not task.startswith(PREFIX):
        return None
    try:
        plan = json.loads(task[len(PREFIX):])
    except (ValueError, TypeError) as exc:
        raise PlanValidationError(f"Invalid native plan JSON: {exc}") from exc
    return validate_plan(plan)
