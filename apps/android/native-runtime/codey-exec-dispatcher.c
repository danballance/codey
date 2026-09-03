/*
 * Copyright 2026 Codey contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Android 10 and newer do not allow an application to execute code copied to
 * its writable data directory. Codey therefore packages this dispatcher and
 * every native command as an extracted JNI library, then creates ordinary
 * command-name symlinks to this dispatcher in app-private data.
 */

#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define NATIVE_DIRECTORY_ENV "CODEY_NVIM_NATIVE_DIR"
#define DATA_DIRECTORY_ENV "CODEY_NVIM_DATA_DIR"

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
