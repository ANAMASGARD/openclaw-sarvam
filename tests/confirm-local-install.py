"""Confirm only the OpenClaw local-source prompt on a fresh acceptance profile."""
import errno
import os
import pty
import signal
import sys

pid, terminal = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
output = bytearray()
confirmed = False
try:
    while True:
        try:
            chunk = os.read(terminal, 8192)
        except OSError as exc:
            if exc.errno == errno.EIO:
                break
            raise
        if not chunk:
            break
        sys.stdout.buffer.write(chunk)
        sys.stdout.buffer.flush()
        output.extend(chunk)
        if not confirmed and b"Install this non-ClawHub plugin source?" in output:
            os.write(terminal, b"yes\n")
            confirmed = True
        if len(output) > 8192:
            del output[:-4096]
finally:
    os.close(terminal)
    try:
        _, status = os.waitpid(pid, 0)
    except KeyboardInterrupt:
        os.kill(pid, signal.SIGTERM)
        raise
sys.exit(os.waitstatus_to_exitcode(status))
