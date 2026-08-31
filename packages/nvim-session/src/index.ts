import type { MessagePackRpcClient } from "@codey/msgpack-rpc";
import {
  performanceDiagnosticsEnabled,
  performanceNow,
  recordPerformance,
} from "@codey/perf";
import {
  defaultActionPadPath,
  readHostDocument,
  writeHostDocument,
  type HostDocument,
  type HostDocumentWrite,
} from "./host-documents";

export {
  HostDocumentError,
  MAX_HOST_DOCUMENT_BYTES,
  type HostDocument,
  type HostDocumentErrorCode,
  type HostDocumentErrorStage,
  type HostDocumentWrite,
} from "./host-documents";

export type RedrawCall = readonly unknown[];

export type RedrawEvent = readonly [
  name: string,
  ...calls: RedrawCall[],
];

export type RedrawBatch = readonly RedrawEvent[];

export type RedrawListener = (batch: RedrawBatch) => void;

export interface MouseInput {
  readonly button: string;
  readonly action: string;
  readonly modifier?: string;
  readonly gridId?: number;
  readonly row: number;
  readonly column: number;
}

export interface NvimSession {
  connect(): Promise<void>;
  attach(width: number, height: number): Promise<void>;
  input(keys: string): Promise<void>;
  resize(width: number, height: number): Promise<void>;
  inputMouse(mouse: MouseInput): Promise<void>;
  defaultActionPadPath(): Promise<string>;
  readHostDocument(path: string): Promise<HostDocument>;
  writeHostDocument(request: HostDocumentWrite): Promise<HostDocument>;
  onRedraw(listener: RedrawListener): () => void;
  close(): Promise<void>;
}

/**
 * UI extensions intentionally enabled for the first vertical slice.
 *
 * Line-grid is the only externalized UI. Neovim continues to draw the command
 * line, popup menu, messages, tabline, and wildmenu into the main grid.
 */
export const BASIC_UI_OPTIONS = Object.freeze({
  rgb: true,
  ext_linegrid: true,
});

export class NvimSessionClient implements NvimSession {
  readonly #redrawListeners = new Set<RedrawListener>();
  readonly #unsubscribeNotification: () => void;
  #connected = false;
  #closed = false;

  public constructor(private readonly rpc: MessagePackRpcClient) {
    this.#unsubscribeNotification = rpc.onNotification((method, params) => {
      if (method !== "redraw") {
        return;
      }

      if (!isRedrawBatch(params)) {
        return;
      }

      for (const listener of [...this.#redrawListeners]) {
        listener(params);
      }
    });
  }

  public async connect(): Promise<void> {
    this.#assertOpen();
    if (this.#connected) {
      return;
    }

    await this.rpc.connect();
    this.#connected = true;
  }

  public async attach(width: number, height: number): Promise<void> {
    this.#assertOpen();
    assertDimension("width", width);
    assertDimension("height", height);

    await this.rpc.request("nvim_ui_attach", [
      width,
      height,
      BASIC_UI_OPTIONS,
    ]);
  }

  public async input(keys: string): Promise<void> {
    this.#assertOpen();
    await this.rpc.request("nvim_input", [keys]);
  }

  public async resize(width: number, height: number): Promise<void> {
    this.#assertOpen();
    assertDimension("width", width);
    assertDimension("height", height);

    await this.rpc.request("nvim_ui_try_resize", [width, height]);
  }

  public async inputMouse(mouse: MouseInput): Promise<void> {
    this.#assertOpen();
    assertCoordinate("row", mouse.row);
    assertCoordinate("column", mouse.column);
    assertCoordinate("gridId", mouse.gridId ?? 0);

    await this.rpc.request("nvim_input_mouse", [
      mouse.button,
      mouse.action,
      mouse.modifier ?? "",
      mouse.gridId ?? 0,
      mouse.row,
      mouse.column,
    ]);
  }

  public onRedraw(listener: RedrawListener): () => void {
    if (this.#closed) {
      return () => undefined;
    }

    this.#redrawListeners.add(listener);
    return () => {
      this.#redrawListeners.delete(listener);
    };
  }

  public async defaultActionPadPath(): Promise<string> {
    this.#assertOpen();
    return defaultActionPadPath(this.rpc);
  }

  public async readHostDocument(path: string): Promise<HostDocument> {
    this.#assertOpen();
    return readHostDocument(this.rpc, path);
  }

  public async writeHostDocument(request: HostDocumentWrite): Promise<HostDocument> {
    this.#assertOpen();
    return writeHostDocument(this.rpc, request);
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    this.#connected = false;
    this.#unsubscribeNotification();
    this.#redrawListeners.clear();
    await this.rpc.close();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("Neovim session is closed");
    }
  }
}

export function createNvimSession(
  rpc: MessagePackRpcClient,
): NvimSessionClient {
  return new NvimSessionClient(rpc);
}

export function isRedrawBatch(value: unknown): value is RedrawBatch {
  const diagnosticsEnabled = performanceDiagnosticsEnabled();
  const validationStartedAt = diagnosticsEnabled ? performanceNow() : 0;
  let valid = false;

  if (Array.isArray(value)) {
    valid = true;
    for (let eventIndex = 0; eventIndex < value.length; eventIndex += 1) {
      // Array#every, used by the previous validator, skips sparse entries.
      if (!(eventIndex in value)) {
        continue;
      }
      const event = value[eventIndex];
      if (!Array.isArray(event) || typeof event[0] !== "string") {
        valid = false;
        break;
      }
      for (let callIndex = 1; callIndex < event.length; callIndex += 1) {
        if (!(callIndex in event)) {
          continue;
        }
        if (!Array.isArray(event[callIndex])) {
          valid = false;
          break;
        }
      }
      if (!valid) {
        break;
      }
    }
  }

  if (diagnosticsEnabled) {
    recordPerformance("redraw_validation", {
      startedAtMs: validationStartedAt,
      tags: {
        source: "redraw",
        eventCount: Array.isArray(value) ? value.length : 0,
      },
    });
  }
  return valid;
}

function assertDimension(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function assertCoordinate(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}
