"""Terminal-local OpenSSH adapter. REAPER_SOURCE is prepended by the backend.

Login/command sessions run a small Linux reaper on the remote host. OpenSSH
still owns authentication, host verification, ProxyJump and the encrypted
transport. Forwarding, subsystems and control/config queries pass through.
"""
import os
import shlex
import sys
import uuid


def managed_ssh(arguments, real_ssh):
    options, destination, command = [], None, []
    takes_value = set("BbcDEeFIiJLlmOopQRSWwP")
    flags = set("1246AaCfGgKkMNnqsTtVvXxYy")
    bypass = False
    remote_command = None
    index = 0
    while index < len(arguments):
        arg = arguments[index]
        if arg == "--":
            if destination is None and index + 1 < len(arguments):
                destination = arguments[index + 1]
                command = arguments[index + 2:]
            else:
                command = arguments[index + 1:]
            break
        if not arg.startswith("-") or arg == "-":
            if destination is None:
                destination = arg
                index += 1
                continue
            command = arguments[index:]
            break
        position = 1
        while position < len(arg):
            flag = arg[position]
            if flag in takes_value:
                if position + 1 < len(arg):
                    value = arg[position + 1:]
                else:
                    index += 1
                    if index >= len(arguments):
                        return [real_ssh, *arguments]  # Let ssh report usage.
                    value = arguments[index]
                if flag in "OQW":
                    bypass = True
                normalized = value.strip().lower().replace(" ", "=")
                if flag == "o" and normalized.startswith("remotecommand="):
                    remote_command = value.split("=", 1)[1] if "=" in value else value.split(None, 1)[1]
                else:
                    options.extend(["-" + flag, value])
                if flag == "o" and normalized.startswith("sessiontype=") and not normalized.endswith("=default"):
                    bypass = True
                break
            if flag not in flags:
                return [real_ssh, *arguments]
            if flag in "GVNfs":
                bypass = True
            options.append("-" + flag)
            position += 1
        index += 1
    if bypass or destination is None:
        return [real_ssh, *arguments]
    if command and remote_command and remote_command.lower() != "none":
        return [real_ssh, *arguments]  # Preserve OpenSSH's conflict diagnostic.
    original = " ".join(command) if command else remote_command
    # Adding a RemoteCommand would otherwise turn OpenSSH's automatic login
    # PTY off. Preserve interactive login behavior, including explicit -T.
    explicit_tty = any(option in ("-t", "-T") or option.lower().startswith("requesttty") for option in options)
    if not original and sys.stdin.isatty() and not explicit_tty:
        options.append("-t")
    remote = ["/usr/bin/python3", "-c", REAPER_SOURCE, str(uuid.uuid4()), "-"]
    if original and original.lower() != "none":
        remote.extend(["/bin/sh", "-c", original])
    else:
        remote.extend(["/bin/sh", "-c", 'exec "${SHELL:-/bin/sh}" -l'])
    return [real_ssh, *options, "--", destination, shlex.join(remote)]


if __name__ == "__main__":
    actual = os.environ["CODEX_WEB_REAL_SSH"]
    argv = managed_ssh(sys.argv[1:], actual)
    os.execv(actual, argv)
