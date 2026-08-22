import type { RedrawBatch, RedrawCall } from "@codey/nvim-session";

export interface GridCell {
  readonly text: string;
  readonly highlightId: number;
}

export interface Grid {
  readonly id: number;
  readonly width: number;
  readonly height: number;
  /** Cells in row-major order. */
  readonly cells: readonly GridCell[];
}

export interface Cursor {
  readonly gridId: number;
  readonly row: number;
  readonly column: number;
}

export interface DefaultColors {
  readonly foreground: number;
  readonly background: number;
  readonly special: number;
  readonly ctermForeground: number;
  readonly ctermBackground: number;
}

export interface HighlightAttributes {
  readonly [name: string]: unknown;
}

export interface HighlightDefinition {
  readonly id: number;
  readonly rgb: HighlightAttributes;
  readonly cterm: HighlightAttributes;
  readonly info: readonly HighlightAttributes[];
}

export interface ModeInfo {
  readonly [name: string]: unknown;
}

export interface ModeState {
  readonly cursorStyleEnabled: boolean;
  readonly infos: readonly ModeInfo[];
  readonly name: string;
  readonly index: number;
}

/**
 * Plain arrays, objects, strings, booleans and numbers only: no Map, class
 * instances, or platform objects. It can be sent over Electron IPC as-is.
 */
export interface EditorState {
  readonly grids: Readonly<Record<number, Grid>>;
  readonly primaryGridId: number | null;
  readonly cursor: Cursor | null;
  readonly defaultColors: DefaultColors | null;
  readonly highlights: Readonly<Record<number, HighlightDefinition>>;
  readonly mode: ModeState;
  readonly flushCount: number;
}

export interface EditorSnapshot {
  readonly grid: Grid | null;
  readonly cursor: Cursor | null;
  readonly defaultColors: DefaultColors | null;
  readonly highlights: Readonly<Record<number, HighlightDefinition>>;
  readonly mode: ModeState;
  readonly flushCount: number;
}

export interface RedrawReduction {
  readonly state: EditorState;
  /** True when at least one `flush` event ended a frame in this batch. */
  readonly didFlush: boolean;
}

const EMPTY_CELL: GridCell = Object.freeze({ text: " ", highlightId: 0 });

const INITIAL_MODE: ModeState = Object.freeze({
  cursorStyleEnabled: false,
  infos: Object.freeze([]),
  name: "",
  index: 0,
});

export function createEditorState(): EditorState {
  return {
    grids: {},
    primaryGridId: null,
    cursor: null,
    defaultColors: null,
    highlights: {},
    mode: INITIAL_MODE,
    flushCount: 0,
  };
}

export function getPrimaryGrid(state: EditorState): Grid | null {
  if (state.primaryGridId === null) {
    return null;
  }

  return state.grids[state.primaryGridId] ?? null;
}

/** Return the renderer-facing, structured-clone-safe view of editor state. */
export function toSnapshot(state: EditorState): EditorSnapshot {
  return {
    grid: getPrimaryGrid(state),
    cursor: state.cursor,
    defaultColors: state.defaultColors,
    highlights: state.highlights,
    mode: state.mode,
    flushCount: state.flushCount,
  };
}

/**
 * Apply all UI events in order. Consumers should only paint when `didFlush` is
 * true, so a whole Neovim frame is rendered once rather than event-by-event.
 */
export function applyRedrawBatch(
  previous: EditorState,
  batch: RedrawBatch,
): RedrawReduction {
  let state = previous;
  let didFlush = false;

  for (const event of batch) {
    const [name, ...calls] = event;
    for (const call of calls) {
      switch (name) {
        case "grid_resize":
          state = applyGridResize(state, call);
          break;
        case "grid_clear":
          state = applyGridClear(state, call);
          break;
        case "grid_destroy":
          state = applyGridDestroy(state, call);
          break;
        case "grid_cursor_goto":
          state = applyGridCursorGoto(state, call);
          break;
        case "grid_line":
          state = applyGridLine(state, call);
          break;
        case "grid_scroll":
          state = applyGridScroll(state, call);
          break;
        case "default_colors_set":
          state = applyDefaultColors(state, call);
          break;
        case "hl_attr_define":
          state = applyHighlightDefinition(state, call);
          break;
        case "mode_info_set":
          state = applyModeInfo(state, call);
          break;
        case "mode_change":
          state = applyModeChange(state, call);
          break;
        case "flush":
          state = { ...state, flushCount: state.flushCount + 1 };
          didFlush = true;
          break;
        default:
          // Forward compatibility: an unsupported UI event must not discard a
          // batch containing line-grid events that we do understand.
          break;
      }
    }
  }

  return { state, didFlush };
}

export const reduceRedrawBatch = applyRedrawBatch;

export function cellAt(
  grid: Grid,
  row: number,
  column: number,
): GridCell | undefined {
  if (
    row < 0 ||
    row >= grid.height ||
    column < 0 ||
    column >= grid.width
  ) {
    return undefined;
  }

  return grid.cells[row * grid.width + column];
}

function applyGridResize(state: EditorState, call: RedrawCall): EditorState {
  const gridId = integerAt(call, 0);
  const width = integerAt(call, 1);
  const height = integerAt(call, 2);
  if (
    gridId === null ||
    width === null ||
    height === null ||
    width < 0 ||
    height < 0
  ) {
    return state;
  }

  const previousGrid = state.grids[gridId];
  const cells = blankCells(width * height);
  if (previousGrid !== undefined) {
    const copiedWidth = Math.min(width, previousGrid.width);
    const copiedHeight = Math.min(height, previousGrid.height);
    for (let row = 0; row < copiedHeight; row += 1) {
      for (let column = 0; column < copiedWidth; column += 1) {
        const oldCell = previousGrid.cells[row * previousGrid.width + column];
        if (oldCell !== undefined) {
          cells[row * width + column] = oldCell;
        }
      }
    }
  }

  const grid: Grid = { id: gridId, width, height, cells };
  const grids = { ...state.grids, [gridId]: grid };
  const primaryGridId =
    gridId === 1 || state.primaryGridId === null
      ? gridId
      : state.primaryGridId;

  return { ...state, grids, primaryGridId };
}

function applyGridClear(state: EditorState, call: RedrawCall): EditorState {
  const gridId = integerAt(call, 0);
  if (gridId === null) {
    return state;
  }

  const grid = state.grids[gridId];
  if (grid === undefined) {
    return state;
  }

  return replaceGrid(state, {
    ...grid,
    cells: blankCells(grid.width * grid.height),
  });
}

function applyGridDestroy(state: EditorState, call: RedrawCall): EditorState {
  const gridId = integerAt(call, 0);
  if (gridId === null || state.grids[gridId] === undefined) {
    return state;
  }

  const grids = { ...state.grids };
  delete grids[gridId];
  const gridIds = Object.keys(grids)
    .map(Number)
    .filter(Number.isSafeInteger)
    .sort((left, right) => left - right);
  const primaryGridId =
    state.primaryGridId === gridId
      ? (gridIds.includes(1) ? 1 : (gridIds[0] ?? null))
      : state.primaryGridId;
  const cursor = state.cursor?.gridId === gridId ? null : state.cursor;

  return { ...state, grids, primaryGridId, cursor };
}

function applyGridCursorGoto(
  state: EditorState,
  call: RedrawCall,
): EditorState {
  const gridId = integerAt(call, 0);
  const row = integerAt(call, 1);
  const column = integerAt(call, 2);
  if (gridId === null || row === null || column === null) {
    return state;
  }

  return { ...state, cursor: { gridId, row, column } };
}

function applyGridLine(state: EditorState, call: RedrawCall): EditorState {
  const gridId = integerAt(call, 0);
  const row = integerAt(call, 1);
  const columnStart = integerAt(call, 2);
  const encodedCells = call[3];
  if (
    gridId === null ||
    row === null ||
    columnStart === null ||
    !Array.isArray(encodedCells)
  ) {
    return state;
  }

  const grid = state.grids[gridId];
  if (
    grid === undefined ||
    row < 0 ||
    row >= grid.height ||
    columnStart < 0
  ) {
    return state;
  }

  const cells = [...grid.cells];
  let column = columnStart;
  let highlightId =
    columnStart > 0
      ? (cells[row * grid.width + columnStart - 1]?.highlightId ?? 0)
      : 0;

  for (const encodedCell of encodedCells) {
    if (!Array.isArray(encodedCell) || typeof encodedCell[0] !== "string") {
      continue;
    }

    // An omitted hl_id carries the previous cell's value. Checking array
    // length (rather than truthiness) is important: explicit 0 resets it.
    if (
      encodedCell.length >= 2 &&
      typeof encodedCell[1] === "number" &&
      Number.isSafeInteger(encodedCell[1])
    ) {
      highlightId = encodedCell[1];
    }

    const repeatValue = encodedCell[2];
    const repeat =
      typeof repeatValue === "number" &&
      Number.isSafeInteger(repeatValue) &&
      repeatValue > 0
        ? repeatValue
        : 1;

    for (let offset = 0; offset < repeat; offset += 1) {
      if (column >= grid.width) {
        break;
      }
      cells[row * grid.width + column] = {
        text: encodedCell[0],
        highlightId,
      };
      column += 1;
    }

    if (column >= grid.width) {
      break;
    }
  }

  return replaceGrid(state, { ...grid, cells });
}

function applyGridScroll(state: EditorState, call: RedrawCall): EditorState {
  const gridId = integerAt(call, 0);
  const topValue = integerAt(call, 1);
  const bottomValue = integerAt(call, 2);
  const leftValue = integerAt(call, 3);
  const rightValue = integerAt(call, 4);
  const rows = integerAt(call, 5);
  const columns = integerAt(call, 6);
  if (
    gridId === null ||
    topValue === null ||
    bottomValue === null ||
    leftValue === null ||
    rightValue === null ||
    rows === null ||
    columns === null
  ) {
    return state;
  }

  const grid = state.grids[gridId];
  if (grid === undefined) {
    return state;
  }

  const top = clamp(topValue, 0, grid.height);
  const bottom = clamp(bottomValue, top, grid.height);
  const left = clamp(leftValue, 0, grid.width);
  const right = clamp(rightValue, left, grid.width);
  if (top === bottom || left === right || (rows === 0 && columns === 0)) {
    return state;
  }

  const source = grid.cells;
  const cells = [...source];
  for (let row = top; row < bottom; row += 1) {
    for (let column = left; column < right; column += 1) {
      const sourceRow = row + rows;
      const sourceColumn = column + columns;
      const targetIndex = row * grid.width + column;
      if (
        sourceRow >= top &&
        sourceRow < bottom &&
        sourceColumn >= left &&
        sourceColumn < right
      ) {
        cells[targetIndex] =
          source[sourceRow * grid.width + sourceColumn] ?? EMPTY_CELL;
      } else {
        cells[targetIndex] = EMPTY_CELL;
      }
    }
  }

  return replaceGrid(state, { ...grid, cells });
}

function applyDefaultColors(
  state: EditorState,
  call: RedrawCall,
): EditorState {
  const foreground = integerAt(call, 0);
  const background = integerAt(call, 1);
  const special = integerAt(call, 2);
  const ctermForeground = integerAt(call, 3);
  const ctermBackground = integerAt(call, 4);
  if (
    foreground === null ||
    background === null ||
    special === null ||
    ctermForeground === null ||
    ctermBackground === null
  ) {
    return state;
  }

  return {
    ...state,
    defaultColors: {
      foreground,
      background,
      special,
      ctermForeground,
      ctermBackground,
    },
  };
}

function applyHighlightDefinition(
  state: EditorState,
  call: RedrawCall,
): EditorState {
  const id = integerAt(call, 0);
  const rgb = recordAt(call, 1);
  const cterm = recordAt(call, 2);
  const rawInfo = call[3];
  if (id === null || rgb === null || cterm === null || !Array.isArray(rawInfo)) {
    return state;
  }

  const info = rawInfo
    .filter(isRecord)
    .map((entry) => ({ ...entry }));
  const definition: HighlightDefinition = {
    id,
    rgb: { ...rgb },
    cterm: { ...cterm },
    info,
  };

  return {
    ...state,
    highlights: { ...state.highlights, [id]: definition },
  };
}

function applyModeInfo(state: EditorState, call: RedrawCall): EditorState {
  const cursorStyleEnabled = call[0];
  const rawInfos = call[1];
  if (typeof cursorStyleEnabled !== "boolean" || !Array.isArray(rawInfos)) {
    return state;
  }

  return {
    ...state,
    mode: {
      ...state.mode,
      cursorStyleEnabled,
      infos: rawInfos.filter(isRecord).map((info) => ({ ...info })),
    },
  };
}

function applyModeChange(state: EditorState, call: RedrawCall): EditorState {
  const name = call[0];
  const index = integerAt(call, 1);
  if (typeof name !== "string" || index === null) {
    return state;
  }

  return { ...state, mode: { ...state.mode, name, index } };
}

function replaceGrid(state: EditorState, grid: Grid): EditorState {
  return { ...state, grids: { ...state.grids, [grid.id]: grid } };
}

function blankCells(count: number): GridCell[] {
  return Array.from({ length: count }, () => EMPTY_CELL);
}

function integerAt(values: RedrawCall, index: number): number | null {
  const value = values[index];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function recordAt(
  values: RedrawCall,
  index: number,
): Record<string, unknown> | null {
  const value = values[index];
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
