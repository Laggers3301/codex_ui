#!/usr/bin/python3
"""Kernel-enforced network denial inherited by the offline fork worker.

No root privilege, DNS/IP denylist, or shared-host firewall modification is
needed. Fail closed if seccomp cannot be installed. stdin/out remain pipes.
"""
import ctypes
import ctypes.util
import errno
import os
import sys

if len(sys.argv) < 2:
    raise SystemExit("An offline worker command is required")
lib = ctypes.CDLL(ctypes.util.find_library("seccomp") or "libseccomp.so.2", use_errno=True)
lib.seccomp_init.argtypes = [ctypes.c_uint32]
lib.seccomp_init.restype = ctypes.c_void_p
lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
lib.seccomp_syscall_resolve_name.restype = ctypes.c_int
lib.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
lib.seccomp_load.argtypes = [ctypes.c_void_p]
lib.seccomp_release.argtypes = [ctypes.c_void_p]
ctx = lib.seccomp_init(0x7FFF0000)  # SCMP_ACT_ALLOW
if not ctx:
    raise SystemExit("Cannot initialize offline network guard")
try:
    for name in [b"socket", b"connect", b"sendto", b"sendmsg", b"sendmmsg", b"socketcall", b"io_uring_setup"]:
        number = lib.seccomp_syscall_resolve_name(name)
        if number >= 0 and lib.seccomp_rule_add(ctx, 0x00050000 | errno.EPERM, number, 0) != 0:
            raise RuntimeError("Cannot install offline network guard")
    if lib.seccomp_load(ctx) != 0:
        raise RuntimeError("Cannot activate offline network guard")
finally:
    lib.seccomp_release(ctx)
os.execv(sys.argv[1], sys.argv[1:])
