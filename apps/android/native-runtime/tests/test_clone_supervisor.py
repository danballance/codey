#!/usr/bin/env python3
"""Linux host checks for the APK dispatcher; no Git network access required.

Run: python3 apps/android/native-runtime/tests/test_clone_supervisor.py
"""

import ctypes
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest


FAKE_GIT = r'''
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

root = Path(os.environ["CLONE_TEST_ROOT"])
mode = os.environ["CLONE_TEST_MODE"]
assert sys.argv[1:5] == ["clone", "--progress", "--", "https://github.com/example/project.git"]
assert len(sys.argv) == 6
assert os.read(0, 1) == b""
assert "LD_PRELOAD" not in os.environ
stage = Path(sys.argv[5])
stage.mkdir()
(stage / "README.md").write_text("cloned contents")
(root / "leader.pid").write_text(str(os.getpid()))
print("clone stdout", flush=True)
print("clone progress", file=sys.stderr, flush=True)
if mode in ("slow", "resistant", "orphan"):
    child = subprocess.Popen([
        sys.executable, "-c",
        "import os,signal,time; from pathlib import Path; "
        "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
        "Path(os.environ['CLONE_TEST_ROOT'], 'helper.pid').write_text(str(os.getpid())); "
        "time.sleep(60)",
    ])
    while not (root / "helper.pid").exists():
        time.sleep(0.005)
    if mode == "resistant":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    (root / "ready").touch()
    if mode == "orphan":
        sys.exit(0)
    time.sleep(60)
if mode == "failure":
    sys.exit(42)
'''


class CloneSupervisorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if sys.platform != "linux":
            raise unittest.SkipTest("The APK supervisor requires Linux process semantics")
        compiler = shutil.which(os.environ.get("CC", "cc"))
        if compiler is None:
            raise RuntimeError("A C compiler is required")
        cls.build_dir = tempfile.TemporaryDirectory(prefix="codey-clone-build-")
        cls.dispatcher = Path(cls.build_dir.name) / "codey-exec-dispatcher"
        source = Path(__file__).resolve().parents[1] / "codey-exec-dispatcher.c"
        subprocess.run([
            compiler, "-std=c17", "-D_POSIX_C_SOURCE=200809L", "-O2",
            "-Wall", "-Wextra", "-Werror", str(source), "-o", str(cls.dispatcher),
        ], check=True)
        unavailable_rename = Path(cls.build_dir.name) / "unavailable-rename.c"
        unavailable_rename.write_text(
            "#include <errno.h>\n"
            "long __wrap_syscall(long number, ...) { (void)number; errno = ENOSYS; return -1; }\n"
        )
        cls.no_rename_dispatcher = Path(cls.build_dir.name) / "dispatcher-no-rename"
        subprocess.run([
            compiler, "-std=c17", "-D_POSIX_C_SOURCE=200809L", "-O2",
            "-Wall", "-Wextra", "-Werror", str(source), str(unavailable_rename),
            "-Wl,--wrap=syscall", "-o", str(cls.no_rename_dispatcher),
        ], check=True)
        # Adopt the supervisor after the simulated app abruptly exits, so this
        # test can reap it even on hosts whose PID 1 does not reap orphans.
        if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
            raise RuntimeError("Cannot establish test subreaper")

    @classmethod
    def tearDownClass(cls):
        cls.build_dir.cleanup()

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory(prefix="codey clone test ")
        self.addCleanup(self.temp_dir.cleanup)
        self.root = Path(self.temp_dir.name)
        self.git = self.root / "git alias"
        self.git.write_text(f"#!{sys.executable}\n" + FAKE_GIT)
        self.git.chmod(0o700)
        self.stage = self.root / "staging repository"
        self.destination = self.root / "final repository"
        self.marker = self.root / "quiescent"

    def command(self):
        return [str(self.dispatcher), "--codey-clone", str(self.git),
                str(self.stage), str(self.destination), str(self.marker),
                "https://github.com/example/project.git"]

    def environment(self, mode):
        return {**os.environ, "LD_PRELOAD": "", "CLONE_TEST_ROOT": str(self.root),
                "CLONE_TEST_MODE": mode}

    def launch(self, mode="success", **kwargs):
        process = subprocess.Popen(self.command(), stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   env=self.environment(mode), **kwargs)
        self.addCleanup(self.stop_process, process)
        return process

    @staticmethod
    def stop_process(process):
        if process.poll() is None:
            if process.stdin and not process.stdin.closed:
                process.stdin.close()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)
        for pipe in (process.stdin, process.stdout, process.stderr):
            if pipe and not pipe.closed:
                pipe.close()

    def await_file(self, path, timeout=5):
        deadline = time.monotonic() + timeout
        while not path.exists():
            if time.monotonic() >= deadline:
                self.fail(f"Timed out waiting for {path.name}")
            time.sleep(0.01)

    def assert_processes_gone(self):
        for file in self.root.glob("*.pid"):
            pid = int(file.read_text())
            with self.assertRaises(ProcessLookupError, msg=f"Process {pid} from {file.name} survived"):
                os.kill(pid, 0)

    def assert_outcome(self, process, code, marker):
        self.assertEqual(process.wait(timeout=5), code)
        self.assertEqual(self.marker.read_text(), marker)
        self.assertEqual(process.stdout.read(), b"")
        self.assert_processes_gone()

    def test_success_uses_safe_arguments_and_promotes_checkout(self):
        process = self.launch()
        self.assert_outcome(process, 0, "success")
        self.assertEqual((self.destination / "README.md").read_text(), "cloned contents")
        self.assertFalse(self.stage.exists())
        diagnostics = process.stderr.read()
        self.assertIn(b"clone progress", diagnostics)
        self.assertIn(b"clone stdout", diagnostics)

    def test_git_failure_leaves_stage_for_verified_cleanup(self):
        process = self.launch("failure")
        self.assert_outcome(process, 1, "failed")
        self.assertTrue(self.stage.exists())
        self.assertFalse(self.destination.exists())

    def test_existing_destination_is_never_replaced(self):
        self.destination.mkdir()
        (self.destination / "keep.txt").write_text("user files")
        process = self.launch()
        self.assert_outcome(process, 1, "failed")
        self.assertEqual((self.destination / "keep.txt").read_text(), "user files")
        self.assertFalse((self.destination / "README.md").exists())
        self.assertTrue(self.stage.exists())

    def test_existing_empty_directory_is_not_replaced(self):
        self.destination.mkdir()
        process = self.launch()
        self.assert_outcome(process, 1, "failed")
        self.assertEqual(list(self.destination.iterdir()), [])
        self.assertTrue(self.stage.exists())

    def test_destination_symlink_is_not_replaced(self):
        self.destination.symlink_to(self.root / "elsewhere")
        process = self.launch()
        self.assert_outcome(process, 1, "failed")
        self.assertTrue(self.destination.is_symlink())

    def test_unsupported_atomic_promotion_keeps_staging_and_reports_failure(self):
        self.dispatcher = self.no_rename_dispatcher
        process = self.launch()
        self.assert_outcome(process, 1, "failed")
        self.assertTrue(self.stage.exists())
        self.assertFalse(self.destination.exists())
        self.assertIn(b"cannot finalize checkout", process.stderr.read())

    def test_close_control_pipe_cancels_git_and_helper(self):
        process = self.launch("slow")
        self.await_file(self.root / "ready")
        self.assertFalse(self.marker.exists())
        process.stdin.close()
        self.assert_outcome(process, 130, "cancelled")
        self.assertFalse(self.destination.exists())

    def test_sigterm_resistant_process_group_is_killed_and_reaped(self):
        process = self.launch("resistant")
        self.await_file(self.root / "ready")
        process.stdin.close()
        self.assert_outcome(process, 130, "cancelled")
        self.assertFalse(self.destination.exists())

    def test_supervisor_termination_signal_cancels_safely(self):
        process = self.launch("resistant")
        self.await_file(self.root / "ready")
        process.send_signal(signal.SIGTERM)
        self.assert_outcome(process, 130, "cancelled")
        self.assertFalse(self.destination.exists())

    def test_git_success_reaps_orphaned_helper_before_marker(self):
        process = self.launch("orphan")
        self.assert_outcome(process, 0, "success")
        self.assertTrue(self.destination.exists())

    def test_closed_control_before_launch_cancels_without_git(self):
        process = subprocess.Popen(self.command(), stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   env=self.environment("success"))
        self.addCleanup(self.stop_process, process)
        self.assert_outcome(process, 130, "cancelled")
        self.assertFalse(self.stage.exists())
        self.assertFalse(self.destination.exists())

    def test_app_death_closes_control_and_cancels_descendants(self):
        app_script = r'''
import os, subprocess, sys, time
from pathlib import Path
root = Path(os.environ["CLONE_TEST_ROOT"])
with (root / "app.log").open("wb") as log:
    process = subprocess.Popen(sys.argv[1:], stdin=subprocess.PIPE,
                               stdout=log, stderr=log)
    (root / "supervisor").write_text(str(process.pid))
    while not (root / "ready").exists():
        time.sleep(0.005)
    os._exit(0)
'''
        app = subprocess.Popen([sys.executable, "-c", app_script, *self.command()],
                               env=self.environment("resistant"))
        self.addCleanup(self.stop_process, app)
        self.assertEqual(app.wait(timeout=5), 0)
        self.await_file(self.marker)
        supervisor = int((self.root / "supervisor").read_text())
        _, status = os.waitpid(supervisor, 0)
        self.assertEqual(os.waitstatus_to_exitcode(status), 130)
        self.assertEqual(self.marker.read_text(), "cancelled")
        self.assert_processes_gone()
        self.assertFalse(self.destination.exists())

    def test_invalid_command_creates_no_marker_or_checkout(self):
        result = subprocess.run([str(self.dispatcher), "--codey-clone"], capture_output=True)
        self.assertEqual(result.returncode, 1)
        self.assertFalse(self.marker.exists())
        self.assertFalse(self.stage.exists())

    def test_regular_git_alias_still_dispatches(self):
        library = self.root / "libcodey_git.so"
        library.write_text(f"#!{sys.executable}\nimport sys; print('|'.join(sys.argv[1:]))\n")
        library.chmod(0o700)
        git_alias = self.root / "git"
        git_alias.symlink_to(self.dispatcher)
        result = subprocess.run([str(git_alias), "status", "--short"], capture_output=True,
                                env={**os.environ, "CODEY_NVIM_NATIVE_DIR": str(self.root)})
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"status|--short\n")


if __name__ == "__main__":
    unittest.main(verbosity=2)
