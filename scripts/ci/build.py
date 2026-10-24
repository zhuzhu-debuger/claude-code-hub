#!/usr/bin/env python3
"""Build on acer over SSH, retry locally, and export only the verified image."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import tempfile


SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
               "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"]


def run(command, **kwargs):
    return subprocess.run(command, check=True, **kwargs)


def worker_arguments(args, revision):
    return [args.mode, args.platform, args.version, args.repository, revision]


def run_remote(args, archive, output, revision):
    remote_dir = run(
        ["ssh", *SSH_OPTIONS, args.host, "mktemp -d /tmp/cch-ci.XXXXXXXX"],
        capture_output=True, text=True, timeout=20,
    ).stdout.strip()
    worker_finished = False
    try:
        run(["scp", *SSH_OPTIONS, str(archive), f"{args.host}:{remote_dir}/source.tar"],
            timeout=180)
        worker = shlex.join(["timeout", "--signal=TERM", "--kill-after=30s",
                             str(args.timeout), "bash", "scripts/ci/worker.sh",
                             *worker_arguments(args, revision)])
        command = f"cd {shlex.quote(remote_dir)} && tar -xf source.tar && " + shlex.join([
            "setsid", "--wait", "bash", "-c", f"echo $$ > worker.pid; exec {worker}",
        ])
        run(["ssh", *SSH_OPTIONS, args.host, command], timeout=args.timeout + 60)
        worker_finished = True
        if args.mode != "check":
            for name in ("image.tar.gz", "image-reference.txt"):
                run(["scp", *SSH_OPTIONS, f"{args.host}:{remote_dir}/output/{name}", str(output / name)],
                    timeout=600)
    finally:
        try:
            cleanup = f"rm -rf -- {shlex.quote(remote_dir)}"
            if not worker_finished:
                # An interrupted SSH client does not reliably terminate remote children.
                cleanup = (
                    f"cd {shlex.quote(remote_dir)} && "
                    'if [ -f worker.pid ]; then worker_pid=$(cat worker.pid); '
                    'kill -TERM -- "-$worker_pid" 2>/dev/null || true; '
                    'for attempt in 1 2 3 4 5; do '
                    'kill -0 -- "-$worker_pid" 2>/dev/null || break; sleep 1; done; '
                    'kill -KILL -- "-$worker_pid" 2>/dev/null || true; fi; '
                    'if [ -f worker-resources ]; then '
                    'bash scripts/ci/cleanup.sh "$(cat worker-resources)"; fi; ' + cleanup
                )
            run(["ssh", *SSH_OPTIONS, args.host, cleanup],
                timeout=20)
        except (subprocess.SubprocessError, OSError):
            print(f"Remote temporary directory needs cleanup: {remote_dir}", flush=True)


def run_local(args, archive, output, revision):
    with tempfile.TemporaryDirectory(prefix="cch-ci-source-") as directory:
        # git archive supplies repository-relative paths, without local ignored files.
        run(["tar", "-xf", str(archive), "-C", directory])
        process = subprocess.Popen(
            ["bash", "scripts/ci/worker.sh", *worker_arguments(args, revision)],
            cwd=directory, start_new_session=True,
        )
        try:
            returncode = process.wait(timeout=args.timeout)
            if returncode:
                raise subprocess.CalledProcessError(returncode, process.args)
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
            resources = Path(directory, "worker-resources")
            if resources.is_file():
                run(["bash", "scripts/ci/cleanup.sh", resources.read_text().strip()],
                    cwd=directory, timeout=30)
        if args.mode != "check":
            for name in ("image.tar.gz", "image-reference.txt"):
                Path(directory, "output", name).replace(output / name)


def build_with_fallback(args, archive, output, revision):
    try:
        run_remote(args, archive, output, revision)
        return args.host
    except (subprocess.SubprocessError, OSError) as error:
        print(f"Primary builder failed ({error}); retrying the full pipeline locally.", flush=True)
        for name in ("image.tar.gz", "image-reference.txt"):
            (output / name).unlink(missing_ok=True)
        run_local(args, archive, output, revision)
        return "local"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=os.environ.get("CCH_BUILD_HOST", "acer-server"))
    parser.add_argument("--output", type=Path, default=Path(".ci-output"))
    parser.add_argument("--mode", choices=("image", "check", "smoke"), default="image")
    parser.add_argument("--platform", default="linux/amd64")
    parser.add_argument("--version", default="dev")
    parser.add_argument("--repository", default="zhuzhu-debuger/claude-code-hub")
    parser.add_argument("--timeout", type=int, default=3600, help="Seconds per build host")
    args = parser.parse_args()
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    revision = run(["git", "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    with tempfile.TemporaryDirectory(prefix="cch-ci-") as directory:
        archive = Path(directory, "source.tar")
        # A committed snapshot excludes .env, git credentials and local runtime data.
        with archive.open("wb") as stream:
            run(["git", "archive", "--format=tar", revision], stdout=stream)
        builder = build_with_fallback(args, archive, args.output, revision)
    metadata = {"builder": builder, "revision": revision, "platform": args.platform,
                "version": args.version, "mode": args.mode}
    if args.mode != "check":
        digest = hashlib.sha256()
        with (args.output / "image.tar.gz").open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        (args.output / "image.tar.gz.sha256").write_text(f"{digest.hexdigest()}  image.tar.gz\n")
    (args.output / "build.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(json.dumps(metadata), flush=True)


if __name__ == "__main__":
    def terminate(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, terminate)
    main()
