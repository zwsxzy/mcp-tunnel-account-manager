"""Validate a parent's final report against an observed native conversation tree."""
from __future__ import annotations

import json
import re
import uuid


class NativeCompletionError(ValueError):
    pass


def _conversation_id(value):
    if not isinstance(value, str):
        raise NativeCompletionError("Conversation IDs must be UUID strings")
    try:
        parsed = str(uuid.UUID(value))
    except ValueError as exc:
        raise NativeCompletionError("Invalid conversation ID") from exc
    if value.casefold() != parsed:
        raise NativeCompletionError("Use canonical conversation IDs")
    return parsed


def extract_report(text):
    """Accept JSON directly or in a JSON fence; prose is not a completion report."""
    candidates = [text.strip()]
    candidates += re.findall(r"```(?:json)?\s*([\s\S]*?)```", text, re.IGNORECASE)
    for candidate in reversed(candidates):
        try:
            data = json.loads(candidate)
        except (ValueError, TypeError):
            continue
        if isinstance(data, dict) and "native_completion" in data:
            report = data["native_completion"]
            if not isinstance(report, dict):
                raise NativeCompletionError("native_completion must be an object")
            return report
    return None


def validate_report(text, plan, token, parent_id, observed):
    """Return a valid report or None; declared IDs must match observed ownership.

    observed maps each owned conversation ID to a record containing parent_id,
    role, and terminal_success. The runtime adapter must establish those fields
    from native invocation results and engine state, not from model prose.
    """
    report = extract_report(text)
    if report is None:
        return None
    root = _conversation_id(parent_id)
    if report.get("token") != token or report.get("parent_id") != root:
        raise NativeCompletionError("Native completion token or parent mismatch")
    if report.get("status") != "completed":
        raise NativeCompletionError("Native work was not reported completed")
    workers = report.get("workers")
    if not isinstance(workers, list) or len(workers) != len(plan["workers"]):
        raise NativeCompletionError("Wrong number of reported native workers")
    seen = {root}
    expected = {w["id"]: w for w in plan["workers"]}
    logical_seen = set()

    def check_node(row, ident, owner):
        if not isinstance(row, dict) or row.get("id") != ident:
            raise NativeCompletionError("Wrong logical task ID")
        cid = _conversation_id(row.get("conversation_id"))
        if cid in seen:
            raise NativeCompletionError("A conversation cannot implement multiple tasks")
        seen.add(cid)
        if row.get("parent_id") != owner or row.get("status") != "completed":
            raise NativeCompletionError("Wrong reported parent or terminal state")
        actual = observed.get(cid)
        if not actual or actual.get("parent_id") != owner:
            raise NativeCompletionError("Reported conversation is not an observed owned child")
        if actual.get("role") != ident:
            raise NativeCompletionError("Observed native role does not match its task")
        if not actual.get("terminal_success"):
            raise NativeCompletionError("An actual native task is not terminal-successful")
        return cid

    for worker in workers:
        if not isinstance(worker, dict):
            raise NativeCompletionError("Worker report must be an object")
        ident = worker.get("id")
        if not isinstance(ident, str) or ident not in expected or ident in logical_seen:
            raise NativeCompletionError("Unknown or duplicate worker ID")
        logical_seen.add(ident)
        wid = check_node(worker, ident, root)
        agents = worker.get("agents")
        wanted = {a["id"] for a in expected[ident]["agents"]}
        if not isinstance(agents, list) or len(agents) != len(wanted):
            raise NativeCompletionError("Wrong number of native agents")
        agent_seen = set()
        for agent in agents:
            aid = agent.get("id") if isinstance(agent, dict) else None
            if not isinstance(aid, str) or aid not in wanted or aid in agent_seen:
                raise NativeCompletionError("Unknown or duplicate agent ID")
            agent_seen.add(aid)
            check_node(agent, aid, wid)
            if "result" not in agent or agent["result"] is None:
                raise NativeCompletionError("A native agent report omitted its actual result")
            value = agent["result"]
            if ((isinstance(value, str) and value.lstrip().startswith("MCP_GPT_INTERVENTION:"))
                    or (isinstance(value, dict) and value.get("gpt_intervention"))):
                raise NativeCompletionError("A native agent requested GPT intervention; it is not successful work")
    if seen != set(observed):
        raise NativeCompletionError("Unreported or unexpected native conversations")
    return report


NATIVE_INSTRUCTIONS = """\
Execute GPT's immutable JSON plan with genuine native agents in ONE parent.
Use unique native type names for this run and for each worker/leaf. Do not share
or overwrite a mutable type definition between independent workers.
For each declared worker define a native type with EnableSubagentTools=true,
EnableMCPTools=false, and EnableWriteTools only for declared output scopes.
Define ALL worker types first, then launch ALL workers asynchronously in one
batch of native calls when possible, before any wait or collection. Set Role to the
worker's exact plan id, Model='inherit', and Workspace='inherit'. Each worker
receives its ENTIRE declared worker JSON, including all agents and scopes,
and the runtime root parent_id. After collecting all its children it sends
the final report to that root UUID with native send_message. Each worker
defines ALL its leaf types first, then invokes every declared leaf before waiting,
with Role set to that leaf's exact id,
Model='inherit', Workspace='inherit', EnableSubagentTools=false, MCP tools off,
and write tools enabled only for declared outputs. Enable* flags are arguments
to define_subagent, not invoke_subagent. There is no fixed three-worker cap.
Do not read peer outputs, alter the agreed interfaces, or simulate multiple
agents as serial roles. Resolve filesystem paths and aliases before starting;
reject access outside the authorized workspace and overlapping ownership.
Workers collect their own children's actual terminal statuses and results and
report them to the parent; the parent collects every worker and all leaf IDs.
Do not spin in a model-side status loop. You may yield an interim awaiting
message while real native descendants run: the MCP bridge keeps the job open.
Resume on native completion messages, collect results, and report success only
after all owned descendants have actually completed. On failure report it and
clean up unfinished owned children. Never invent conversation IDs or statuses.
The final response must contain ONE JSON object native_completion, with:
token (the runtime completion token), parent_id (the runtime parent UUID),
status='completed', and workers=[{id, conversation_id, parent_id, status,
agents:[{id, conversation_id, parent_id, status, result}]}]. Every status is
'completed'; worker parent_id is the root UUID and leaf parent_id its worker
UUID. Use exact plan IDs and actual native invocation conversation IDs.
You may include output/artifact/verification fields and results. Do not emit
this final completion object while work is awaiting, failed or incomplete.
"""


def runtime_instructions(token, parent_id):
    return ("\nNative runtime completion token: " + token
            + "\nNative runtime parent_id: " + parent_id
            + "\nReturn the final native_completion object only after collecting all real results.\n")
