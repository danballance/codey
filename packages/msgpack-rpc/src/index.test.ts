import { decode, encode } from "@msgpack/msgpack";

import {
  clearPerformanceRecords,
  configurePerformanceDiagnostics,
  getPerformanceRecords,
  withPerformanceTags,
} from "@codey/perf";
import type { DuplexTransport } from "@codey/transport";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MessagePackRpcClient,
  MessagePackRpcConnectionClosedError,
  MessagePackRpcProtocolError,
  MessagePackRpcRemoteError,
} from "./index.js";

class FakeTransport implements DuplexTransport {
  readonly writes: Uint8Array[] = [];
  connectCalls = 0;
  closeCalls = 0;
  writeError: Error | undefined;

  readonly #dataListeners = new Set<(chunk: Uint8Array) => void>();
  readonly #closeListeners = new Set<(error?: Error) => void>();

  async connect(): Promise<void> {
    this.connectCalls++;
  }

  async write(data: Uint8Array): Promise<void> {
    if (this.writeError !== undefined) {
      throw this.writeError;
    }
    this.writes.push(data.slice());
  }

  onData(listener: (chunk: Uint8Array) => void): () => void {
    this.#dataListeners.add(listener);
    return () => this.#dataListeners.delete(listener);
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closeCalls++;
    this.emitClose();
  }

  emitData(data: Uint8Array): void {
    for (const listener of this.#dataListeners) {
      listener(data);
    }
  }

  emitClose(error?: Error): void {
    for (const listener of [...this.#closeListeners]) {
      listener(error);
    }
  }
}

function concatenate(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((length, part) => length + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

describe("MessagePackRpcClient", () => {
  afterEach(() => {
    configurePerformanceDiagnostics({ enabled: false });
    clearPerformanceRecords();
  });

  it("decodes values split across chunks and multiple values in one chunk", async () => {
    const transport = new FakeTransport();
    const client = new MessagePackRpcClient(transport);
    const notifications = vi.fn();
    client.onNotification(notifications);
    await client.connect();

    const response = client.request<string>("nvim_test", [42]);
    const outgoing = decode(transport.writes[0]!) as unknown[];
    const requestId = outgoing[1] as number;
    expect(outgoing).toEqual([0, requestId, "nvim_test", [42]]);

    const bytes = concatenate(
      encode([1, requestId, null, "done"]),
      encode([2, "redraw", [["flush"]]]),
    );
    for (const byte of bytes) {
      transport.emitData(Uint8Array.of(byte));
    }

    await expect(response).resolves.toBe("done");
    expect(notifications).toHaveBeenCalledOnce();
    expect(notifications).toHaveBeenCalledWith("redraw", [["flush"]]);
  });

  it("correlates out-of-order responses and exposes remote errors", async () => {
    const transport = new FakeTransport();
    const client = new MessagePackRpcClient(transport);
    await client.connect();

    const first = client.request("first");
    const second = client.request("second");
    const firstId = (decode(transport.writes[0]!) as unknown[])[1] as number;
    const secondId = (decode(transport.writes[1]!) as unknown[])[1] as number;

    transport.emitData(
      concatenate(
        encode([1, secondId, null, 2]),
        encode([1, firstId, null, 1]),
      ),
    );
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);

    const failed = client.request("broken");
    const failedId = (decode(transport.writes[2]!) as unknown[])[1] as number;
    transport.emitData(encode([1, failedId, [0, "boom"], null]));
    await expect(failed).rejects.toMatchObject({
      name: "MessagePackRpcRemoteError",
      requestId: failedId,
      method: "broken",
      remoteError: [0, "boom"],
    } satisfies Partial<MessagePackRpcRemoteError>);
  });

  it("writes notifications", async () => {
    const transport = new FakeTransport();
    const client = new MessagePackRpcClient(transport);
    await client.connect();

    await client.notify("nvim_input", ["ihello<Esc>"]);

    expect(decode(transport.writes[0]!)).toEqual([
      2,
      "nvim_input",
      ["ihello<Esc>"],
    ]);
  });

  it("handles server requests and sends success and error responses", async () => {
    const transport = new FakeTransport();
    const client = new MessagePackRpcClient(transport);
    const remove = client.onRequest("sum", ([left, right]) =>
      Number(left) + Number(right),
    );
    await client.connect();

    transport.emitData(encode([0, 41, "sum", [2, 3]]));
    await vi.waitFor(() => expect(transport.writes).toHaveLength(1));
    expect(decode(transport.writes[0]!)).toEqual([1, 41, null, 5]);

    remove();
    transport.emitData(encode([0, 42, "sum", [2, 3]]));
    await vi.waitFor(() => expect(transport.writes).toHaveLength(2));
    expect(decode(transport.writes[1]!)).toMatchObject([
      1,
      42,
      { name: "MethodNotFound" },
      null,
    ]);
  });

  it("treats malformed protocol messages as fatal and rejects pending work", async () => {
    const transport = new FakeTransport();
    const client = new MessagePackRpcClient(transport);
    const errors: Error[] = [];
    client.onError((error) => errors.push(error));
    await client.connect();
    const pending = client.request("waiting");

    transport.emitData(encode([9, "not-an-rpc-message"]));

    await expect(pending).rejects.toBeInstanceOf(MessagePackRpcProtocolError);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(MessagePackRpcProtocolError);
    expect(transport.closeCalls).toBe(1);
  });

  it.each([
    { name: "empty message", message: [] },
    { name: "response", message: [1, 1, null] },
    { name: "notification", message: [2, "event", "not-params"] },
    { name: "request", message: [0, 1, 42, []] },
  ])("treats a malformed $name shape as fatal", async ({ message }) => {
    const transport = new FakeTransport();
    const client = new MessagePackRpcClient(transport);
    const errors: Error[] = [];
    client.onError((error) => errors.push(error));
    await client.connect();

    transport.emitData(encode(message));

    await vi.waitFor(() => expect(transport.closeCalls).toBe(1));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(MessagePackRpcProtocolError);
  });

  it("rejects an unknown response ID as a protocol error", async () => {
    const transport = new FakeTransport();
    const client = new MessagePackRpcClient(transport);
    const errors: Error[] = [];
    client.onError((error) => errors.push(error));
    await client.connect();

    transport.emitData(encode([1, 999, null, "orphaned"]));

    await vi.waitFor(() => expect(transport.closeCalls).toBe(1));
    expect(errors[0]).toBeInstanceOf(MessagePackRpcProtocolError);
    expect(errors[0]?.message).toContain("unknown request ID 999");
  });

  it("delivers a complete frame before failing on a later invalid marker", async () => {
    const transport = new FakeTransport();
    const client = new MessagePackRpcClient(transport);
    const notifications = vi.fn();
    const errors: Error[] = [];
    client.onNotification(notifications);
    client.onError((error) => errors.push(error));
    await client.connect();

    transport.emitData(
      concatenate(encode([2, "ready", [1]]), Uint8Array.of(0xc1)),
    );

    expect(notifications).toHaveBeenCalledOnce();
    expect(notifications).toHaveBeenCalledWith("ready", [1]);
    await vi.waitFor(() => expect(transport.closeCalls).toBe(1));
    expect(errors[0]?.message).toContain("Invalid MessagePack data");
  });

  it("delivers complete frames before reporting an incomplete trailing value on close", async () => {
    const transport = new FakeTransport();
    const client = new MessagePackRpcClient(transport);
    const notifications = vi.fn();
    const errors: Error[] = [];
    client.onNotification(notifications);
    client.onError((error) => errors.push(error));
    await client.connect();
    const partial = encode([2, "later", [1, 2, 3]]);

    transport.emitData(
      concatenate(encode([2, "ready", []]), partial.subarray(0, 3)),
    );
    transport.emitClose();

    expect(notifications).toHaveBeenCalledOnce();
    expect(notifications).toHaveBeenCalledWith("ready", []);
    expect(errors[0]?.message).toContain("incomplete MessagePack value");
  });

  it("stops delivering the active chunk when a notification closes the client", async () => {
    const transport = new FakeTransport();
    const client = new MessagePackRpcClient(transport);
    const notifications: string[] = [];
    client.onNotification((method) => {
      notifications.push(method);
      if (method === "close-now") void client.close();
    });
    await client.connect();

    transport.emitData(
      concatenate(
        encode([2, "close-now", []]),
        encode([2, "must-not-deliver", []]),
      ),
    );

    await vi.waitFor(() => expect(transport.closeCalls).toBe(1));
    expect(notifications).toEqual(["close-now"]);
  });

  it("reports an incomplete MessagePack value when the transport closes", async () => {
    const transport = new FakeTransport();
    const client = new MessagePackRpcClient(transport);
    const errors: Error[] = [];
    client.onError((error) => errors.push(error));
    await client.connect();
    const pending = client.request("waiting");

    transport.emitData(Uint8Array.of(0x93, 0x01));
    transport.emitClose();

    await expect(pending).rejects.toThrow("incomplete MessagePack value");
    expect(errors[0]).toBeInstanceOf(MessagePackRpcProtocolError);
  });

  it("rejects all pending requests when the transport closes", async () => {
    const transport = new FakeTransport();
    const client = new MessagePackRpcClient(transport);
    await client.connect();
    const first = client.request("first");
    const second = client.request("second");

    transport.emitClose(new Error("socket reset"));

    await expect(first).rejects.toBeInstanceOf(
      MessagePackRpcConnectionClosedError,
    );
    await expect(second).rejects.toThrow("socket reset");
    await expect(client.request("late")).rejects.toBeInstanceOf(
      MessagePackRpcConnectionClosedError,
    );
  });

  it("cleans up a request whose write fails", async () => {
    const transport = new FakeTransport();
    const client = new MessagePackRpcClient(transport);
    await client.connect();
    transport.writeError = new Error("write failed");

    await expect(client.request("lost")).rejects.toThrow("write failed");

    transport.writeError = undefined;
    const next = client.request("next");
    const nextId = (decode(transport.writes[0]!) as unknown[])[1] as number;
    transport.emitData(encode([1, nextId, null, "ok"]));
    await expect(next).resolves.toBe("ok");
  });

  it("closes explicitly and rejects outstanding requests", async () => {
    const transport = new FakeTransport();
    const client = new MessagePackRpcClient(transport);
    await client.connect();
    const pending = client.request("waiting");

    await client.close();

    await expect(pending).rejects.toBeInstanceOf(
      MessagePackRpcConnectionClosedError,
    );
    expect(transport.closeCalls).toBe(1);
    await client.close();
    expect(transport.closeCalls).toBe(1);
  });

  it("records sanitized framing, decode, and encode diagnostics", async () => {
    configurePerformanceDiagnostics({
      enabled: true,
      log: false,
      build: "release",
    });
    const transport = new FakeTransport();
    const client = new MessagePackRpcClient(transport);
    await client.connect();

    const response = withPerformanceTags(
      { source: "ime", inputLength: 1, connectionGeneration: 4 },
      () => client.request("private-method", ["private-value"]),
    );
    const outgoing = decode(transport.writes[0]!) as unknown[];
    const requestId = outgoing[1] as number;
    const responseBytes = encode([1, requestId, null, "ok"]);
    transport.emitData(responseBytes.subarray(0, 2));
    transport.emitData(responseBytes.subarray(2));
    await expect(response).resolves.toBe("ok");

    const records = getPerformanceRecords();
    expect(records.map((record) => record.stage)).toEqual(
      expect.arrayContaining([
        "msgpack_encode",
        "msgpack_framing",
        "msgpack_decode",
      ]),
    );
    expect(
      records.find((record) => record.stage === "msgpack_encode")?.tags,
    ).toMatchObject({
      source: "ime",
      inputLength: 1,
      connectionGeneration: 4,
      byteLength: transport.writes[0]?.byteLength,
      build: "release",
    });
    expect(JSON.stringify(records)).not.toContain("private-method");
    expect(JSON.stringify(records)).not.toContain("private-value");
  });
});
