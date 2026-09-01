/// <reference types="node" />
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MessagePackRpcClient } from "../../msgpack-rpc/src/index.js";
import type { DuplexTransport } from "../../transport/src/index.js";
import { MAX_HOST_DOCUMENT_BYTES, NvimSessionClient } from "../src/index.js";

const nvimBinary = process.env["CODEY_NVIM_BIN"] ?? "nvim";
const hasNvim = spawnSync(nvimBinary, ["--version"], { stdio: "ignore" }).status === 0;

// These tests never connect to a running editor or TCP endpoint. Each test owns
// an embedded --clean process and all files, state, and logs live in its temp dir.
describe.skipIf(!hasNvim || process.platform !== "linux")("isolated Neovim host documents", () => {
  let directory: string;
  let session: NvimSessionClient;
  let rpc: MessagePackRpcClient;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "codey-host-documents-"));
    rpc = new MessagePackRpcClient(new EmbeddedNvimTransport(directory));
    session = new NvimSessionClient(rpc);
    await session.connect();
  });

  afterEach(async () => {
    await session?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  function path(name = "pad.yaml"): string {
    return join(directory, name);
  }

  async function lua<T = unknown>(source: string, args: readonly unknown[] = []): Promise<T> {
    return rpc.request<T>("nvim_exec_lua", [source, args]);
  }

  it("loads a missing default without creating it, then directly creates it and its parents", async () => {
    const defaultPath = await session.defaultActionPadPath();
    expect(defaultPath).toBe(path("config/nvim/codey/action-pad.yaml"));
    expect(await session.readHostDocument(defaultPath)).toEqual({ path: defaultPath, text: null });
    await expect(stat(dirname(defaultPath))).rejects.toMatchObject({ code: "ENOENT" });

    await expect(session.writeHostDocument({
      path: defaultPath,
      text: "version: 1\n",
    })).resolves.toBeUndefined();

    expect(await readFile(defaultPath, "utf8")).toBe("version: 1\n");
    expect(await session.readHostDocument(defaultPath)).toEqual({
      path: defaultPath,
      text: "version: 1\n",
    });
    expect((await stat(defaultPath)).mode & 0o777).toBe(0o600);
  });

  it("round-trips UTF-8 and truncates shorter and empty overwrites in place", async () => {
    const text = "label: '✓ \u{f0311} 😀'\r\ninput: '<C-w>h'\n";
    await session.writeHostDocument({ path: path(), text });
    expect(await session.readHostDocument(path())).toEqual({ path: path(), text });

    await chmod(path(), 0o640);
    await session.writeHostDocument({ path: path(), text: "label: x\n" });
    expect(await readFile(path(), "utf8")).toBe("label: x\n");
    expect((await stat(path())).mode & 0o777).toBe(0o640);

    await session.writeHostDocument({ path: path(), text: "" });
    expect(await readFile(path(), "utf8")).toBe("");
    expect(await session.readHostDocument(path())).toEqual({ path: path(), text: "" });
    expect((await readdir(directory)).filter((name) => name.startsWith(".codey-action-pad-")))
      .toEqual([]);
  });

  it("uses only a direct file write and file fsync", async () => {
    await lua([
      "_G.codey_sync_events = {}",
      "local original_sync = vim.uv.fs_fsync",
      "vim.uv.fs_fsync = function(fd)",
      "  table.insert(_G.codey_sync_events, assert(vim.uv.fs_fstat(fd)).type)",
      "  return original_sync(fd)",
      "end",
      "vim.uv.fs_mkstemp = function() error('temporary file must not be created') end",
      "vim.uv.fs_link = function() error('hard link must not be created') end",
      "vim.uv.fs_rename = function() error('rename must not be used') end",
    ].join("\n"));

    await session.writeHostDocument({
      path: path("new/nested/pad.yaml"),
      text: "label: direct\n",
    });

    expect(await lua("return _G.codey_sync_events")).toEqual(["file"]);
    expect(await readFile(path("new/nested/pad.yaml"), "utf8")).toBe("label: direct\n");
    expect((await readdir(path("new/nested"))).filter((name) => name.startsWith(".codey-")))
      .toEqual([]);
  });

  it("retries short writes until all bytes have been written", async () => {
    await lua([
      "local original = vim.uv.fs_write",
      "vim.uv.fs_write = function(fd, data, offset)",
      "  return original(fd, data:sub(1, 3), offset)",
      "end",
    ].join("\n"));

    const text = "label: every byte is retained\n";
    await session.writeHostDocument({ path: path(), text });
    expect(await readFile(path(), "utf8")).toBe(text);
  });

  it("reports that a failed direct write may have left partial content", async () => {
    await writeFile(path(), "label: original\n");
    await lua([
      "local original = vim.uv.fs_write",
      "local calls = 0",
      "vim.uv.fs_write = function(fd, data, offset)",
      "  calls = calls + 1",
      "  if calls == 1 then return original(fd, data:sub(1, 5), offset) end",
      "  return nil, 'injected write failure', 'EIO'",
      "end",
    ].join("\n"));

    await expect(session.writeHostDocument({
      path: path(),
      text: "label: replacement\n",
    })).rejects.toMatchObject({
      code: "io",
      message: expect.stringContaining("may be incomplete"),
    });
    expect(await readFile(path(), "utf8")).toBe("label");
  });

  it("treats quotes, command-like text, and dollar signs as literal data", async () => {
    const filename = path("'; error('not executable') -- ${HOME}.yaml");
    const text = "label: \"'); vim.cmd('quit!'); --\"\n";
    await session.writeHostDocument({ path: filename, text });
    expect(await readFile(filename, "utf8")).toBe(text);
    expect(await session.readHostDocument(filename)).toEqual({ path: filename, text });
  });

  it("expands ~/ and follows directory and file symlinks using normal filesystem semantics", async () => {
    await mkdir(path("real"));
    await symlink(path("real"), path("alias"), "dir");
    await writeFile(path("real/pad.yaml"), "version: 1\n");
    const tildePath = "~/" + relative(homedir(), path("alias/pad.yaml"));

    expect(await session.readHostDocument(tildePath)).toEqual({
      path: homedir() + "/" + relative(homedir(), path("alias/pad.yaml")),
      text: "version: 1\n",
    });
    await session.writeHostDocument({ path: tildePath, text: "version: 2\n" });
    expect(await readlink(path("alias"))).toBe(path("real"));
    expect(await readFile(path("real/pad.yaml"), "utf8")).toBe("version: 2\n");

    await writeFile(path("target.yaml"), "label: old\n");
    await symlink(path("target.yaml"), path("linked.yaml"));
    await session.writeHostDocument({ path: path("linked.yaml"), text: "label: new\n" });
    expect((await lstat(path("linked.yaml"))).isSymbolicLink()).toBe(true);
    expect(await readFile(path("target.yaml"), "utf8")).toBe("label: new\n");
  });

  it("uses last-writer-wins for existing, externally changed, and recreated files", async () => {
    await session.writeHostDocument({ path: path(), text: "label: app one\n" });
    await writeFile(path(), "label: external\n");
    await session.writeHostDocument({ path: path(), text: "label: app two\n" });
    expect(await readFile(path(), "utf8")).toBe("label: app two\n");
  });

  it("overwrites disk even when a matching Neovim buffer has unsaved changes", async () => {
    await writeFile(path(), "label: disk\n");
    const buffer = await lua<number>([
      "local path = ...",
      "local buffer = vim.fn.bufadd(path)",
      "vim.fn.bufload(buffer)",
      "vim.api.nvim_set_current_buf(buffer)",
      "vim.api.nvim_buf_set_lines(buffer, 0, -1, false, {'label: unsaved'})",
      "return buffer",
    ].join("\n"), [path()]);

    await session.writeHostDocument({ path: path(), text: "label: app\n" });
    expect(await readFile(path(), "utf8")).toBe("label: app\n");
    expect(await lua("return vim.api.nvim_get_current_buf()")).toBe(buffer);
    expect(await rpc.request("nvim_buf_get_lines", [buffer, 0, -1, false]))
      .toEqual(["label: unsaved"]);
    expect(await rpc.request("nvim_get_option_value", ["modified", { buf: buffer }])).toBe(true);
  });

  it("bounds reads and writes at 1 MiB and rejects invalid UTF-8", async () => {
    const text = "é".repeat(MAX_HOST_DOCUMENT_BYTES / 2);
    await writeFile(path(), text);
    expect(await session.readHostDocument(path())).toEqual({ path: path(), text });
    await session.writeHostDocument({ path: path(), text });

    await writeFile(path(), text + "é");
    await expect(session.readHostDocument(path())).rejects.toMatchObject({ code: "too-large" });
    await expect(session.writeHostDocument({
      path: path("not-created/pad.yaml"),
      text: text + "é",
    })).rejects.toMatchObject({ code: "too-large" });
    await expect(stat(path("not-created"))).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(path(), Buffer.from([0xff, 0xfe]));
    await expect(session.readHostDocument(path())).rejects.toMatchObject({ code: "io" });
  });

  it("rejects directories, FIFOs, and non-directory parents", async () => {
    await mkdir(path("folder"));
    const fifo = path("fifo");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    await writeFile(path("parent"), "not a directory");

    await expect(session.readHostDocument(path("folder")))
      .rejects.toMatchObject({ code: "invalid-path" });
    await expect(session.readHostDocument(fifo)).rejects.toMatchObject({ code: "invalid-path" });
    await expect(session.writeHostDocument({ path: path("folder"), text: "no\n" }))
      .rejects.toMatchObject({ code: "invalid-path" });
    await expect(session.writeHostDocument({ path: fifo, text: "no\n" }))
      .rejects.toMatchObject({ code: "invalid-path" });
    await expect(session.writeHostDocument({ path: path("parent/pad.yaml"), text: "no\n" }))
      .rejects.toMatchObject({ code: "invalid-path" });
  });

  it("treats a broken symlink as missing on load and follows it when saving", async () => {
    await symlink(path("missing-target.yaml"), path("broken.yaml"));
    expect(await session.readHostDocument(path("broken.yaml"))).toEqual({
      path: path("broken.yaml"),
      text: null,
    });

    await session.writeHostDocument({ path: path("broken.yaml"), text: "label: created\n" });
    expect((await lstat(path("broken.yaml"))).isSymbolicLink()).toBe(true);
    expect(await readFile(path("missing-target.yaml"), "utf8")).toBe("label: created\n");
  });

  it("reports file and directory permission failures", async () => {
    await writeFile(path(), "label: protected\n", { mode: 0o400 });
    await expect(session.writeHostDocument({ path: path(), text: "label: refused\n" }))
      .rejects.toMatchObject({ code: "permission" });
    expect(await readFile(path(), "utf8")).toBe("label: protected\n");

    await mkdir(path("readonly"), { mode: 0o500 });
    try {
      await expect(session.writeHostDocument({
        path: path("readonly/pad.yaml"),
        text: "version: 1\n",
      })).rejects.toMatchObject({ code: "permission" });
    } finally {
      await chmod(path("readonly"), 0o700);
    }
  });
});

class EmbeddedNvimTransport implements DuplexTransport {
  readonly #dataListeners = new Set<(data: Uint8Array) => void>();
  readonly #closeListeners = new Set<(error?: Error) => void>();
  #process: ChildProcessWithoutNullStreams | undefined;
  #closed = false;
  #stderr = "";

  public constructor(private readonly directory: string) {}

  public async connect(): Promise<void> {
    const child = spawn(nvimBinary, ["--clean", "--headless", "--embed", "-i", "NONE", "-n"], {
      cwd: this.directory,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(this.directory, "config"),
        XDG_CACHE_HOME: join(this.directory, "cache"),
        XDG_STATE_HOME: join(this.directory, "state"),
        XDG_DATA_HOME: join(this.directory, "data"),
        XDG_RUNTIME_DIR: this.directory,
        NVIM_APPNAME: "nvim",
        NVIM_LOG_FILE: join(this.directory, "nvim.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#process = child;
    child.stdout.on("data", (data: Buffer) => {
      for (const listener of this.#dataListeners) listener(data);
    });
    child.stderr.on("data", (data: Buffer) => { this.#stderr += data.toString(); });
    child.on("error", (error) => {
      for (const listener of this.#closeListeners) listener(error);
    });
    child.on("close", (code) => {
      if (this.#closed) return;
      for (const listener of this.#closeListeners) {
        listener(new Error("Isolated Neovim exited: " + code + "\n" + this.#stderr));
      }
    });
    await once(child, "spawn");
  }

  public async write(data: Uint8Array): Promise<void> {
    const child = this.#process;
    if (!child || this.#closed) throw new Error("Isolated Neovim is closed");
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(data, (error) => error ? reject(error) : resolve());
    });
  }

  public onData(listener: (data: Uint8Array) => void): () => void {
    this.#dataListeners.add(listener);
    return () => this.#dataListeners.delete(listener);
  }

  public onClose(listener: (error?: Error) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const child = this.#process;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "close");
    child.kill("SIGTERM");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 1000);
    timeout.unref();
    try { await exited; } finally { clearTimeout(timeout); }
  }
}
