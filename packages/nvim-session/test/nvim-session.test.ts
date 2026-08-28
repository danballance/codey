import { describe, expect, it, vi } from "vitest";

import {
  BASIC_UI_OPTIONS,
  createNvimSession,
  isRedrawBatch,
  HostDocumentError,
  MAX_HOST_DOCUMENT_BYTES,
  type RedrawBatch,
} from "../src/index.js";

type NotificationListener = (method: string, params: unknown[]) => void;

function createRpcDouble() {
  let notificationListener: NotificationListener | undefined;
  const unsubscribe = vi.fn();

  return {
    rpc: {
      connect: vi.fn(async () => undefined),
      request: vi.fn(async (): Promise<unknown> => undefined),
      notify: vi.fn(async () => undefined),
      onNotification: vi.fn((listener: NotificationListener) => {
        notificationListener = listener;
        return unsubscribe;
      }),
      close: vi.fn(async () => undefined),
    },
    emit(method: string, params: unknown[]) {
      notificationListener?.(method, params);
    },
    unsubscribe,
  };
}

describe("NvimSessionClient", () => {
  it("connects, attaches the basic line-grid UI, sends input, and resizes", async () => {
    const double = createRpcDouble();
    const session = createNvimSession(double.rpc as never);

    await session.connect();
    await session.connect();
    await session.attach(80, 24);
    await session.input("ihello<Esc>");
    await session.resize(100, 40);

    expect(double.rpc.connect).toHaveBeenCalledTimes(1);
    expect(double.rpc.request).toHaveBeenNthCalledWith(1, "nvim_ui_attach", [
      80,
      24,
      BASIC_UI_OPTIONS,
    ]);
    expect(double.rpc.request).toHaveBeenNthCalledWith(2, "nvim_input", [
      "ihello<Esc>",
    ]);
    expect(double.rpc.request).toHaveBeenNthCalledWith(
      3,
      "nvim_ui_try_resize",
      [100, 40],
    );
    expect(double.rpc.notify).not.toHaveBeenCalled();
  });

  it("emits the redraw notification params as the event batch", () => {
    const double = createRpcDouble();
    const session = createNvimSession(double.rpc as never);
    const listener = vi.fn();
    const off = session.onRedraw(listener);
    const batch: RedrawBatch = [["flush", []]];

    double.emit("unrelated", [...batch]);
    double.emit("redraw", [{ invalid: true }]);
    double.emit("redraw", [...batch]);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(batch);

    off();
    double.emit("redraw", [...batch]);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("validates redraw calls by index without slicing event arrays", () => {
    const event = ["grid_line", [1, 0, 0, [["A", 0]]]];
    Object.defineProperty(event, "slice", {
      value: () => {
        throw new Error("redraw validation must not allocate event slices");
      },
    });

    expect(isRedrawBatch([event])).toBe(true);
    expect(isRedrawBatch([["flush"]])).toBe(true);
    expect(isRedrawBatch([["grid_line", { invalid: true }]])).toBe(false);
  });

  it("forwards mouse input and closes idempotently", async () => {
    const double = createRpcDouble();
    const session = createNvimSession(double.rpc as never);

    await session.inputMouse({
      button: "left",
      action: "press",
      modifier: "S",
      gridId: 1,
      row: 3,
      column: 5,
    });
    await session.close();
    await session.close();

    expect(double.rpc.request).toHaveBeenCalledWith("nvim_input_mouse", [
      "left",
      "press",
      "S",
      1,
      3,
      5,
    ]);
    expect(double.unsubscribe).toHaveBeenCalledOnce();
    expect(double.rpc.close).toHaveBeenCalledOnce();
    await expect(session.input("x")).rejects.toThrow("closed");
  });

  it("rejects invalid grid dimensions before making a request", async () => {
    const double = createRpcDouble();
    const session = createNvimSession(double.rpc as never);

    await expect(session.attach(0, 24)).rejects.toThrow(RangeError);
    await expect(session.resize(80.5, 24)).rejects.toThrow(RangeError);
    expect(double.rpc.request).not.toHaveBeenCalled();
  });

  it("passes host document paths and contents as arguments to one fixed Lua program", async () => {
    const double = createRpcDouble();
    const session = createNvimSession(double.rpc as never);
    const path = "/tmp/'; error('not executable') --.yaml";
    const text = "label: ''); vim.cmd('quit!'); --'\n";
    const document = { path, resolvedPath: path, text, revision: "a".repeat(64) };
    double.rpc.request
      .mockResolvedValueOnce({ ok: true, path: "/host/config/codey/action-pad.yaml" })
      .mockResolvedValueOnce({ ok: true, document })
      .mockResolvedValueOnce({ ok: true, document });

    expect(await session.defaultActionPadPath()).toBe("/host/config/codey/action-pad.yaml");
    expect(await session.readHostDocument(path)).toEqual(document);
    const request = {
      path, text, expectedRevision: document.revision, expectedResolvedPath: path,
    };
    expect(await session.writeHostDocument(request)).toEqual(document);

    const [defaultCall, readCall, writeCall] = double.rpc.request.mock.calls as unknown as
      [string, [string, unknown[]]][];
    expect(defaultCall?.[0]).toBe("nvim_exec_lua");
    expect(readCall?.[1]).toEqual([defaultCall?.[1][0], ["read", { path }]]);
    expect(writeCall?.[1]).toEqual([defaultCall?.[1][0], ["write", request]]);
    expect(writeCall?.[1][0]).not.toContain(path);
    expect(writeCall?.[1][0]).not.toContain(text);
  });

  it("represents a missing host file without treating it as an empty saved file", async () => {
    const double = createRpcDouble();
    const session = createNvimSession(double.rpc as never);
    const document = {
      path: "/tmp/missing.yaml", resolvedPath: "/tmp/missing.yaml", text: null, revision: null,
    };
    double.rpc.request.mockResolvedValue({ ok: true, document });
    expect(await session.readHostDocument(document.path)).toEqual(document);
  });

  it.each([
    "conflict", "modified-buffer", "invalid-path", "not-found", "permission", "too-large", "io",
  ])("preserves host document %s errors without closing the RPC session", async (code) => {
    const double = createRpcDouble();
    const session = createNvimSession(double.rpc as never);
    double.rpc.request.mockResolvedValue({ ok: false, code, message: "Document failed" });
    await expect(session.readHostDocument("/tmp/pad.yaml")).rejects.toMatchObject({
      name: "HostDocumentError", code, message: "Document failed",
    });
    expect(double.rpc.close).not.toHaveBeenCalled();
  });

  it.each(["pad.yaml", "", "/", "~/", "~someone/pad.yaml", "/tmp/pad\0.yaml", "/tmp/"])(
    "rejects invalid host path %j before RPC",
    async (path) => {
      const double = createRpcDouble();
      const session = createNvimSession(double.rpc as never);
      await expect(session.readHostDocument(path)).rejects.toMatchObject({ code: "invalid-path" });
      expect(double.rpc.request).not.toHaveBeenCalled();
    },
  );

  it("limits writes by UTF-8 bytes rather than JavaScript string length", async () => {
    const double = createRpcDouble();
    const session = createNvimSession(double.rpc as never);
    const path = "/tmp/pad.yaml";
    const text = "é".repeat(MAX_HOST_DOCUMENT_BYTES / 2);
    const document = { path, resolvedPath: path, text, revision: "a".repeat(64) };
    double.rpc.request.mockResolvedValue({ ok: true, document });
    await expect(session.writeHostDocument({ path, text, expectedRevision: null })).resolves.toEqual(document);
    double.rpc.request.mockClear();
    await expect(session.writeHostDocument({
      path, text: text + "é", expectedRevision: null,
    })).rejects.toMatchObject({ code: "too-large" });
    expect(double.rpc.request).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { ok: false, code: "unknown", message: "invalid" },
    { ok: true, document: { path: "/tmp/pad.yaml", resolvedPath: "/tmp/pad.yaml", text: "", revision: null } },
    { ok: true, document: { path: "relative", resolvedPath: "/tmp/pad.yaml", text: null, revision: null } },
    { ok: true, document: { path: "/tmp/pad.yaml", resolvedPath: "/tmp/pad.yaml", text: "", revision: "invalid" } },
  ])("rejects malformed host document response %j", async (response) => {
    const double = createRpcDouble();
    const session = createNvimSession(double.rpc as never);
    double.rpc.request.mockResolvedValue(response);
    await expect(session.readHostDocument("/tmp/pad.yaml")).rejects.toBeInstanceOf(HostDocumentError);
  });

  it("leaves transport errors intact and rejects document work after close", async () => {
    const double = createRpcDouble();
    const session = createNvimSession(double.rpc as never);
    const failure = new Error("Connection was lost");
    double.rpc.request.mockRejectedValue(failure);
    await expect(session.readHostDocument("/tmp/pad.yaml")).rejects.toBe(failure);
    await session.close();
    double.rpc.request.mockClear();
    await expect(session.defaultActionPadPath()).rejects.toThrow("closed");
    await expect(session.readHostDocument("/tmp/pad.yaml")).rejects.toThrow("closed");
    await expect(session.writeHostDocument({
      path: "/tmp/pad.yaml", text: "", expectedRevision: null,
    })).rejects.toThrow("closed");
    expect(double.rpc.request).not.toHaveBeenCalled();
  });
});
