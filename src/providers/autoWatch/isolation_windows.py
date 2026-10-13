"""Run the guest acquisition worker inside a Windows Job Object.

The worker waits for stdin; assign its memory/CPU/process limits before sending
the source. Closing the job terminates every process belonging to it.
"""
import ctypes
from ctypes import wintypes
import os
import subprocess
import sys


class BasicLimits(ctypes.Structure):
    _fields_ = [("process_time", ctypes.c_int64), ("job_time", ctypes.c_int64),
                ("flags", wintypes.DWORD), ("minimum_working_set", ctypes.c_size_t),
                ("maximum_working_set", ctypes.c_size_t), ("active_processes", wintypes.DWORD),
                ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD),
                ("scheduling", wintypes.DWORD)]


class IoCounters(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint64) for name in
                ("read_count", "write_count", "other_count", "read_bytes", "write_bytes", "other_bytes")]


class ExtendedLimits(ctypes.Structure):
    _fields_ = [("basic", BasicLimits), ("io", IoCounters),
                ("process_memory", ctypes.c_size_t), ("job_memory", ctypes.c_size_t),
                ("peak_process_memory", ctypes.c_size_t), ("peak_job_memory", ctypes.c_size_t)]


class CpuLimits(ctypes.Structure):
    _fields_ = [("flags", wintypes.DWORD), ("rate", wintypes.DWORD)]


def main():
    if os.name != "nt":
        return 2
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    job = kernel.CreateJobObjectW(None, None)
    if not job:
        return 2
    child = None
    try:
        limits = ExtendedLimits()
        limits.basic.flags = 0x2000 | 0x100 | 0x200 | 0x8
        limits.basic.active_processes = 1
        limits.process_memory = limits.job_memory = int(sys.argv[1])
        cpu = CpuLimits(0x1 | 0x4, 5000)
        if not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            return 2
        if not kernel.SetInformationJobObject(job, 15, ctypes.byref(cpu), ctypes.sizeof(cpu)):
            return 2
        child = subprocess.Popen(sys.argv[3:], stdin=subprocess.PIPE,
                                 stdout=sys.stdout.buffer, stderr=sys.stderr.buffer,
                                 creationflags=subprocess.CREATE_NO_WINDOW)
        if not kernel.AssignProcessToJobObject(job, wintypes.HANDLE(int(child._handle))):
            child.kill()
            return 2
        data = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
        if len(data) > 2 * 1024 * 1024:
            child.kill()
            return 2
        child.communicate(data, timeout=int(sys.argv[2]))
        return child.returncode
    except (OSError, subprocess.TimeoutExpired):
        if child is not None:
            child.kill()
        return 2
    finally:
        kernel.CloseHandle(job)


if __name__ == "__main__":
    raise SystemExit(main())
