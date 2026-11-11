"""Validate GPT's independent multi-parent plan before creating any IDE work."""
from __future__ import annotations

import json

from .native_plan import (HIGH_MODEL, PlanValidationError, _covers, _independent,
                          _text, normalize_path, validate_plan)

FOREST_PREFIX = "Execute this GPT-approved independent multi-parent plan:\n"

FOREST_HOST_INSTRUCTIONS = """\
Default project workflow: GPT plans and reviews; Gemini 3.8 Flash (High) executes.
GPT fixes the core design, immutable inputs, interfaces and acceptance criteria,
then prepares independent parent groups, workers and leaf tasks. Submit ONE
dispatch_gemini_agent with task beginning exactly
'Execute this GPT-approved independent multi-parent plan:'
followed by a newline and JSON {core_plan, parents}.
Each parent has id, objective, inputs, outputs, depends_on: [], workers.
Each worker has id, objective, inputs, outputs, depends_on: [], agents.
Each leaf has id, objective, inputs, outputs, depends_on: []. Use at least two
independent parents, at least two workers per parent and at least two agents per
worker. Actual counts come from the independent tasks; there are no fixed two-
agent or three-worker/parent caps. Shared immutable read-only inputs are allowed;
all sibling writes must be disjoint and cannot be peer inputs. GPT resolves
semantic dependencies before execution and integrates results afterward.
The MCP creates separate genuine root conversations on ONE pinned Antigravity
IDE endpoint. Each root sees only its own assignment and owns its native workers
and their agents. All roots use High; descendants inherit High. Runtime metadata,
real native IDs, ownership and terminal results are validated before success.
GPT is the host planner; the MCP does not start an additional GPT service.
Ordinary questions and administrative diagnostics may execute directly.
Legacy single-parent plans remain an explicit compatibility path only.
"""


def validate_forest(plan):
    if not isinstance(plan, dict) or set(plan) != {"core_plan", "parents"}:
        raise PlanValidationError("Multi-parent plan requires exactly core_plan and parents")
    core = _text(plan["core_plan"], "core_plan")
    if not isinstance(plan["parents"], list) or len(plan["parents"]) < 2:
        raise PlanValidationError("parents must contain at least two independent parent groups")
    parents, identifiers = [], set()
    all_workers = []
    for source in plan["parents"]:
        keys = {"id", "objective", "inputs", "outputs", "depends_on", "workers"}
        if not isinstance(source, dict) or set(source) != keys:
            raise PlanValidationError("Invalid parent fields")
        ident = _text(source["id"], "id")
        if ident.casefold() in identifiers:
            raise PlanValidationError("Duplicate parent ID")
        identifiers.add(ident.casefold())
        if not isinstance(source["depends_on"], list) or source["depends_on"]:
            raise PlanValidationError("Dependencies between parent groups are not allowed")
        parent = {"id": ident, "objective": _text(source["objective"], "objective"),
                  "depends_on": []}
        for field in ("inputs", "outputs"):
            if not isinstance(source[field], list):
                raise PlanValidationError(f"{ident}.{field} must be a list")
            paths = [normalize_path(path) for path in source[field]]
            if len({p.casefold() for p in paths}) != len(paths):
                raise PlanValidationError(f"Duplicate paths in {ident}.{field}")
            parent[field] = paths
        if not isinstance(source["workers"], list) or len(source["workers"]) < 2:
            raise PlanValidationError(f"{ident} requires at least two independent workers")
        normalized = validate_plan({"core_plan": core, "workers": source["workers"]})
        parent["workers"] = normalized["workers"]
        for worker in parent["workers"]:
            for field, allowed in (("inputs", parent["inputs"] + parent["outputs"]),
                                   ("outputs", parent["outputs"])):
                if any(not any(_covers(path, item) for path in allowed)
                       for item in worker[field]):
                    raise PlanValidationError(f"{worker['id']}.{field} exceeds parent scope")
        parents.append(parent)
        all_workers.extend(parent["workers"])
    # Validate all workers together, including cross-parent IDs and access conflicts.
    validate_plan({"core_plan": core, "workers": all_workers})
    for worker in all_workers:
        for node in (worker, *worker["agents"]):
            if node["id"].casefold() in identifiers:
                raise PlanValidationError("Parent, worker and agent IDs must be globally unique")
    _independent(parents)
    return {"core_plan": core, "parents": parents}


def parse_forest_task(task):
    if not isinstance(task, str) or not task.startswith(FOREST_PREFIX):
        return None
    try:
        plan = json.loads(task[len(FOREST_PREFIX):])
    except (ValueError, TypeError) as exc:
        raise PlanValidationError(f"Invalid multi-parent JSON: {exc}") from exc
    return validate_forest(plan)


def parent_plan(forest, parent):
    return {"core_plan": forest["core_plan"] + "\nIndependent parent assignment: "
            + json.dumps({key: parent[key] for key in
                          ("id", "objective", "inputs", "outputs", "depends_on")},
                         ensure_ascii=False)
            + "\nOperate only this assignment. Report results within this root tree; "
              "GPT collects all independent root results outside the IDE.",
            "workers": parent["workers"]}
