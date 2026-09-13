/*
 * Copyright 2026 Codey contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Android 10 and newer do not allow an application to execute code copied to
 * its writable data directory. Codey therefore packages this dispatcher and
 * every native command as an extracted JNI library, then creates ordinary
 * command-name symlinks to this dispatcher in app-private data.
 */

#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define NATIVE_DIRECTORY_ENV "CODEY_NVIM_NATIVE_DIR"
#define DATA_DIRECTORY_ENV "CODEY_NVIM_DATA_DIR"

#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1 << 0)
#endif

#define CLONE_CANCELLED 130
#define CLONE_POLL_MS 25
#define CLONE_TERMINATE_GRACE_MS 500

static volatile sig_atomic_t clone_signal_cancelled;

static void cancel_clone_signal(int signal_number) {
  (void)signal_number;
  clone_signal_cancelled = 1;
}

/* stdin is a control pipe held open by the app. EOF also catches app death. */
static int clone_cancelled(int timeout_ms) {
  if (clone_signal_cancelled) {
    return 1;
  }
  struct pollfd control = {.fd = STDIN_FILENO, .events = POLLIN};
  int result = poll(&control, 1, timeout_ms);
  if (clone_signal_cancelled) {
    return 1;
  }
  if (result < 0) {
    return errno == EINTR ? 0 : 1;
  }
  if (control.revents & (POLLHUP | POLLERR | POLLNVAL)) {
    return 1;
  }
  if (control.revents & POLLIN) {
    char ignored[128];
    ssize_t count = read(STDIN_FILENO, ignored, sizeof(ignored));
    return count == 0 || (count < 0 && errno != EINTR && errno != EAGAIN);
  }
  return 0;
}

static int write_clone_marker(const char *path, const char *outcome) {
  int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (fd < 0) {
    return -1;
  }
  size_t remaining = strlen(outcome);
  const char *next = outcome;
  int result = 0;
  while (remaining > 0) {
    ssize_t count = write(fd, next, remaining);
    if (count < 0 && errno == EINTR) {
      continue;
    }
    if (count <= 0) {
      result = -1;
      break;
    }
    next += count;
    remaining -= (size_t)count;
  }
  if (result == 0 && fsync(fd) != 0) {
    result = -1;
  }
  if (close(fd) != 0) {
    result = -1;
  }
  if (result != 0) {
    unlink(path);
  }
  return result;
}

static int finish_clone(const char *marker, const char *outcome, int exit_code) {
  if (write_clone_marker(marker, outcome) != 0) {
    fprintf(stderr, "codey-clone: cannot record completion: %s\n", strerror(errno));
    return 1;
  }
  return exit_code;
}

static void terminate_clone_group(pid_t leader, int graceful) {
  /* The leader stays unreaped until after our last group signal. Its retained
   * PID prevents another process group from reusing this group identifier. */
  if (graceful) {
    kill(-leader, SIGTERM);
    struct timespec grace = {.tv_sec = 0,
                            .tv_nsec = CLONE_TERMINATE_GRACE_MS * 1000000L};
    while (nanosleep(&grace, &grace) != 0 && errno == EINTR) {
    }
  }
  kill(-leader, SIGKILL);
}

static int reap_clone_children(void) {
  /* Subreaper adoption includes orphaned Git transport/helper descendants.
   * Never authorize filesystem cleanup unless every owned process is gone. */
  for (;;) {
    if (waitpid(-1, NULL, 0) >= 0) {
      continue;
    }
    if (errno == EINTR) {
      continue;
    }
    return errno == ECHILD ? 0 : -1;
  }
}

static int promote_clone(const char *staging, const char *destination) {
#ifdef SYS_renameat2
  return (int)syscall(SYS_renameat2, AT_FDCWD, staging, AT_FDCWD, destination,
                      RENAME_NOREPLACE);
#else
  (void)staging;
  (void)destination;
  errno = ENOSYS;
  return -1;
#endif
}

static int supervise_clone(int argc, char **argv) {
  /* argv: dispatcher --codey-clone git-alias stage destination marker url */
  if (argc != 7 || argv[2][0] != '/' || argv[3][0] != '/' ||
      argv[4][0] != '/' || argv[5][0] != '/' ||
      strncmp(argv[6], "https://github.com/", 19) != 0) {
    fprintf(stderr, "codey-clone: invalid clone arguments\n");
    return 1;
  }
  const char *marker = argv[5];
  struct sigaction cancel_action = {.sa_handler = cancel_clone_signal};
  struct sigaction child_action = {.sa_handler = SIG_DFL};
  sigemptyset(&cancel_action.sa_mask);
  sigemptyset(&child_action.sa_mask);
  if (sigaction(SIGTERM, &cancel_action, NULL) != 0 ||
      sigaction(SIGINT, &cancel_action, NULL) != 0 ||
      sigaction(SIGHUP, &cancel_action, NULL) != 0 ||
      sigaction(SIGCHLD, &child_action, NULL) != 0 ||
      prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0) {
    fprintf(stderr, "codey-clone: cannot configure supervisor: %s\n", strerror(errno));
    return finish_clone(marker, "failed", 1);
  }
  signal(SIGPIPE, SIG_IGN);
  unsetenv("LD_PRELOAD");
  if (clone_cancelled(0)) {
    return finish_clone(marker, "cancelled", CLONE_CANCELLED);
  }

  pid_t leader = fork();
  if (leader < 0) {
    fprintf(stderr, "codey-clone: cannot launch Git: %s\n", strerror(errno));
    return finish_clone(marker, "failed", 1);
  }
  if (leader == 0) {
    if (setpgid(0, 0) != 0) {
      _exit(127);
    }
    signal(SIGTERM, SIG_DFL);
    signal(SIGINT, SIG_DFL);
    signal(SIGHUP, SIG_DFL);
    signal(SIGPIPE, SIG_DFL);
    int null_input = open("/dev/null", O_RDONLY | O_CLOEXEC);
    if (null_input < 0 || dup2(null_input, STDIN_FILENO) < 0 ||
        dup2(STDERR_FILENO, STDOUT_FILENO) < 0) {
      _exit(127);
    }
    if (null_input != STDIN_FILENO) {
      close(null_input);
    }
    char *git_argv[] = {argv[2], "clone", "--progress", "--", argv[6], argv[3], NULL};
    execv(git_argv[0], git_argv);
    fprintf(stderr, "codey-clone: cannot execute Git: %s\n", strerror(errno));
    _exit(127);
  }

  /* Both sides set the group, so cancellation cannot race child setup. If
   * exec already won, the child has necessarily set its group first. */
  if (setpgid(leader, leader) != 0 && errno != EACCES && errno != ESRCH) {
    kill(leader, SIGKILL);
    if (reap_clone_children() != 0) {
      return 1;
    }
    return finish_clone(marker, "failed", 1);
  }

  int cancelled = 0;
  int successful = 0;
  for (;;) {
    if (clone_cancelled(CLONE_POLL_MS)) {
      cancelled = 1;
      break;
    }
    siginfo_t status;
    memset(&status, 0, sizeof(status));
    if (waitid(P_PID, (id_t)leader, &status, WEXITED | WNOHANG | WNOWAIT) != 0) {
      if (errno == EINTR) {
        continue;
      }
      /* Without the retained leader we cannot safely signal a group ID or
       * attest that its descendants have exited. Leave no cleanup marker. */
      fprintf(stderr, "codey-clone: cannot observe Git process: %s\n", strerror(errno));
      return 1;
    }
    if (status.si_pid == leader) {
      successful = status.si_code == CLD_EXITED && status.si_status == 0;
      break;
    }
  }

  terminate_clone_group(leader, cancelled);
  if (reap_clone_children() != 0) {
    return 1;
  }
  /* Stop accepting asynchronous signal cancellation while committing the
   * result. A signal handled before this point is reflected in the flag;
   * one arriving after it stays pending until this short-lived process exits. */
  sigset_t finalization_signals;
  sigemptyset(&finalization_signals);
  sigaddset(&finalization_signals, SIGTERM);
  sigaddset(&finalization_signals, SIGINT);
  sigaddset(&finalization_signals, SIGHUP);
  if (sigprocmask(SIG_BLOCK, &finalization_signals, NULL) != 0) {
    return finish_clone(marker, "failed", 1);
  }
  cancelled = cancelled || clone_cancelled(0);
  if (cancelled) {
    return finish_clone(marker, "cancelled", CLONE_CANCELLED);
  }
  if (!successful) {
    return finish_clone(marker, "failed", 1);
  }
  /* This is the final cancellation acceptance point. Completion wins once
   * the atomic no-replace promotion starts. Never use an overwriting rename
   * fallback on filesystems/kernels that cannot provide this operation. */
  if (promote_clone(argv[3], argv[4]) != 0) {
    fprintf(stderr, "codey-clone: cannot finalize checkout: %s\n", strerror(errno));
    return finish_clone(marker, "failed", 1);
  }
  return finish_clone(marker, "success", 0);
}

struct native_command {
  const char *alias;
  const char *library;
};

static const struct native_command native_commands[] = {
    {"git", "libcodey_git.so"},
    {"git-remote-http", "libcodey_git_remote_http.so"},
    {"git-remote-https", "libcodey_git_remote_http.so"},
    {"git-sh-i18n--envsubst", "libcodey_git_envsubst.so"},
    {"rg", "libcodey_rg.so"},
    {"stylua", "libcodey_stylua.so"},
    {"lua-language-server", "libcodey_lua_language_server.so"},
};

static const char *command_name(const char *argv0) {
  const char *separator = strrchr(argv0, '/');
  return separator == NULL ? argv0 : separator + 1;
}

static int join_path(char *output, size_t output_size, const char *root,
                     const char *relative) {
  if (root == NULL || root[0] != '/') {
    return -1;
  }

  int length = snprintf(output, output_size, "%s/%s", root, relative);
  return length < 0 || (size_t)length >= output_size ? -1 : 0;
}

static int fail(const char *command, const char *message) {
  fprintf(stderr, "codey-exec-dispatcher: %s: %s\n", command, message);
  return 127;
}

static int exec_native(const char *command, const char *library, char **argv) {
  const char *native_directory = getenv(NATIVE_DIRECTORY_ENV);
  char executable[PATH_MAX];
  if (join_path(executable, sizeof(executable), native_directory, library) != 0) {
    return fail(command, "missing or invalid " NATIVE_DIRECTORY_ENV);
  }

  unsetenv("LD_PRELOAD");
  execv(executable, argv);

  char message[PATH_MAX + 64];
  snprintf(message, sizeof(message), "cannot execute %s: %s", executable,
           strerror(errno));
  return fail(command, message);
}

static int exec_git_submodule(const char *command, int argc, char **argv) {
  const char *data_directory = getenv(DATA_DIRECTORY_ENV);
  char script[PATH_MAX];
  if (join_path(script, sizeof(script), data_directory,
                "codey-tools/git-core/git-submodule") != 0) {
    return fail(command, "missing or invalid " DATA_DIRECTORY_ENV);
  }

  size_t argument_count = (size_t)argc + 2;
  char **shell_argv = calloc(argument_count, sizeof(*shell_argv));
  if (shell_argv == NULL) {
    return fail(command, "out of memory");
  }

  shell_argv[0] = "/system/bin/sh";
  shell_argv[1] = script;
  for (int index = 1; index < argc; ++index) {
    shell_argv[index + 1] = argv[index];
  }
  shell_argv[argc + 1] = NULL;

  unsetenv("LD_PRELOAD");
  execv(shell_argv[0], shell_argv);

  char message[PATH_MAX + 64];
  snprintf(message, sizeof(message), "cannot run %s: %s", script,
           strerror(errno));
  free(shell_argv);
  return fail(command, message);
}

int main(int argc, char **argv) {
  if (argc < 1 || argv == NULL || argv[0] == NULL || argv[0][0] == '\0') {
    return fail("unknown", "missing argv[0]");
  }

  if (argc > 1 && strcmp(argv[1], "--codey-clone") == 0) {
    return supervise_clone(argc, argv);
  }

  const char *command = command_name(argv[0]);
  if (strcmp(command, "git-submodule") == 0) {
    return exec_git_submodule(command, argc, argv);
  }

  size_t command_count = sizeof(native_commands) / sizeof(native_commands[0]);
  for (size_t index = 0; index < command_count; ++index) {
    if (strcmp(command, native_commands[index].alias) == 0) {
      return exec_native(command, native_commands[index].library, argv);
    }
  }

  return fail(command, "unsupported command alias");
}
