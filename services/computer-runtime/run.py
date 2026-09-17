"""Bounded computer operations. This helper runs inside the bot's container, never on the host."""
import base64
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import time

ROOT = Path('/workspace')
MAX_FILE = 4 * 1024 * 1024
MAX_OUTPUT = 64 * 1024


def workspace_path(value):
    path = Path(value)
    if not path.is_absolute():
        path = ROOT / path
    resolved = path.resolve()
    if not resolved.is_relative_to(ROOT):
        raise ValueError('Path outside /workspace')
    return resolved


def run(operation):
    ROOT.mkdir(exist_ok=True)
    result = {'exitCode': 0, 'stdout': '', 'stderr': ''}
    if operation['kind'] == 'exec':
        process = subprocess.Popen(['/bin/bash', '-lc', operation['command']], cwd=ROOT,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   stdin=subprocess.DEVNULL, start_new_session=True)
        output = {'stdout': bytearray(), 'stderr': bytearray()}
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ, 'stdout')
            selector.register(process.stderr, selectors.EVENT_READ, 'stderr')
            deadline = time.monotonic() + 30
            try:
                while selector.get_map() and time.monotonic() < deadline:
                    for key, _ in selector.select(timeout=0.1):
                        data = os.read(key.fd, 8192)
                        if not data:
                            selector.unregister(key.fileobj)
                            continue
                        buffer = output[key.data]
                        buffer.extend(data[:max(0, MAX_OUTPUT - len(buffer))])
                result['exitCode'] = process.wait(timeout=max(0.01, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                result['exitCode'] = 124
            finally:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
                process.stdout.close()
                process.stderr.close()
        for name, data in output.items():
            result[name] = data.decode('utf-8', errors='replace')
    else:
        path = workspace_path(operation['path'])
        if operation['kind'] == 'list':
            entries = sorted(path.iterdir())
            if len(entries) > 1000:
                raise ValueError('Directory too large')
            result['entries'] = [{'name': p.name, 'kind': 'directory' if p.is_dir() else 'file'}
                                 for p in entries if not p.is_symlink()]
        elif operation['kind'] == 'read':
            with path.open('rb') as file:
                data = file.read(MAX_FILE + 1)
            if len(data) > MAX_FILE:
                raise ValueError('File too large')
            result['data'] = base64.b64encode(data).decode('ascii')
        elif operation['kind'] == 'write':
            data = base64.b64decode(operation['data'], validate=True)
            if len(data) > MAX_FILE:
                raise ValueError('File too large')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        elif operation['kind'] == 'delete':
            path.unlink()
        else:
            raise ValueError('Unsupported operation')
    return result


if __name__ == '__main__':
    try:
        print(json.dumps(run(json.load(sys.stdin))))
    except Exception:
        # File contents, credentials and provider errors never become infrastructure logs.
        print(json.dumps({'exitCode': 1, 'stdout': '', 'stderr': 'Workspace operation failed'}))
