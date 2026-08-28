/// <reference types="node" />
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MessagePackRpcClient } from "../../msgpack-rpc/src/index.js";
import type { DuplexTransport } from "../../transport/src/index.js";
import { MAX_HOST_DOCUMENT_BYTES, NvimSessionClient, type HostDocument } from "../src/index.js";

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

  function save(document: HostDocument, text: string): Promise<HostDocument> {
    return session.writeHostDocument({
      path: document.path,
      text,
      expectedRevision: document.revision,
      expectedResolvedPath: document.resolvedPath,
    });
  }

  async function lua<T = unknown>(source: string, args: readonly unknown[] = []): Promise<T> {
    return rpc.request<T>("nvim_exec_lua", [source, args]);
  }

  it("resolves the host default and missing paths without creating files or parents", async () => {
    const defaultPath = await session.defaultActionPadPath();
    expect(defaultPath).toBe(path("config/nvim/codey/action-pad.yaml"));
    expect(await session.readHostDocument(defaultPath)).toEqual({
      path: defaultPath, resolvedPath: defaultPath, text: null, revision: null,
    });
    await expect(stat(dirname(defaultPath))).rejects.toMatchObject({ code: "ENOENT" });
    const saved = await session.writeHostDocument({
      path: defaultPath, text: "version: 1\n", expectedRevision: null,
    });
    expect(saved.text).toBe("version: 1\n");
    expect(await readFile(defaultPath, "utf8")).toBe(saved.text);
    expect((await stat(defaultPath)).mode & 0o777).toBe(0o600);
  });

  it("round-trips raw UTF-8, computes content revisions, and truncates shorter replacements", async () => {
    const text = "label: '✓ \u{f0311} 😀'\r\ninput: '<C-w>h'\n";
    const initial = await session.writeHostDocument({ path: path(), text, expectedRevision: null });
    expect(initial.revision).toBe(createHash("sha256").update(text).digest("hex"));
    expect(await session.readHostDocument(path())).toEqual(initial);
    await chmod(path(), 0o640);
    const saved = await save(initial, "label: x\n");
    expect(await readFile(path(), "utf8")).toBe(saved.text);
    expect((await stat(path())).mode & 0o777).toBe(0o640);
    const empty = await save(saved, "");
    expect(empty.text).toBe("");
    expect(empty.revision).toBe(createHash("sha256").update("").digest("hex"));
    expect((await readdir(directory)).filter((name) => name.startsWith(".codey-action-pad-"))).toEqual([]);
  });

  it("syncs each new parent entry and the final directory after publishing creates and replacements", async () => {
    await lua([
      "_G.codey_sync_events = {}",
      "local original_sync = vim.uv.fs_fsync",
      "vim.uv.fs_fsync = function(fd)",
      "  table.insert(_G.codey_sync_events, assert(vim.uv.fs_fstat(fd)).type)",
      "  return original_sync(fd)",
      "end",
      "local original_link = vim.uv.fs_link",
      "vim.uv.fs_link = function(...)",
      "  local result, detail, code = original_link(...)",
      "  if result then table.insert(_G.codey_sync_events, 'publish') end",
      "  return result, detail, code",
      "end",
      "local original_rename = vim.uv.fs_rename",
      "vim.uv.fs_rename = function(...)",
      "  local result, detail, code = original_rename(...)",
      "  if result then table.insert(_G.codey_sync_events, 'publish') end",
      "  return result, detail, code",
      "end",
    ].join("\n"));
    const created = await session.writeHostDocument({
      path: path("new/nested/pad.yaml"), text: "label: created\n", expectedRevision: null,
    });
    await save(created, "label: replaced\n");

    expect(await lua("return _G.codey_sync_events")).toEqual([
      "directory", "directory", "file", "publish", "directory",
      "file", "publish", "directory",
    ]);
    expect(await readFile(created.path, "utf8")).toBe("label: replaced\n");
  });

  it.each([false, true])("reports an uncertain save when directory sync fails after publication (replace=%s)", async (replace) => {
    if (replace) await writeFile(path(), "label: original\n");
    const original = await session.readHostDocument(path());
    await lua([
      "local original = vim.uv.fs_fsync",
      "vim.uv.fs_fsync = function(fd)",
      "  if assert(vim.uv.fs_fstat(fd)).type == 'directory' then",
      "    return nil, 'injected directory sync failure', 'EACCES'",
      "  end",
      "  return original(fd)",
      "end",
    ].join("\n"));

    await expect(save(original, "label: published\n")).rejects.toMatchObject({
      code: "io", message: expect.stringContaining("result is uncertain"),
    });
    expect(await readFile(path(), "utf8")).toBe("label: published\n");
    expect((await readdir(directory)).filter((name) => name.startsWith(".codey-action-pad-"))).toEqual([]);
  });

  it("keeps a newly created ancestor sync failure before file publication", async () => {
    await lua([
      "vim.uv.fs_fsync = function() return nil, 'injected parent sync failure', 'EACCES' end",
    ].join("\n"));

    await expect(session.writeHostDocument({
      path: path("new/nested/pad.yaml"), text: "label: refused\n", expectedRevision: null,
    })).rejects.toMatchObject({ code: "permission" });
    await expect(stat(path("new/nested/pad.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports readback failure after publication as uncertain instead of a safe-to-retry permission error", async () => {
    await writeFile(path(), "label: original\n");
    const original = await session.readHostDocument(path());
    await lua([
      "local original = vim.uv.fs_rename",
      "vim.uv.fs_rename = function(...)",
      "  local result, detail, code = original(...)",
      "  if result then",
      "    vim.uv.fs_read = function() return nil, 'injected readback failure', 'EACCES' end",
      "  end",
      "  return result, detail, code",
      "end",
    ].join("\n"));

    await expect(save(original, "label: published\n")).rejects.toMatchObject({
      code: "io", message: expect.stringContaining("result is uncertain"),
    });
    expect(await readFile(path(), "utf8")).toBe("label: published\n");
    expect((await readdir(directory)).filter((name) => name.startsWith(".codey-action-pad-"))).toEqual([]);
  });

  it("treats quotes, command-like text, and dollar signs as literal path/content data", async () => {
    const filename = path("'; error('not executable') -- ${HOME}.yaml");
    const text = "label: \"'); vim.cmd('quit!'); --\"\n";
    const saved = await session.writeHostDocument({ path: filename, text, expectedRevision: null });
    expect(await readFile(filename, "utf8")).toBe(text);
    expect(await session.readHostDocument(filename)).toEqual(saved);
  });

  it("expands ~/ on the host and canonicalizes parent directory symlinks", async () => {
    await mkdir(path("real"));
    await symlink(path("real"), path("alias"), "dir");
    await writeFile(path("real/pad.yaml"), "version: 1\n");
    const tildePath = "~/" + relative(homedir(), path("alias/pad.yaml"));
    const document = await session.readHostDocument(tildePath);
    expect(document.resolvedPath).toBe(path("real/pad.yaml"));
    await save(document, "version: 2\n");
    expect(await readlink(path("alias"))).toBe(path("real"));
    expect(await readFile(path("real/pad.yaml"), "utf8")).toBe("version: 2\n");
  });

  it("preserves file symlinks and refuses changed targets even when their content matches", async () => {
    await writeFile(path("first.yaml"), "label: old\n");
    await writeFile(path("second.yaml"), "label: next\n");
    await symlink(path("first.yaml"), path());
    const original = await session.readHostDocument(path());
    expect(original.resolvedPath).toBe(path("first.yaml"));
    const saved = await save(original, "label: next\n");
    expect((await lstat(path())).isSymbolicLink()).toBe(true);
    expect(await readlink(path())).toBe(path("first.yaml"));
    await unlink(path());
    await symlink(path("second.yaml"), path());
    await expect(save(saved, "label: refused\n")).rejects.toMatchObject({ code: "conflict" });
    expect(await readFile(path("first.yaml"), "utf8")).toBe("label: next\n");
    expect(await readFile(path("second.yaml"), "utf8")).toBe("label: next\n");
  });

  it("protects external changes, existing export targets, and deleted saved files", async () => {
    const original = await session.writeHostDocument({
      path: path(), text: "label: original\n", expectedRevision: null,
    });
    await expect(session.writeHostDocument({
      path: path(), text: "label: export\n", expectedRevision: null,
    })).rejects.toMatchObject({ code: "conflict" });
    await writeFile(path(), "label: external\n");
    await expect(save(original, "label: app\n")).rejects.toMatchObject({ code: "conflict" });
    expect(await readFile(path(), "utf8")).toBe("label: external\n");
    await unlink(path());
    await expect(save(original, "label: app\n")).rejects.toMatchObject({ code: "conflict" });
    await expect(stat(path())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to overwrite a matching modified buffer, including through a symlink", async () => {
    await writeFile(path("real.yaml"), "label: disk\n");
    await symlink(path("real.yaml"), path());
    const original = await session.readHostDocument(path());
    const buffer = await lua<number>([
      "local path = ...",
      "local buffer = vim.fn.bufadd(path)",
      "vim.fn.bufload(buffer)",
      "vim.api.nvim_set_current_buf(buffer)",
      "vim.api.nvim_buf_set_lines(buffer, 0, -1, false, {'label: unsaved'})",
      "return buffer",
    ].join("\n"), [path("real.yaml")]);
    await expect(save(original, "label: app\n")).rejects.toMatchObject({ code: "modified-buffer" });
    expect(await readFile(path("real.yaml"), "utf8")).toBe("label: disk\n");
    expect(await lua("return vim.api.nvim_get_current_buf()")).toBe(buffer);
    expect(await rpc.request("nvim_buf_get_lines", [buffer, 0, -1, false])).toEqual(["label: unsaved"]);
    expect(await rpc.request("nvim_get_option_value", ["modified", { buf: buffer }])).toBe(true);
  });

  it("does not mutate an unmodified active editor buffer while replacing its disk file", async () => {
    await writeFile(path(), "label: disk\n");
    const original = await session.readHostDocument(path());
    const buffer = await lua<number>([
      "local path = ...",
      "local buffer = vim.fn.bufadd(path)",
      "vim.fn.bufload(buffer)",
      "vim.api.nvim_set_current_buf(buffer)",
      "return buffer",
    ].join("\n"), [path()]);
    await save(original, "label: app\n");
    expect(await lua("return vim.api.nvim_get_current_buf()")).toBe(buffer);
    expect(await rpc.request("nvim_buf_get_lines", [buffer, 0, -1, false])).toEqual(["label: disk"]);
    expect(await rpc.request("nvim_get_option_value", ["modified", { buf: buffer }])).toBe(false);
  });

  it("bounds reads and writes at 1 MiB and rejects invalid UTF-8", async () => {
    const text = "é".repeat(MAX_HOST_DOCUMENT_BYTES / 2);
    await writeFile(path(), text);
    const document = await session.readHostDocument(path());
    expect(document.text).toBe(text);
    await save(document, text);
    await writeFile(path(), text + "é");
    await expect(session.readHostDocument(path())).rejects.toMatchObject({ code: "too-large" });
    await expect(session.writeHostDocument({
      path: path("not-created/pad.yaml"), text: text + "é", expectedRevision: null,
    })).rejects.toMatchObject({ code: "too-large" });
    await expect(stat(path("not-created"))).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(path(), Buffer.from([0xff, 0xfe]));
    await expect(session.readHostDocument(path())).rejects.toMatchObject({ code: "io" });
  });

  it("rejects directories, FIFOs, and broken symlinks without replacing them", async () => {
    await mkdir(path("folder"));
    const fifo = path("fifo");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    await symlink(path("missing-target.yaml"), path("broken.yaml"));
    await expect(session.readHostDocument(path("folder"))).rejects.toMatchObject({ code: "invalid-path" });
    await expect(session.readHostDocument(fifo)).rejects.toMatchObject({ code: "invalid-path" });
    await expect(session.readHostDocument(path("broken.yaml"))).rejects.toMatchObject({ code: "not-found" });
    await expect(session.writeHostDocument({
      path: path("broken.yaml"), text: "label: no\n", expectedRevision: null,
    })).rejects.toMatchObject({ code: "not-found" });
    expect((await lstat(path("broken.yaml"))).isSymbolicLink()).toBe(true);
  });

  it("reports file/directory permissions without replacing existing content", async () => {
    await writeFile(path(), "label: protected\n", { mode: 0o400 });
    const original = await session.readHostDocument(path());
    await expect(save(original, "label: refused\n")).rejects.toMatchObject({ code: "permission" });
    expect(await readFile(path(), "utf8")).toBe(original.text);
    await mkdir(path("readonly"), { mode: 0o500 });
    try {
      await expect(session.writeHostDocument({
        path: path("readonly/pad.yaml"), text: "version: 1\n", expectedRevision: null,
      })).rejects.toMatchObject({ code: "permission" });
    } finally {
      await chmod(path("readonly"), 0o700);
    }
  });

  it("cleans temporary files and keeps the original on replacement failure", async () => {
    await writeFile(path(), "label: original\n");
    const original = await session.readHostDocument(path());
    await lua([
      "vim.uv.fs_rename = function() return nil, 'injected rename failure', 'EACCES' end",
    ].join("\n"));
    await expect(save(original, "label: replacement\n")).rejects.toMatchObject({ code: "permission" });
    expect(await readFile(path(), "utf8")).toBe(original.text);
    expect((await readdir(directory)).filter((name) => name.startsWith(".codey-action-pad-"))).toEqual([]);
  });

  it("does not clobber a file created after the final create-only check", async () => {
    await lua([
      "local original = vim.uv.fs_link",
      "vim.uv.fs_link = function(source, destination)",
      "  local file = assert(io.open(destination, 'wb'))",
      "  assert(file:write('label: concurrent\\n'))",
      "  assert(file:close())",
      "  return original(source, destination)",
      "end",
    ].join("\n"));
    await expect(session.writeHostDocument({
      path: path(), text: "label: app\n", expectedRevision: null,
    })).rejects.toMatchObject({ code: "conflict" });
    expect(await readFile(path(), "utf8")).toBe("label: concurrent\n");
    expect((await readdir(directory)).filter((name) => name.startsWith(".codey-action-pad-"))).toEqual([]);
  });

  it("detects a symlink retargeted while a replacement is being prepared", async () => {
    await writeFile(path("first.yaml"), "label: original\n");
    await writeFile(path("second.yaml"), "label: original\n");
    await symlink(path("first.yaml"), path());
    const original = await session.readHostDocument(path());
    await lua([
      "local alias, target = ...",
      "local original = vim.uv.fs_write",
      "vim.uv.fs_write = function(...)",
      "  vim.uv.fs_write = original",
      "  local result, detail, code = original(...)",
      "  assert(vim.uv.fs_unlink(alias))",
      "  assert(vim.uv.fs_symlink(target, alias))",
      "  return result, detail, code",
      "end",
    ].join("\n"), [path(), path("second.yaml")]);
    await expect(save(original, "label: app\n")).rejects.toMatchObject({ code: "conflict" });
    expect(await readFile(path("first.yaml"), "utf8")).toBe(original.text);
    expect(await readFile(path("second.yaml"), "utf8")).toBe(original.text);
    expect((await readdir(directory)).filter((name) => name.startsWith(".codey-action-pad-"))).toEqual([]);
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
