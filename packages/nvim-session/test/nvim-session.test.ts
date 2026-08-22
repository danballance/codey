import { describe, expect, it, vi } from "vitest";

import {
  BASIC_UI_OPTIONS,
  createNvimSession,
  type RedrawBatch,
} from "../src/index.js";

type NotificationListener = (method: string, params: unknown[]) => void;

function createRpcDouble() {
  let notificationListener: NotificationListener | undefined;
  const unsubscribe = vi.fn();

  return {
    rpc: {
      connect: vi.fn(async () => undefined),
      request: vi.fn(async () => undefined),
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
});
