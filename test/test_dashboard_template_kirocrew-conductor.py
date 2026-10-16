"""Static checks for the built-in Mate task board."""

from __future__ import annotations

import json
import re
from pathlib import Path

from kiro_crew.dashboard_templates import catalog
from kiro_crew.dashboard_templates.manifest import load_template

ROOT = Path(__file__).resolve().parents[1]
DIRECTORY = ROOT / "src/kiro_crew/dashboard_templates/builtin/kirocrew-conductor"
GOAL_BOARD = ROOT / "src/kiro_crew/dashboard_templates/builtin/goal-board/manifest.json"

HTML_SINKS = (
    "innerHTML",
    "outerHTML",
    "insertAdjacentHTML",
    "document.write",
    "createContextualFragment",
    "parseFromString",
    "setHTMLUnsafe",
    "parseHTMLUnsafe",
    "srcdoc",
)


def _source() -> str:
    return (DIRECTORY / "template.html").read_text(encoding="utf-8")


def _style() -> str:
    return _source().split("<style>")[1].split("</style>")[0]


def _script() -> str:
    return _source().split("<script>")[1].split("</script>")[0]


def _fields() -> dict[str, dict[str, object]]:
    raw = json.loads((DIRECTORY / "manifest.json").read_text(encoding="utf-8"))
    return dict(raw["fields"])


def test_the_registry_serves_it_under_the_conductors_slug() -> None:
    entry = catalog.load_one("kirocrew-conductor")
    manifest, _ = load_template(DIRECTORY)
    assert entry.id == manifest.id == "kirocrew-conductor"


def test_the_board_is_bound_to_the_work_fold_the_way_goal_board_binds_it() -> None:
    goal_board = json.loads(GOAL_BOARD.read_text(encoding="utf-8"))["fields"]
    fields = _fields()
    for name in ("goal", "round", "last_entry_at", "items", "omitted", "forgotten"):
        assert fields[name]["source"] == goal_board[name]["source"], name


def test_needs_you_is_the_only_field_the_conductor_writes() -> None:
    fields = _fields()
    agentic = sorted(name for name, field in fields.items() if field["source"] == {"agentic": True})
    assert agentic == ["needs_you"]
    assert fields["needs_you"]["type"] == "array"


def test_chat_notes_keep_their_old_bindings_but_are_never_rendered() -> None:
    fields = _fields()
    source = _source()
    assert fields["note"]["source"] == {"fold": "panel", "path": "data"}
    assert fields["note_at"]["source"] == {"fold": "panel", "path": "published_at"}
    assert '<span data-dashboard-field="note" hidden>' in source
    assert '<span data-dashboard-field="note_at" hidden>' in source
    assert "bag().note" not in source


def test_needs_you_precedes_goal_and_closed_task_details() -> None:
    source = _source()
    action = source.index('id="cb-you"')
    goal = source.index('class="overview"')
    details = source.index('id="cb-details"')
    assert action < goal < details
    assert re.search(r'<details id="cb-details">\s*<summary>', source)
    start = source.index('<details id="cb-details"')
    assert " open" not in source[start : start + 80]


def test_task_summaries_are_not_rendered() -> None:
    script = _script()
    assert "it.summary" not in script
    assert "summary" not in script
    assert "tone(it)[0] !== 'you'" in script


def test_no_value_reaches_the_dom_as_markup() -> None:
    source = _source()
    for sink in HTML_SINKS:
        assert sink not in source, sink


def test_the_one_host_message_only_fills_the_chat_box() -> None:
    script = _script()
    assert re.findall(r"type:\s*'([\w:-]+)'", script) == ["kirocrew-dashboard:act"]
    assert script.count("postMessage(") == 1
    for banned in ("fetch(", "XMLHttpRequest", "WebSocket", "window.open", "href"):
        assert banned not in script, banned


def test_mate_words_have_a_short_source_label() -> None:
    script = _script()
    assert "a.indexOf(name) !== -1" in script
    assert "written('needs_you')" in script
    assert "from Mate" in script
    assert "Nothing sends until" not in script


def test_progress_has_an_accessible_native_meter() -> None:
    script = _script()
    for name in ("role", "aria-label", "aria-valuemin", "aria-valuemax", "aria-valuenow"):
        assert f"track.setAttribute('{name}'" in script


def test_reduced_motion_stops_every_animation_and_transition() -> None:
    match = re.search(
        r"@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{(.*?)\}\s*\}",
        _style(),
        re.DOTALL,
    )
    assert match, "no prefers-reduced-motion block"
    rule = match.group(1)
    for selector in (".cb *", ".cb *::before", ".cb *::after"):
        assert selector in rule, selector
    assert "animation: none !important" in rule
    assert "transition: none !important" in rule


def test_every_animation_names_a_keyframes_this_page_defines() -> None:
    style = _style()
    used = set(re.findall(r"animation:\s*(cb-[\w-]+)", style))
    defined = set(re.findall(r"@keyframes\s+(cb-[\w-]+)", style))
    assert used and used == defined


def test_it_has_a_light_theme_and_fits_a_narrow_pane() -> None:
    style = _style()
    assert "@media (prefers-color-scheme: light)" in style
    assert "minmax(min(100%, 240px), 1fr)" in style
    assert not re.search(r"(?<![-\w])width:\s*\d{3,}px", style)
