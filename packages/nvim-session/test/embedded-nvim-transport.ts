/// <reference types="node" />
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";

import type { DuplexTransport } from "../../transport/src/index.js";

export const nvimBinary = process.env["CODEY_NVIM_BIN"] ?? "nvim";

export function hasEmbeddedNvim(binary = nvimBinary): boolean {
  return spawnSync(binary, ["--version"], { stdio: "ignore" }).status === 0;
}

export class EmbeddedNvimTransport implements DuplexTransport {
  readonly #dataListeners = new Set<(data: Uint8Array) => void>();
  readonly #closeListeners = new Set<(error?: Error) => void>();
  #process: ChildProcessWithoutNullStreams | undefined;
  #closed = false;
  #stderr = "";

  public constructor(
    private readonly directory: string,
    private readonly binary = nvimBinary,
  ) {}

  public async connect(): Promise<void> {
    const child = spawn(
      this.binary,
      ["--clean", "--headless", "--embed", "-i", "NONE", "-n"],
      {
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
      },
    );
    this.#process = child;
    child.stdout.on("data", (data: Buffer) => {
      for (const listener of this.#dataListeners) listener(data);
    });
    child.stderr.on("data", (data: Buffer) => {
      this.#stderr += data.toString();
    });
    child.on("error", (error) => {
      for (const listener of this.#closeListeners) listener(error);
    });
    child.on("close", (code) => {
      if (this.#closed) return;
      const message = `Embedded Neovim exited: ${code}\n${this.#stderr}`;
      for (const listener of this.#closeListeners) listener(new Error(message));
    });
    await once(child, "spawn");
  }

  public async write(data: Uint8Array): Promise<void> {
    const child = this.#process;
    if (!child || this.#closed) throw new Error("Embedded Neovim is closed");
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
    const timeout = setTimeout(() => child.kill("SIGKILL"), 1_000);
    timeout.unref();
    try {
      await exited;
    } finally {
      clearTimeout(timeout);
    }
  }
}
