"""The git update route's reinstall: supervised, and promoted only when whole.

Two contracts this pins, both on the route that moves the checkout first and
reinstalls second (the gateway auto-apply and the dashboard ``POST /api/update``):

* on Linux, a failed or interrupted ``pip install -e`` leaves the live venv
  exactly as it was, because the install runs in a copy that is swapped in only
  when whole (pip's uninstall is not atomic, so an in-place run is left half
  rewritten);
* cancelling the caller kills that staged pip, instead of leaving it writing
  from an executor thread after the gateway exits. An in-place pip (macOS,
  Windows, every fallback) is left to finish, on every platform, since killing
  it would guarantee the half-written venv.

The venvs here are real (``python -m venv --without-pip``) and the "pip" each one
runs is a stub package, so the copy, the run inside the copy, the shebang fix-up
and the swap are all exercised for real while nothing reaches the network.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import subprocess
import sys
import textwrap
import threading
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from kiro_crew import dep_sync, platform_compat
from kiro_crew.testing.wait import async_wait_until, wait_until

#: The staged reinstall exists on Linux only (see ``dep_sync._stageable_venv``).
linux_only = pytest.mark.skipif(
    not sys.platform.startswith("linux"), reason="the staged reinstall is Linux-only"
)


def _pid_alive(pid: int) -> bool:
    if not platform_compat.pid_exists(pid):
        return False
    # A zombie still answers kill(0), but it cannot write anything: count it gone.
    try:
        with open(f"/proc/{pid}/stat", encoding="utf-8") as fh:
            return fh.read().split(")")[-1].split()[0] != "Z"
    except OSError:
        return True


def _kill_leftover(pid: int) -> None:
    """Test cleanup only: end a child a failing assertion left running."""
    with contextlib.suppress(Exception):
        platform_compat.kill_process_tree(pid, platform_compat.SIGKILL)


#: A ``pip`` that records its pid and hangs. Put first on PYTHONPATH, it shadows
#: whatever pip the interpreter has, so ``<python> -m pip ...`` runs this.
_HANGING_PIP = (
    "import os, sys, time\n"
    "open(os.environ['FAKE_PIP_PIDFILE'], 'w').write(str(os.getpid()))\n"
    "time.sleep(600)\n"
)


def _wait_for(predicate, _timeout: object = None) -> bool:
    """Wait for *predicate* under the shared helper's lost-run ceiling only.

    The second argument is ignored: a ceiling here would be a bet on the runner's
    speed. ``wait_until`` raises, naming the predicate, if it never comes true.
    """
    wait_until(predicate)
    return True


def _guards_open():
    """Open the ownership/lock/floor guards: they have their own tests."""
    return (
        patch.object(dep_sync, "installed_package_origin", return_value="<stub>"),
        patch.object(dep_sync, "venv_not_mapped_to", return_value=None),
        patch.object(dep_sync, "locked_console_scripts", return_value=[]),
        patch.object(dep_sync, "requires_python", return_value=None),
    )


# --- the shutdown race -----------------------------------------------------


@linux_only
@pytest.mark.asyncio
async def test_cancelling_the_staged_dashboard_install_kills_pip_and_keeps_the_venv(
    live_venv, tmp_path, monkeypatch
):
    """A cancelled ``_venv_pip_install`` stops its pip; the live venv stays whole."""
    from kiro_crew.dashboard.handlers import updates

    pidfile = tmp_path / "pip.pid"
    monkeypatch.setenv("FAKE_PIP_MODE", "hang")
    monkeypatch.setenv("FAKE_PIP_PIDFILE", str(pidfile))
    monkeypatch.setattr(sys, "executable", str(live_venv / "bin" / "python"))

    guards = _guards_open()
    for g in guards:
        g.start()
    pid = None
    try:
        task = asyncio.create_task(updates._venv_pip_install(str(live_venv.parent), MagicMock()))
        await async_wait_until(
            lambda: pidfile.exists() and pidfile.read_text().strip(), off_loop=True
        )
        pid = int(pidfile.read_text().strip())
        assert _pid_alive(pid)

        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        # Dead by the time the cancel has been delivered: the helper waits for
        # the kill before passing the cancel on.
        assert not _pid_alive(pid)
        assert _version(live_venv) == "VERSION = 'old'"
        assert not _stage_of(live_venv).exists()
    finally:
        for g in guards:
            g.stop()
        if pid is not None and _pid_alive(pid):
            _kill_leftover(pid)


@pytest.mark.asyncio
async def test_cancelling_an_in_place_dashboard_install_lets_pip_finish(tmp_path, monkeypatch):
    """In place, killing pip would guarantee a half-written venv: it is left to run."""
    from kiro_crew.dashboard.handlers import updates

    # The real interpreter, so on Windows this runs through a venv's python.exe
    # redirector exactly as an update does.
    stub = tmp_path / "stub"
    (stub / "pip").mkdir(parents=True)
    (stub / "pip" / "__init__.py").write_text("")
    (stub / "pip" / "__main__.py").write_text(_HANGING_PIP)
    pidfile = tmp_path / "pip.pid"
    monkeypatch.setenv("FAKE_PIP_PIDFILE", str(pidfile))
    monkeypatch.setenv(
        "PYTHONPATH", os.pathsep.join(filter(None, [str(stub), os.environ.get("PYTHONPATH")]))
    )
    # In place, as on macOS and Windows; this also keeps the test from ever
    # staging the venv the test run itself is using.
    monkeypatch.setattr(dep_sync, "_stageable_venv", lambda _py: None)
    # The grace the helper gives a staged pip to die: nothing to wait for here.
    monkeypatch.setattr(dep_sync, "_CANCEL_GRACE_SECS", 0)

    guards = _guards_open()
    for g in guards:
        g.start()
    pid = None
    try:
        task = asyncio.create_task(updates._venv_pip_install(str(tmp_path), MagicMock()))
        await async_wait_until(
            lambda: pidfile.exists() and pidfile.read_text().strip(), off_loop=True
        )
        pid = int(pidfile.read_text().strip())
        assert _pid_alive(pid)

        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        assert _pid_alive(pid)
    finally:
        for g in guards:
            g.stop()
        if pid is not None and _pid_alive(pid):
            _kill_leftover(pid)


# --- the staged reinstall --------------------------------------------------

_FAKE_PIP = textwrap.dedent("""
    import os, sys, time
    from pathlib import Path

    prefix = Path(sys.prefix)
    site = next(prefix.glob("lib/python*/site-packages"))
    mode = os.environ.get("FAKE_PIP_MODE", "ok")
    # Every mode starts by writing into the venv it runs in, the way a real
    # reinstall uninstalls the old editable install before it builds the new one.
    (site / "kiro_crew" / "__init__.py").write_text("VERSION = 'half'\\n")
    if mode == "fail":
        sys.exit(1)
    if mode == "hang":
        Path(os.environ["FAKE_PIP_PIDFILE"]).write_text(str(os.getpid()))
        time.sleep(600)
    (site / "kiro_crew" / "__init__.py").write_text("VERSION = 'new'\\n")
    script = prefix / "bin" / "kirocrew"
    script.write_text(f"#!{prefix}/bin/python\\nimport kiro_crew\\n")
    script.chmod(0o755)
    """)


@pytest.fixture
def live_venv(tmp_path):
    """A real venv holding the "old" install and a stub pip."""
    root = tmp_path / "proj" / ".venv"
    root.parent.mkdir()
    subprocess.run(
        [sys.executable, "-m", "venv", "--without-pip", str(root)], check=True, timeout=120
    )
    site = next(root.glob("lib/python*/site-packages"))
    (site / "kiro_crew").mkdir()
    (site / "kiro_crew" / "__init__.py").write_text("VERSION = 'old'\n")
    (site / "pip").mkdir()
    (site / "pip" / "__init__.py").write_text("")
    (site / "pip" / "__main__.py").write_text(_FAKE_PIP)
    script = root / "bin" / "kirocrew"
    script.write_text(f"#!{root}/bin/python\nimport kiro_crew\n")
    script.chmod(0o755)
    return root


def _version(root: Path) -> str:
    site = next(root.glob("lib/python*/site-packages"))
    return (site / "kiro_crew" / "__init__.py").read_text().strip()


def _staged(root: Path, monkeypatch, mode: str, cancel=None, timeout=60):
    monkeypatch.setenv("FAKE_PIP_MODE", mode)
    messages: list[tuple[str, bool]] = []
    with _guards_open()[0], _guards_open()[1], _guards_open()[2], _guards_open()[3]:
        rc = dep_sync.sync_or_reinstall(
            root.parent,
            root / "bin" / "python",
            lambda m, e: messages.append((m, e)),
            timeout=timeout,
            # A Supervision is what selects staging, and carries its seams.
            supervision=cancel if cancel is not None else dep_sync.Supervision(platform_compat),
        )
    return rc, messages


def _stage_of(root: Path) -> Path:
    return root.with_name(root.name + dep_sync._STAGE_SUFFIX)


@linux_only
def test_a_staged_reinstall_promotes_the_built_copy(live_venv, monkeypatch):
    rc, messages = _staged(live_venv, monkeypatch, "ok")

    assert rc == 0, messages
    assert _version(live_venv) == "VERSION = 'new'"
    assert not _stage_of(live_venv).exists()
    # The script pip wrote in the stage calls the LIVE interpreter, not the
    # stage the swap removed.
    head = (live_venv / "bin" / "kirocrew").read_text().splitlines()[0]
    assert head == f"#!{live_venv}/bin/python"
    # The promoted venv runs.
    out = subprocess.run(
        # -I: the test run's own PYTHONPATH would import the real package instead.
        [
            str(live_venv / "bin" / "python"),
            "-I",
            "-c",
            "import kiro_crew; print(kiro_crew.VERSION)",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
    )
    assert out.stdout.strip() == "new"


@linux_only
def test_a_failed_staged_reinstall_leaves_the_live_venv_untouched(live_venv, monkeypatch):
    """In place, this failure leaves the venv half rewritten; staged, it is untouched."""
    rc, messages = _staged(live_venv, monkeypatch, "fail")

    assert rc == 1
    assert _version(live_venv) == "VERSION = 'old'"
    assert not _stage_of(live_venv).exists()
    assert any("is unchanged" in m for m, _ in messages)


@linux_only
def test_the_in_place_reinstall_is_what_leaves_it_half_written(live_venv, monkeypatch):
    """The baseline the staging exists for: without it, the same failure corrupts."""
    monkeypatch.setenv("FAKE_PIP_MODE", "fail")
    with _guards_open()[0], _guards_open()[1], _guards_open()[2], _guards_open()[3]:
        rc = dep_sync.sync_or_reinstall(
            live_venv.parent, live_venv / "bin" / "python", lambda m, e: None, timeout=60
        )
    assert rc == 1
    assert _version(live_venv) == "VERSION = 'half'"


@linux_only
def test_a_cancelled_staged_reinstall_kills_pip_and_keeps_the_live_venv(
    live_venv, monkeypatch, tmp_path
):
    pidfile = tmp_path / "hang.pid"
    monkeypatch.setenv("FAKE_PIP_PIDFILE", str(pidfile))
    stop = dep_sync.Supervision(platform_compat)
    result: dict[str, object] = {}

    def run() -> None:
        result["rc"], result["messages"] = _staged(live_venv, monkeypatch, "hang", cancel=stop)

    worker = threading.Thread(target=run)
    worker.start()
    pid = None
    try:
        assert _wait_for(lambda: pidfile.exists() and pidfile.read_text().strip() != "", 30)
        pid = int(pidfile.read_text())
        stop.set()
        worker.join(15)
        assert not worker.is_alive()
        assert result["rc"] == 1
        assert not _pid_alive(pid)
        assert _version(live_venv) == "VERSION = 'old'"
        assert not _stage_of(live_venv).exists()
    finally:
        if pid is not None and _pid_alive(pid):
            _kill_leftover(pid)
        worker.join(5)


@linux_only
def test_a_timed_out_staged_reinstall_keeps_the_live_venv(live_venv, monkeypatch, tmp_path):
    monkeypatch.setenv("FAKE_PIP_PIDFILE", str(tmp_path / "t.pid"))
    rc, messages = _staged(
        live_venv, monkeypatch, "hang", cancel=dep_sync.Supervision(platform_compat), timeout=2
    )

    assert rc == 1
    assert any("timed out" in m for m, _ in messages)
    assert _version(live_venv) == "VERSION = 'old'"
    pid = int((tmp_path / "t.pid").read_text())
    assert not _pid_alive(pid)


@linux_only
def test_a_stage_left_by_an_interrupted_run_is_replaced(live_venv, monkeypatch):
    stale = _stage_of(live_venv)
    stale.mkdir()
    (stale / "junk").write_text("from a run that died")

    rc, messages = _staged(live_venv, monkeypatch, "ok")

    assert rc == 0, messages
    assert not stale.exists()
    assert not (live_venv / "junk").exists()


@linux_only
def test_no_room_to_stage_falls_back_to_the_in_place_reinstall(live_venv, monkeypatch):
    monkeypatch.setattr(dep_sync.shutil, "disk_usage", lambda _p: type("U", (), {"free": 0})())
    rc, messages = _staged(live_venv, monkeypatch, "ok")

    assert rc == 0, messages
    assert _version(live_venv) == "VERSION = 'new'"
    assert any("runs in place" in m for m, _ in messages)


@linux_only
def test_only_a_plain_posix_venv_is_staged(tmp_path, live_venv):
    assert dep_sync._stageable_venv(live_venv / "bin" / "python") == live_venv
    # Not inside a venv at all.
    assert dep_sync._stageable_venv(tmp_path / "usr" / "bin" / "python3") is None
    # A venv root that is a link: swapping would replace the link, not the venv.
    link = tmp_path / "linked-venv"
    link.symlink_to(live_venv)
    assert dep_sync._stageable_venv(link / "bin" / "python") is None


@linux_only
def test_exchange_dirs_swaps_both_names(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir()
    b.mkdir()
    (a / "which").write_text("a")
    (b / "which").write_text("b")

    dep_sync._exchange_dirs(a, b, platform_compat)

    assert (a / "which").read_text() == "b"
    assert (b / "which").read_text() == "a"


@linux_only
def test_no_atomic_exchange_is_refused_not_emulated(tmp_path, monkeypatch):
    """Two renames would leave the live path empty if the process died between them."""
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir()
    b.mkdir()
    # No renameat2 seam at all (e.g. an architecture with no syscall number).
    monkeypatch.setattr(platform_compat, "_RENAME_NOREPLACE_FN", None)

    with pytest.raises(dep_sync.ExchangeUnsupported):
        dep_sync._exchange_dirs(a, b, platform_compat)
    assert a.is_dir() and b.is_dir()
    assert not dep_sync._exchange_supported(tmp_path, platform_compat)


@linux_only
def test_without_an_atomic_exchange_the_reinstall_runs_in_place(live_venv, monkeypatch):
    monkeypatch.setattr(dep_sync, "_exchange_supported", lambda _p, _pc: False)
    copies = []
    monkeypatch.setattr(dep_sync.shutil, "copytree", lambda *a, **k: copies.append(a))

    rc, messages = _staged(live_venv, monkeypatch, "ok")

    assert rc == 0, messages
    assert copies == []
    assert _version(live_venv) == "VERSION = 'new'"
    assert any("atomically" in m for m, _ in messages)


@linux_only
def test_a_second_concurrent_staging_of_one_venv_is_refused(live_venv, monkeypatch):
    """Two runs sharing the one stage path would rebuild each other's copy."""
    with dep_sync._stage_lock(live_venv, dep_sync.Supervision(platform_compat)) as held:
        assert held
        rc, messages = _staged(live_venv, monkeypatch, "ok")

    # REFUSED: nothing was touched, so a caller must not run its repair install
    # into the venv the other run is staging.
    assert rc == dep_sync.REFUSED
    assert any("already staging" in m for m, _ in messages)
    assert _version(live_venv) == "VERSION = 'old'"
    # Released with its holder: the next run stages normally.
    rc, messages = _staged(live_venv, monkeypatch, "ok")
    assert rc == 0, messages


@linux_only
def test_a_script_that_cannot_be_repointed_blocks_the_promotion(live_venv, monkeypatch):
    """Promoting it would leave a console script calling the deleted stage."""

    def boom(*_a, **_k):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(dep_sync, "_repoint_scripts", boom)
    rc, messages = _staged(live_venv, monkeypatch, "ok")

    assert rc == 1
    assert _version(live_venv) == "VERSION = 'old'"
    assert not _stage_of(live_venv).exists()
    assert any("could not point the staged scripts" in m for m, _ in messages)


@linux_only
def test_repoint_scripts_raises_when_a_rewrite_fails(tmp_path, monkeypatch):
    stage, live = tmp_path / "stage", tmp_path / "live"
    (stage / "bin").mkdir(parents=True)
    script = stage / "bin" / "tool"
    script.write_text(f"#!{stage}/bin/python\nprint(1)\n")

    def full(*_a, **_k):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(Path, "write_bytes", full)
    with pytest.raises(OSError):
        dep_sync._repoint_scripts(stage / "bin", stage, live)
    assert not (stage / "bin" / "tool.kirocrew-tmp").exists()


@linux_only
@pytest.mark.asyncio
async def test_the_supervised_helper_returns_the_install_result(live_venv, monkeypatch):
    monkeypatch.setenv("FAKE_PIP_MODE", "ok")
    with _guards_open()[0], _guards_open()[1], _guards_open()[2], _guards_open()[3]:
        rc = await dep_sync.sync_or_reinstall_supervised(
            None,
            live_venv.parent,
            live_venv / "bin" / "python",
            lambda m, e: None,
            timeout=60,
            platform=platform_compat,
        )
    assert rc == 0
    assert _version(live_venv) == "VERSION = 'new'"


@linux_only
def test_a_failed_swap_falls_back_to_the_in_place_reinstall(live_venv, monkeypatch):
    """EBUSY/EXDEV at the swap must not refuse an update that worked before staging."""

    def busy(*_a):
        raise OSError(16, "Device or resource busy")

    monkeypatch.setattr(dep_sync, "_exchange_dirs", busy)
    monkeypatch.setattr(dep_sync, "_exchange_supported", lambda _p, _pc: True)
    rc, messages = _staged(live_venv, monkeypatch, "ok")

    assert rc == 0, messages
    assert _version(live_venv) == "VERSION = 'new'"
    assert not _stage_of(live_venv).exists()
    assert any("runs in place" in m for m, _ in messages)


@linux_only
def test_the_stage_never_shows_in_the_checkouts_git_status(live_venv, monkeypatch, tmp_path):
    """A visible stage would make the dashboard update refuse a dirty tree."""
    checkout = live_venv.parent
    env = {**os.environ, "HOME": str(tmp_path), "GIT_CONFIG_NOSYSTEM": "1"}
    subprocess.run(["git", "init", "-q", str(checkout)], check=True, env=env, timeout=60)
    (checkout / ".gitignore").write_text("/.venv\n")
    subprocess.run(
        ["git", "-C", str(checkout), "add", ".gitignore"], check=True, env=env, timeout=60
    )
    subprocess.run(
        [
            "git",
            "-C",
            str(checkout),
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-qm",
            "i",
        ],
        check=True,
        env=env,
        timeout=60,
    )
    pidfile = tmp_path / "hang.pid"
    monkeypatch.setenv("FAKE_PIP_PIDFILE", str(pidfile))
    stop = dep_sync.Supervision(platform_compat)
    worker = threading.Thread(
        target=lambda: _staged(live_venv, monkeypatch, "hang", cancel=stop), daemon=True
    )
    worker.start()
    pid = None
    try:
        assert _wait_for(lambda: pidfile.exists() and pidfile.read_text().strip() != "", 30)
        pid = int(pidfile.read_text())
        assert _stage_of(live_venv).is_dir()
        status = subprocess.run(
            ["git", "-C", str(checkout), "status", "--porcelain", "--untracked-files=all"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            env=env,
            timeout=60,
        )
        assert status.stdout == ""
    finally:
        stop.set()
        worker.join(15)
        if pid is not None and _pid_alive(pid):
            _kill_leftover(pid)


@linux_only
def test_the_previous_venv_left_after_a_swap_is_ignored_by_git(live_venv, monkeypatch):
    """A run killed between the swap and the cleanup leaves the OLD venv behind."""
    assert not (live_venv / ".gitignore").exists()
    monkeypatch.setattr(dep_sync, "_discard", lambda _p: None)

    rc, messages = _staged(live_venv, monkeypatch, "ok")

    assert rc == 0, messages
    leftover = _stage_of(live_venv)
    assert _version(leftover) == "VERSION = 'old'"
    assert (leftover / ".gitignore").read_text() == "*\n"


@pytest.mark.parametrize("platform", ["darwin", "win32"])
def test_only_linux_stages(tmp_path, monkeypatch, platform):
    """Windows locks the live venv; macOS waits for a host-verified swap path."""
    root = tmp_path / ".venv"
    (root / "bin").mkdir(parents=True)
    (root / "pyvenv.cfg").write_text("home = /usr/bin\n")
    monkeypatch.setattr(dep_sync.sys, "platform", platform)

    assert dep_sync._stageable_venv(root / "bin" / "python") is None


@linux_only
def test_a_filesystem_that_cannot_lock_falls_back_to_the_in_place_reinstall(live_venv, monkeypatch):
    """ENOLCK is not "someone else holds it": refusing would leave deps stale."""

    def no_locks(_fd, *, exclusive=False):
        raise OSError(37, "No locks available")

    monkeypatch.setattr(platform_compat.platform_lock_compat, "try_acquire_lock_or_raise", no_locks)
    copies = []
    monkeypatch.setattr(dep_sync.shutil, "copytree", lambda *a, **k: copies.append(a))

    rc, messages = _staged(live_venv, monkeypatch, "ok")

    assert rc == 0, messages
    assert copies == []
    assert _version(live_venv) == "VERSION = 'new'"
    assert any("cannot be locked" in m for m, _ in messages)


@linux_only
def test_a_gateway_running_from_inside_the_venv_is_not_staged(live_venv, monkeypatch):
    """The swap would delete that cwd, so every later os.getcwd() would raise."""
    monkeypatch.chdir(live_venv / "bin")
    assert dep_sync._stageable_venv(live_venv / "bin" / "python") is None
    monkeypatch.chdir(live_venv)
    assert dep_sync._stageable_venv(live_venv / "bin" / "python") is None
    monkeypatch.chdir(live_venv.parent)
    assert dep_sync._stageable_venv(live_venv / "bin" / "python") == live_venv


@linux_only
def test_an_install_into_the_live_venv_during_staging_is_not_undone(live_venv, monkeypatch):
    """Swapping after another writer changed the live venv would silently undo it."""
    real = dep_sync._editable_reinstall
    site = next(live_venv.glob("lib/python*/site-packages"))

    def reinstall_while_another_writer_installs(repo, py, emit, timeout, cancel):
        if dep_sync._STAGE_SUFFIX in str(py):
            (site / "some_tool").mkdir()  # e.g. an app's own `pip install`
        return real(repo, py, emit, timeout, cancel)

    monkeypatch.setattr(dep_sync, "_editable_reinstall", reinstall_while_another_writer_installs)
    rc, messages = _staged(live_venv, monkeypatch, "ok")

    assert rc == 0, messages
    assert (site / "some_tool").is_dir()
    assert _version(live_venv) == "VERSION = 'new'"
    assert not _stage_of(live_venv).exists()
    assert any("changed while the reinstall was staged" in m for m, _ in messages)


@linux_only
def test_a_cancel_before_a_fallback_starts_no_in_place_pip(live_venv, monkeypatch):
    """The caller has stopped: a fresh pip in the live venv would be unsupervised."""
    monkeypatch.setattr(dep_sync.shutil, "disk_usage", lambda _p: type("U", (), {"free": 0})())
    started = []
    monkeypatch.setattr(dep_sync, "_editable_reinstall", lambda *a: started.append(a) or 0)
    stop = dep_sync.Supervision(platform_compat)
    stop.set()

    rc, messages = _staged(live_venv, monkeypatch, "ok", cancel=stop)

    assert rc == 1
    assert started == []
    assert _version(live_venv) == "VERSION = 'old'"


@linux_only
def test_the_staged_pip_holds_the_stage_lock_itself(live_venv, monkeypatch, tmp_path):
    """So a gateway killed outright cannot release it while its pip still writes."""
    pidfile = tmp_path / "hang.pid"
    monkeypatch.setenv("FAKE_PIP_PIDFILE", str(pidfile))
    stop = dep_sync.Supervision(platform_compat)
    worker = threading.Thread(
        target=lambda: _staged(live_venv, monkeypatch, "hang", cancel=stop), daemon=True
    )
    worker.start()
    pid = None
    try:
        assert _wait_for(lambda: pidfile.exists() and pidfile.read_text().strip() != "")
        pid = int(pidfile.read_text())
        held = {
            os.path.realpath(os.readlink(f"/proc/{pid}/fd/{fd}"))
            for fd in os.listdir(f"/proc/{pid}/fd")
        }
        assert os.path.realpath(live_venv.parent) in held
    finally:
        stop.set()
        worker.join(15)
        if pid is not None and _pid_alive(pid):
            _kill_leftover(pid)
