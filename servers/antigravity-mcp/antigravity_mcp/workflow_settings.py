"""Load the current MCP service's persistent collaboration preferences."""
from __future__ import annotations

import json
from pathlib import Path

from .paths import state_file

HIGH_MODEL = "Gemini 3.8 Flash (High)"
POLICY_NAME = "workflow_settings.json"


def policy_path():
    return Path(state_file(POLICY_NAME))


def load_workflow_settings(path=None):
    target = Path(path) if path is not None else policy_path()
    if not target.exists():
        target = Path(__file__).with_name(POLICY_NAME)
    try:
        value = json.loads(target.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"Cannot load Gemini MCP workflow settings: {exc}") from exc
    expected = {
        "default_model": HIGH_MODEL,
        "planner": "gpt",
        "mode": "native_multi_parent",
        "max_parents": None,
        "min_workers_per_parent": 2,
        "max_workers": None,
        "min_agents_per_worker": 2,
        "max_agents_per_worker": None,
        "single_parent_conversation": False,
        "same_ide": True,
        "subagent_model": "inherit",
        "independent_tasks_required": True,
        "require_all_terminal_results": True,
    }
    if not isinstance(value, dict) or set(value) != set(expected):
        raise ValueError("Invalid Gemini MCP workflow settings fields")
    for key, required in expected.items():
        actual = value[key]
        if type(actual) is not type(required) or actual != required:
            raise ValueError(f"Invalid workflow setting {key!r}; expected {required!r}")
    return value


ORCHESTRATOR_INSTRUCTIONS = """\
Default collaboration model: Gemini 3.8 Flash (High), loaded from this MCP's
workflow_settings.json. An explicit model argument remains an explicit override.
GPT owns the core design, fixed interfaces, immutable inputs, acceptance criteria,
task decomposition and final review. For substantial implementation work, GPT
must first prepare mutually independent work packages and validate their declared
inputs and outputs. Each package and each of its child tasks has depends_on=[],
disjoint writes, and no reads of peer outputs. Shared fixed read-only inputs are
allowed. Resolve semantic dependencies before dispatch; integration occurs after
the independent tasks finish.
Execute the plan through ONE top-level dispatch with multiple independent root
conversations on ONE Antigravity IDE endpoint. Each root owns multiple native
workers. Parent, worker and agent counts come from the reviewed plan; there are
no fixed two-agent or three-worker/parent caps. The separate top-level MCP job
queue controls task groups. Each worker creates at least two genuine native agents
with independent responsibilities. Use define_subagent/invoke_subagent, never a
serial simulation of roles. EnableSubagentTools belongs to define_subagent; enable
it on workers so they can create their own agents. Native descendants use
Model='inherit' from the High parent and Workspace='inherit'.
Every worker collects its children's actual terminal states and results; the
parent collects every worker's terminal state and results. Returning 'awaiting'
or assigning logical conversation IDs does not prove completion. Report missing
results and failed verification as incomplete. Read-only administrative probes
and configuration maintenance may run directly without spawning a worker tree.
Review agent output before applying changes.
"""


DEFAULT_AGENT_INSTRUCTIONS = """\
You assist GPT, which owns the core plan, interfaces, decomposition and review.
For substantial implementation, GPT submits its reviewed multi-parent plan to
the MCP. The backend creates multiple independent roots on the same IDE, each
with multiple native workers and a task-sized set of agents per worker. Within
your root execute ONLY its assigned immutable packages; do not create other roots.
Descendants inherit the High parent model. Do not impose fixed worker or agent
caps, simulate agents as serial roles, or read peer outputs. Collect actual
terminal results before claiming success. If the task lacks the necessary fixed
plan/interfaces, ask GPT for the missing plan instead of inventing coupled tasks.
Administrative diagnostics may execute directly. Report unverified native
lifecycle behavior explicitly; a prompt is not a lifecycle implementation.
"""
