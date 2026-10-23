import argparse
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location("ci_build", Path(__file__).with_name("build.py"))
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class BuilderFallbackTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.output = Path(self.temporary.name)
        self.archive = self.output / "source.tar"
        self.args = argparse.Namespace(host="acer-server", mode="image", platform="linux/amd64",
                                       version="dev", repository="owner/repo", timeout=60)

    def test_healthy_primary_never_invokes_local_builder(self):
        with patch.object(build, "run_remote") as remote, patch.object(build, "run_local") as local:
            self.assertEqual(build.build_with_fallback(self.args, self.archive, self.output, "sha"),
                             "acer-server")
            remote.assert_called_once_with(self.args, self.archive, self.output, "sha")
            local.assert_not_called()

    def test_connection_build_and_timeout_failures_retry_the_full_pipeline(self):
        for failure in (OSError("offline"), subprocess.CalledProcessError(1, "ssh"),
                        subprocess.TimeoutExpired("ssh", 60)):
            with self.subTest(failure=failure), patch.object(build, "run_remote", side_effect=failure), \
                    patch.object(build, "run_local") as local:
                self.assertEqual(build.build_with_fallback(self.args, self.archive, self.output, "sha"),
                                 "local")
                local.assert_called_once_with(self.args, self.archive, self.output, "sha")

    def test_partial_primary_artifacts_are_removed_before_local_retry(self):
        for name in ("image.tar.gz", "image-reference.txt"):
            (self.output / name).write_text("incomplete")

        def local(*_):
            self.assertFalse((self.output / "image.tar.gz").exists())
            self.assertFalse((self.output / "image-reference.txt").exists())

        with patch.object(build, "run_remote", side_effect=OSError("transfer failed")), \
                patch.object(build, "run_local", side_effect=local):
            build.build_with_fallback(self.args, self.archive, self.output, "sha")

    def test_local_failure_is_not_converted_to_success(self):
        with patch.object(build, "run_remote", side_effect=OSError("offline")), \
                patch.object(build, "run_local", side_effect=subprocess.CalledProcessError(1, "tests")):
            with self.assertRaises(subprocess.CalledProcessError):
                build.build_with_fallback(self.args, self.archive, self.output, "sha")

    def test_cancellation_does_not_start_another_build(self):
        with patch.object(build, "run_remote", side_effect=KeyboardInterrupt), \
                patch.object(build, "run_local") as local:
            with self.assertRaises(KeyboardInterrupt):
                build.build_with_fallback(self.args, self.archive, self.output, "sha")
            local.assert_not_called()

    def test_remote_cleanup_runs_even_when_build_fails(self):
        calls = []

        def command(arguments, **_):
            calls.append(arguments)
            if "mktemp -d /tmp/cch-ci.XXXXXXXX" in arguments:
                return subprocess.CompletedProcess(arguments, 0, "/tmp/cch-ci.test\n")
            if arguments[0] == "ssh" and "timeout" in arguments[-1]:
                raise subprocess.CalledProcessError(1, arguments)
            return subprocess.CompletedProcess(arguments, 0)

        with patch.object(build, "run", side_effect=command):
            with self.assertRaises(subprocess.CalledProcessError):
                build.run_remote(self.args, self.archive, self.output, "sha")
        self.assertEqual(calls[-1][-1], "rm -rf -- /tmp/cch-ci.test")

    def test_check_mode_does_not_download_an_image(self):
        self.args.mode = "check"
        with patch.object(build, "run", return_value=subprocess.CompletedProcess([], 0, "/tmp/cch-ci.test\n")) as run:
            build.run_remote(self.args, self.archive, self.output, "sha")
        scp_calls = [call for call in run.call_args_list if call.args[0][0] == "scp"]
        self.assertEqual(len(scp_calls), 1)

    def test_remote_metadata_is_shell_quoted(self):
        self.args.version = "dev; touch /tmp/should-not-exist"
        with patch.object(build, "run", return_value=subprocess.CompletedProcess([], 0, "/tmp/cch-ci.test\n")) as run:
            build.run_remote(self.args, self.archive, self.output, "sha")
        command = next(call.args[0][-1] for call in run.call_args_list
                       if call.args[0][0] == "ssh" and "timeout" in call.args[0][-1])
        self.assertIn("'dev; touch /tmp/should-not-exist'", command)

    def test_remote_success_downloads_only_image_artifacts(self):
        with patch.object(build, "run", return_value=subprocess.CompletedProcess([], 0, "/tmp/cch-ci.test\n")) as run:
            build.run_remote(self.args, self.archive, self.output, "sha")
        downloads = [call.args[0][-2] for call in run.call_args_list
                     if call.args[0][0] == "scp" and "/output/" in call.args[0][-2]]
        self.assertEqual(downloads, ["acer-server:/tmp/cch-ci.test/output/image.tar.gz",
                                    "acer-server:/tmp/cch-ci.test/output/image-reference.txt"])

    def test_cleanup_disconnect_does_not_discard_successful_image(self):
        def command(arguments, **_):
            if arguments[-1].startswith("rm -rf"):
                raise OSError("connection lost")
            return subprocess.CompletedProcess(arguments, 0, "/tmp/cch-ci.test\n")

        with patch.object(build, "run", side_effect=command):
            build.run_remote(self.args, self.archive, self.output, "sha")

    def test_local_success_extracts_source_and_moves_completed_artifacts(self):
        with tarfile.open(self.archive, "w") as archive:
            info = tarfile.TarInfo("source.txt")
            info.size = 7
            archive.addfile(info, io.BytesIO(b"tracked"))

        def start(command, cwd, start_new_session):
            self.assertTrue(start_new_session)
            self.assertEqual(Path(cwd, "source.txt").read_text(), "tracked")
            Path(cwd, "output").mkdir()
            for name in ("image.tar.gz", "image-reference.txt"):
                Path(cwd, "output", name).write_text("built")
            return Mock(args=command, wait=Mock(return_value=0), poll=Mock(return_value=0))

        with patch.object(build.subprocess, "Popen", side_effect=start), patch.object(build, "run") as run:
            # Exercise extraction separately; Popen is also used by subprocess.run.
            def extract(command, **_):
                with tarfile.open(self.archive) as archive:
                    archive.extractall(command[-1])
            run.side_effect = extract
            build.run_local(self.args, self.archive, self.output, "sha")
        self.assertEqual((self.output / "image.tar.gz").read_text(), "built")

    def test_local_timeout_terminates_the_process_group(self):
        process = Mock(pid=123, wait=Mock(side_effect=[subprocess.TimeoutExpired("worker", 60), 143]),
                       poll=Mock(return_value=None))
        with patch.object(build, "run"), patch.object(build.subprocess, "Popen", return_value=process), \
                patch.object(build.os, "killpg") as kill:
            with self.assertRaises(subprocess.TimeoutExpired):
                build.run_local(self.args, self.archive, self.output, "sha")
        kill.assert_called_once_with(123, build.signal.SIGTERM)

    def test_local_hung_cleanup_is_killed_after_grace_period(self):
        process = Mock(pid=123, wait=Mock(side_effect=[subprocess.TimeoutExpired("worker", 60),
                                                     subprocess.TimeoutExpired("worker", 30), 137]),
                       poll=Mock(return_value=None))
        with patch.object(build, "run"), patch.object(build.subprocess, "Popen", return_value=process), \
                patch.object(build.os, "killpg") as kill:
            with self.assertRaises(subprocess.TimeoutExpired):
                build.run_local(self.args, self.archive, self.output, "sha")
        self.assertEqual(kill.call_count, 2)
        self.assertEqual(kill.call_args.args, (123, build.signal.SIGKILL))

    def test_local_nonzero_exit_remains_failure(self):
        process = Mock(args=["worker"], wait=Mock(return_value=1), poll=Mock(return_value=1))
        with patch.object(build, "run"), patch.object(build.subprocess, "Popen", return_value=process):
            with self.assertRaises(subprocess.CalledProcessError):
                build.run_local(self.args, self.archive, self.output, "sha")

    def test_main_records_digest_and_never_archives_uncommitted_secrets(self):
        source = self.output / "repository"
        source.mkdir()
        subprocess.run(["git", "init", "-q", str(source)], check=True)
        (source / "tracked.txt").write_text("source")
        subprocess.run(["git", "-C", str(source), "add", "tracked.txt"], check=True)
        subprocess.run(["git", "-C", str(source), "-c", "user.name=CI Test", "-c", "user.email=ci@example.invalid",
                        "commit", "-qm", "test snapshot"], check=True)
        (source / ".env").write_text("SECRET=must-not-leave-host")

        def execute(args, archive, output, revision):
            with tarfile.open(archive) as contents:
                self.assertEqual(contents.getnames(), ["tracked.txt"])
            (output / "image.tar.gz").write_bytes(b"image")
            return "acer-server"

        previous = Path.cwd()
        try:
            os.chdir(source)
            with patch.object(sys, "argv", ["build.py", "--output", str(self.output)]), \
                    patch.object(build, "build_with_fallback", side_effect=execute):
                build.main()
        finally:
            os.chdir(previous)
        metadata = json.loads((self.output / "build.json").read_text())
        self.assertEqual(metadata["builder"], "acer-server")
        self.assertEqual(metadata["platform"], "linux/amd64")
        self.assertEqual((self.output / "image.tar.gz.sha256").read_text(),
                         build.hashlib.sha256(b"image").hexdigest() + "  image.tar.gz\n")


if __name__ == "__main__":
    unittest.main()
