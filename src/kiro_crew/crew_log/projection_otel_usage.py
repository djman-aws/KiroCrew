"""A session's own OTel usage facts: which agent kind opened it, and who started each
turn -- the SESSION-keyed fold the OTel export subscribes to turn into counters.

WHY A SEPARATE FOLD RATHER THAN READING ``status`` OR ``usage``. Those folds' renders
carry fields this export must never pass to an attribute -- ``status`` keeps ``owner``,
``slot`` and ``cwd`` (``projection_side_panel.py``'s ``_status_render``); ``usage``
keeps per-turn context detail no closed enum describes. Reading them and "picking out"
the safe fields is a boundary a later edit to either fold could silently break. This
fold reads the two raw entry types directly and keeps nothing but small counts, so its
own render is already the shape the export may emit.

WHAT THIS FOLD IS NOT. Not advertised to the side panel (nothing draws it) and not
pushed by the growth feed -- it is registered the way ``class`` is, in
``INTERNAL_PROJECTION_NAMES``, so it shares the eager worker's one pass over a unit's
file without shipping a frame per turn to every owner socket for a reader that is not a
browser.

THE COUNTS ARE CUMULATIVE OVER THE SESSION, NOT A ONE-SHOT EVENT. ``turn/started`` can
land many times in one session's life, and each commit publishes its own
``FoldAdvanced`` for this fold on the crew-log bus (``kiro_crew.crew_log.bus``). The OTel
subscriber (``kiro_crew.metrics.crew_log_export``) is the one that turns a rendered
total into a counter delta, by remembering the LAST total it exported per (session,
field) and adding only the difference -- which is what makes this fold's own state safe
to describe as "a few numbers, step adds one": nothing here decides what reaches an
instrument, it only counts what happened in this unit's own file.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final

from kiro_crew.crew_log.projection_values import _as_int
from kiro_crew.crew_log.schema import Entry

#: This fold's registry name. Spelled out here, the way ``DASHBOARD_FOLD_NAME`` is
#: spelled in ``entry_types_surfaces.py``, so the registry and the export module import
#: one constant instead of a literal each could drift from.
OTEL_USAGE_FOLD_NAME: Final[str] = "otel_usage"

#: The two entry types this fold answers to. ``session/opened`` fires once per unit;
#: ``turn/started`` fires once per turn. Both are declared, required fields on their
#: types (``entry_types_lifecycle.py``), so a line missing either is a damaged or
#: planted entry and is skipped the way every fold in this package skips one.
SESSION_OPENED_TYPE: Final[str] = "session/opened"
TURN_STARTED_TYPE: Final[str] = "turn/started"

#: Entry types this fold's ``step`` can move. Spelled out, as the registry's own
#: docstring requires of an eager fold: a fold that is woken by type and narrows its own
#: set must say which.
OTEL_USAGE_TYPES: Final[frozenset[str]] = frozenset({SESSION_OPENED_TYPE, TURN_STARTED_TYPE})


def _otel_usage_start() -> dict[str, Any]:
    """One session's usage facts: whether it opened, and turns by actor.

    ``opened_agent`` is the RAW agent name off ``session/opened.agent`` -- this fold
    keeps it whole because this module must not decide the closed ``agent_kind``
    vocabulary (that is ``agent_files.OWNED_KIRO_AGENT_FILES`` plus the crewmate-slot
    check, both outside the crew-log package); the export subscriber folds it to the
    closed set right before it touches an attribute, and nothing here retains the name
    past one session's own state. ``turns`` is keyed by the entry's OWN closed
    ``actor`` value (``ACTOR_VALUES``, 8 members), so this fold adds no vocabulary of
    its own for that half.

    ``opened_ts`` is the ``session/opened`` entry's OWN timestamp (``Entry.time``,
    epoch ms off the log), so it folds to the same value on every replay and is a
    number, not an id -- it keeps this fold's "only fixed numbers" contract. The export
    subscriber reads it to tell a session OPENED after this process began exporting (a
    genuinely new session, whose opening it should count once) from one whose opening
    predates this process (a resumed session, which it must not re-count). ``0`` until
    the opening entry is folded.
    """
    return {"opened": False, "opened_agent": "", "opened_ts": 0, "turns": {}}


def _otel_usage_step(state: dict[str, Any], entry: Entry) -> None:
    if entry.type == SESSION_OPENED_TYPE:
        if state["opened"]:
            # A re-attach to an existing crew log (``resumed=True``) still carries
            # ``session/opened`` with the SAME agent the unit was created with -- this
            # fold counts the unit's opening once, not once per claim that reattaches to
            # it, so a second one is skipped rather than double-opening the state.
            return
        agent = entry.data.get("agent")
        state["opened"] = True
        state["opened_agent"] = agent if isinstance(agent, str) else ""
        # The opening entry's own timestamp, off the log, so a replay folds the same
        # value. The subscriber compares it to when this process began exporting.
        state["opened_ts"] = _as_int(getattr(entry, "time", 0))
        return
    if entry.type == TURN_STARTED_TYPE:
        actor = entry.data.get("actor")
        if not isinstance(actor, str) or not actor:
            # The writer clamps ``actor`` into the closed set before it ever reaches
            # the log (``entry_types.py``'s module docstring), so a line with no
            # string here is a damaged or planted entry -- skipped, not counted.
            return
        turns: dict[str, int] = state["turns"]
        turns[actor] = _as_int(turns.get(actor)) + 1
        return


def _otel_usage_render(state: dict[str, Any]) -> dict[str, Any]:
    """This session's usage facts, as the fixed shape the export subscriber reads.

    ``turns`` is copied rather than handed out live: the export subscriber keeps its
    own last-seen copy per session across separate ``FoldAdvanced`` deliveries, and a
    shared dict would let this fold's next ``step`` mutate a snapshot the subscriber
    has not yet compared against.
    """
    turns: Mapping[str, int] = state["turns"]
    return {
        "opened": bool(state.get("opened")),
        "opened_agent": str(state.get("opened_agent") or ""),
        "opened_ts": _as_int(state.get("opened_ts")),
        "turns": {actor: _as_int(count) for actor, count in turns.items()},
    }


def _otel_usage_copy(state: dict[str, Any]) -> dict[str, Any]:
    """*state* copied one level deep -- the only container ``step`` reaches into is
    ``turns``, so a shallow copy of it is enough to keep ``step`` off the original.
    """
    return {
        "opened": state.get("opened", False),
        "opened_ts": state.get("opened_ts", 0),
        "opened_agent": state.get("opened_agent", ""),
        "turns": dict(state.get("turns") or {}),
    }


def _otel_usage_rows(state: Mapping[str, Any]) -> int:
    """This is a SESSION-keyed fold (no warm slot cell), so nothing here charges a
    slot budget; kept for symmetry with the slot folds' own row counters and to make a
    future re-key of this fold fail loudly instead of silently charging a constant.
    """
    turns = state.get("turns")
    return len(turns) if isinstance(turns, dict) else 0
