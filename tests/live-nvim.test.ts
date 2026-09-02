import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyRedrawBatch,
  createEditorState,
  getPrimaryGrid,
} from "../packages/editor-core/src/index.js";
import { MessagePackRpcClient } from "../packages/msgpack-rpc/src/index.js";
import { NvimSessionClient } from "../packages/nvim-session/src/index.js";
import {
  EmbeddedNvimTransport,
  hasEmbeddedNvim,
} from "../packages/nvim-session/test/embedded-nvim-transport.js";

const shouldRun = process.platform === "linux" && hasEmbeddedNvim();

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

describe.runIf(shouldRun)("live Neovim vertical slice", () => {
  it("attaches, reduces redraws, edits, resizes, and undoes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codey-live-nvim-"));
    const transport = new EmbeddedNvimTransport(directory);
    const rpc = new MessagePackRpcClient(transport);
    const session = new NvimSessionClient(rpc);
    let editor = createEditorState();

    const removeRedrawListener = session.onRedraw((batch) => {
      editor = applyRedrawBatch(editor, batch).state;
    });

    try {
      await session.connect();
      await session.attach(40, 10);
      await waitUntil(() => editor.flushCount > 0, "the initial redraw flush");

      await session.input("iCodey smoke ✓<Esc>");
      await waitUntil(
        async () => (await rpc.request<string>("nvim_get_current_line")) === "Codey smoke ✓",
        "insert-mode input",
      );

      const renderedText = getPrimaryGrid(editor)?.cells.map((cell) => cell.text).join("") ?? "";
      expect(renderedText).toContain("Codey smoke ✓");

      await session.resize(52, 12);
      await waitUntil(() => {
        const grid = getPrimaryGrid(editor);
        return grid?.width === 52 && grid.height === 12;
      }, "the resized grid");

      await session.input("u");
      await waitUntil(
        async () => (await rpc.request<string>("nvim_get_current_line")) === "",
        "Neovim undo",
      );
    } finally {
      removeRedrawListener();
      try {
        await session.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }, 10_000);
});
