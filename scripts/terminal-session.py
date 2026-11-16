"""Exec a terminal command with an independent, narrowly scoped reaper.

The reaper survives SIGKILL of the shell/runtime. A unique inherited marker
also identifies background jobs after reparenting or setsid (including ssh).
"""
import os
from pathlib import Path
import signal
import sys
import time


def identity(pid):
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return (fields[19], int(fields[1]), fields[0])
    except (OSError, ValueError, IndexError):
        return None


def alive(pid, start):
    current = identity(pid)
    return current is not None and current[0] == start and current[2] != "Z"


def reap(shell, parent, marker):
    os.setsid()
    # Never retain the PTY or app-server's output pipe after the shell exits.
    null = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(null, fd)
    if null > 2:
        os.close(null)
    for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, signal.SIG_IGN)
    members = {shell[0]: shell[1]}
    needle = b"CODEX_WEB_TERMINAL_SESSION=" + marker.encode()

    def discover():
        rows = {}
        for item in Path("/proc").iterdir():
            if not item.name.isdecimal() or int(item.name) == os.getpid():
                continue
            pid = int(item.name)
            current = identity(pid)
            if current is None or current[2] == "Z":
                continue
            rows[pid] = current
            try:
                if needle in (item / "environ").read_bytes().split(b"\0"):
                    members[pid] = current[0]
            except OSError:
                pass
        # Descendants that deliberately cleared their environment still belong
        # to this terminal. Check start times before following a reused PID.
        changed = True
        while changed:
            changed = False
            for pid, current in rows.items():
                ancestor = rows.get(current[1])
                if pid not in members and ancestor and members.get(current[1]) == ancestor[0]:
                    members[pid] = current[0]
                    changed = True

    while alive(*shell) and alive(*parent):
        discover()
        time.sleep(0.5)
    # HUP closes interactive SSH channels; TERM/KILL also reap local shell jobs
    # that ignore HUP or have detached from the original terminal process group.
    for sig, delay in ((signal.SIGHUP, 0.3), (signal.SIGTERM, 1), (signal.SIGKILL, 0.3)):
        discover()
        for pid, start in list(members.items()):
            if alive(pid, start):
                try:
                    os.kill(pid, sig)
                except ProcessLookupError:
                    pass
        time.sleep(delay)


if __name__ == "__main__":
    marker, *command = sys.argv[1:]
    if not marker or not command:
        raise SystemExit(2)
    shell_pid, parent_pid = os.getpid(), os.getppid()
    shell_start, parent_start = identity(shell_pid)[0], identity(parent_pid)[0]
    if os.fork() == 0:
        try:
            reap((shell_pid, shell_start), (parent_pid, parent_start), marker)
        finally:
            os._exit(0)
    os.environ["CODEX_WEB_TERMINAL_SESSION"] = marker
    os.execvp(command[0], command)
