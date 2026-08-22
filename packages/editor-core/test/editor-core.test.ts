import { describe, expect, it } from "vitest";

import type { RedrawBatch } from "@codey/nvim-session";
import {
  applyRedrawBatch,
  cellAt,
  createEditorState,
  getPrimaryGrid,
  toSnapshot,
} from "../src/index.js";

function reduce(batch: RedrawBatch) {
  return applyRedrawBatch(createEditorState(), batch);
}

function texts(state: ReturnType<typeof createEditorState>): string[] {
  const grid = getPrimaryGrid(state);
  if (grid === null) {
    return [];
  }
  return grid.cells.map((cell) => cell.text);
}

describe("line-grid redraw reduction", () => {
  it("preserves Unicode, repeats, and highlight carry including explicit zero", () => {
    const { state } = reduce([
      ["grid_resize", [1, 6, 1]],
      [
        "grid_line",
        [1, 0, 0, [["λ", 7], ["界"], [" ", 0, 2], ["x"], ["é", 3]]],
      ],
    ]);
    const grid = getPrimaryGrid(state);

    expect(grid?.cells).toEqual([
      { text: "λ", highlightId: 7 },
      { text: "界", highlightId: 7 },
      { text: " ", highlightId: 0 },
      { text: " ", highlightId: 0 },
      { text: "x", highlightId: 0 },
      { text: "é", highlightId: 3 },
    ]);
  });

  it("carries the cell to the left for a partial grid_line update", () => {
    let result = reduce([
      ["grid_resize", [1, 3, 1]],
      ["grid_line", [1, 0, 0, [["a", 9], ["b"], ["c"]]]],
    ]);
    result = applyRedrawBatch(result.state, [
      ["grid_line", [1, 0, 1, [["B"], ["C", 0]]]],
    ]);

    expect(getPrimaryGrid(result.state)?.cells).toEqual([
      { text: "a", highlightId: 9 },
      { text: "B", highlightId: 9 },
      { text: "C", highlightId: 0 },
    ]);
  });

  it("applies multi-call grid_line events in order with one cell clone per grid", () => {
    let result = reduce([
      ["grid_resize", [1, 11, 1]],
      ["grid_resize", [2, 3, 1]],
      ["grid_line", [1, 0, 0, [["a", 4, 11]]]],
      ["grid_line", [2, 0, 0, [["x", 8, 3]]]],
    ]);
    const sourceGridOne = result.state.grids[1]!;
    const sourceGridTwo = result.state.grids[2]!;
    const iteratorDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      Symbol.iterator,
    )!;
    const originalIterator = Array.prototype[Symbol.iterator];
    let clonedCellBuffers = 0;
    Object.defineProperty(Array.prototype, Symbol.iterator, {
      ...iteratorDescriptor,
      value: function (this: unknown[]) {
        if (
          this.length > 0 &&
          this.every(
            (value) =>
              typeof value === "object" &&
              value !== null &&
              "text" in value &&
              "highlightId" in value,
          )
        ) {
          clonedCellBuffers += 1;
        }
        return originalIterator.call(this);
      },
    });

    try {
      result = applyRedrawBatch(result.state, [
        [
          "grid_line",
          [1, 0, 0, [["A", 7], ["B"]]],
          [2, 0, 1, [["Y", 9]]],
          // This call overlaps the first and inherits its freshly written hl_id.
          [1, 0, 1, [["C"]]],
        ],
      ]);
    } finally {
      Object.defineProperty(Array.prototype, Symbol.iterator, iteratorDescriptor);
    }

    expect(clonedCellBuffers).toBe(2);
    expect(result.state.grids[1]?.cells.slice(0, 3)).toEqual([
      { text: "A", highlightId: 7 },
      { text: "C", highlightId: 7 },
      { text: "a", highlightId: 4 },
    ]);
    expect(result.state.grids[2]?.cells).toEqual([
      { text: "x", highlightId: 8 },
      { text: "Y", highlightId: 9 },
      { text: "x", highlightId: 8 },
    ]);
    expect(sourceGridOne.cells.every((cell) => cell.text === "a")).toBe(true);
    expect(sourceGridTwo.cells.every((cell) => cell.text === "x")).toBe(true);
  });

  it("resizes with overlap preserved and clears cells", () => {
    let result = reduce([
      ["grid_resize", [1, 2, 1]],
      ["grid_line", [1, 0, 0, [["a", 4], ["b"]]]],
      ["grid_resize", [1, 3, 2]],
    ]);
    let grid = getPrimaryGrid(result.state);

    expect(grid?.width).toBe(3);
    expect(grid?.height).toBe(2);
    expect(grid && cellAt(grid, 0, 0)).toEqual({ text: "a", highlightId: 4 });
    expect(grid && cellAt(grid, 0, 1)).toEqual({ text: "b", highlightId: 4 });
    expect(grid && cellAt(grid, 1, 2)).toEqual({ text: " ", highlightId: 0 });

    result = applyRedrawBatch(result.state, [["grid_clear", [1]]]);
    grid = getPrimaryGrid(result.state);
    expect(
      grid?.cells.every(
        (cell) => cell.text === " " && cell.highlightId === 0,
      ),
    ).toBe(true);
  });

  it("scrolls an end-exclusive region up and blanks newly exposed cells", () => {
    let result = reduce([
      ["grid_resize", [1, 3, 3]],
      ["grid_line", [1, 0, 0, [["a", 1], ["b"], ["c"]]]],
      ["grid_line", [1, 1, 0, [["d", 2], ["e"], ["f"]]]],
      ["grid_line", [1, 2, 0, [["g", 3], ["h"], ["i"]]]],
    ]);

    result = applyRedrawBatch(result.state, [
      ["grid_scroll", [1, 0, 3, 0, 3, 1, 0]],
    ]);

    expect(texts(result.state)).toEqual([
      "d", "e", "f",
      "g", "h", "i",
      " ", " ", " ",
    ]);
    expect(
      getPrimaryGrid(result.state)
        ?.cells.slice(0, 3)
        .map((cell) => cell.highlightId),
    ).toEqual([2, 2, 2]);
  });

  it("stores colors, highlight definitions, cursor, and mode", () => {
    const { state } = reduce([
      ["grid_resize", [1, 80, 24]],
      ["default_colors_set", [0xffffff, 0x101010, 0xff0000, 15, 0]],
      [
        "hl_attr_define",
        [
          3,
          { foreground: 0x00ff00, bold: true },
          { foreground: 2 },
          [{ hi_name: "String" }],
        ],
      ],
      ["grid_cursor_goto", [1, 4, 9]],
      [
        "mode_info_set",
        [
          true,
          [
            { name: "normal", cursor_shape: "block" },
            { name: "insert", cursor_shape: "vertical" },
          ],
        ],
      ],
      ["mode_change", ["insert", 1]],
    ]);

    expect(state.defaultColors).toEqual({
      foreground: 0xffffff,
      background: 0x101010,
      special: 0xff0000,
      ctermForeground: 15,
      ctermBackground: 0,
    });
    expect(state.highlights[3]).toMatchObject({
      id: 3,
      rgb: { foreground: 0x00ff00, bold: true },
      cterm: { foreground: 2 },
      info: [{ hi_name: "String" }],
    });
    expect(state.cursor).toEqual({ gridId: 1, row: 4, column: 9 });
    expect(state.mode).toMatchObject({
      cursorStyleEnabled: true,
      name: "insert",
      index: 1,
    });
    expect(state.mode.infos).toHaveLength(2);
  });

  it("reports flush boundaries without treating other events as a frame", () => {
    let result = reduce([["grid_resize", [1, 10, 5]]]);
    expect(result.didFlush).toBe(false);
    expect(result.state.flushCount).toBe(0);

    result = applyRedrawBatch(result.state, [
      ["flush", []],
      ["future_event", ["ignored"]],
      ["flush", []],
    ]);
    expect(result.didFlush).toBe(true);
    expect(result.state.flushCount).toBe(2);
    expect(toSnapshot(result.state).grid?.id).toBe(1);
  });

  it("destroys a grid and clears a cursor belonging to it", () => {
    let result = reduce([
      ["grid_resize", [1, 2, 2]],
      ["grid_cursor_goto", [1, 0, 0]],
    ]);
    result = applyRedrawBatch(result.state, [["grid_destroy", [1]]]);

    expect(result.state.primaryGridId).toBeNull();
    expect(result.state.cursor).toBeNull();
    expect(toSnapshot(result.state).grid).toBeNull();
  });
});
