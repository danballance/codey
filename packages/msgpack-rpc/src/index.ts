import { Decoder, Encoder } from "@msgpack/msgpack";

import {
  currentPerformanceTags,
  performanceDiagnosticsEnabled,
  performanceNow,
  recordPerformance,
} from "@codey/perf";
import type { DuplexTransport } from "@codey/transport";

import { MessagePackStreamFramer } from "./framing";

export type RpcParams = readonly unknown[];
export type RpcNotificationListener = (
  method: string,
  params: unknown[],
) => void;
export type RpcRequestHandler = (
  params: unknown[],
) => unknown | Promise<unknown>;

export class MessagePackRpcProtocolError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "MessagePackRpcProtocolError";
  }
}

export class MessagePackRpcConnectionClosedError extends Error {
  constructor(message = "MessagePack-RPC connection is closed", cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "MessagePackRpcConnectionClosedError";
  }
}

export class MessagePackRpcRemoteError extends Error {
  readonly requestId: number;
  readonly method: string;
  readonly remoteError: unknown;

  constructor(requestId: number, method: string, remoteError: unknown) {
    super(
      `MessagePack-RPC request ${method} (${requestId}) failed: ${formatRemoteError(remoteError)}`,
    );
    this.name = "MessagePackRpcRemoteError";
    this.requestId = requestId;
    this.method = method;
    this.remoteError = remoteError;
  }
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
}

type ClientState = "idle" | "connecting" | "connected" | "closing" | "closed";

export class MessagePackRpcClient {
  readonly #transport: DuplexTransport;
  readonly #pendingRequests = new Map<number, PendingRequest>();
  readonly #notificationListeners = new Set<RpcNotificationListener>();
  readonly #requestHandlers = new Map<string, RpcRequestHandler>();
  readonly #errorListeners = new Set<(error: Error) => void>();
  readonly #framer = new MessagePackStreamFramer();
  readonly #decoder = new Decoder();
  readonly #encoder = new Encoder();
  readonly #receiveFrame = (frame: Uint8Array): void => {
    this.#acceptFrame(frame);
  };

  #state: ClientState = "idle";
  #nextRequestId = 1;
  #connectPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #unsubscribeData: (() => void) | undefined;
  #unsubscribeClose: (() => void) | undefined;
  #terminalError: Error | undefined;
  #explicitClose = false;

  constructor(transport: DuplexTransport) {
    this.#transport = transport;
  }

  connect(): Promise<void> {
    if (this.#state === "connected") {
      return Promise.resolve();
    }
    if (this.#state === "connecting") {
      return this.#connectPromise!;
    }
    if (this.#state === "closing" || this.#state === "closed") {
      return Promise.reject(this.#closedError());
    }

    this.#state = "connecting";
    this.#unsubscribeData = this.#transport.onData((chunk) => {
      this.#acceptChunk(chunk);
    });
    this.#unsubscribeClose = this.#transport.onClose((error) => {
      this.#handleTransportClose(error);
    });

    this.#connectPromise = this.#transport.connect().then(
      () => {
        if (this.#state !== "connecting") {
          throw this.#closedError();
        }
        this.#state = "connected";
      },
      (reason: unknown) => {
        const error = toError(reason, "MessagePack-RPC transport failed to connect");
        if (this.#state !== "closed") {
          this.#terminalError = error;
          this.#reportError(error);
          this.#finishClosed(error);
        }
        throw error;
      },
    );
    return this.#connectPromise;
  }

  request<T = unknown>(method: string, params: RpcParams = []): Promise<T> {
    if (this.#state !== "connected") {
      return Promise.reject(this.#closedError());
    }

    const requestId = this.#allocateRequestId();
    const response = new Promise<T>((resolve, reject) => {
      this.#pendingRequests.set(requestId, {
        method,
        resolve: (result) => resolve(result as T),
        reject,
      });
    });

    void this.#writeFrame([0, requestId, method, params]).catch((reason: unknown) => {
      const pending = this.#pendingRequests.get(requestId);
      if (pending === undefined) {
        return;
      }
      this.#pendingRequests.delete(requestId);
      pending.reject(toError(reason, `Failed to write RPC request ${method}`));
    });

    return response;
  }

  async notify(method: string, params: RpcParams = []): Promise<void> {
    if (this.#state !== "connected") {
      throw this.#closedError();
    }
    await this.#writeFrame([2, method, params]);
  }

  onNotification(listener: RpcNotificationListener): () => void {
    this.#notificationListeners.add(listener);
    return () => {
      this.#notificationListeners.delete(listener);
    };
  }

  onRequest(method: string, handler: RpcRequestHandler): () => void {
    this.#requestHandlers.set(method, handler);
    return () => {
      if (this.#requestHandlers.get(method) === handler) {
        this.#requestHandlers.delete(method);
      }
    };
  }

  onError(listener: (error: Error) => void): () => void {
    this.#errorListeners.add(listener);
    return () => {
      this.#errorListeners.delete(listener);
    };
  }

  close(): Promise<void> {
    if (this.#state === "closed") {
      return Promise.resolve();
    }
    if (this.#state === "closing") {
      return this.#closePromise ?? Promise.resolve();
    }

    this.#explicitClose = true;
    this.#state = "closing";
    this.#framer.reset();
    this.#rejectPending(
      new MessagePackRpcConnectionClosedError("MessagePack-RPC client was closed"),
    );

    this.#closePromise = this.#transport.close().then(
      () => {
        this.#finishClosed();
      },
      (reason: unknown) => {
        const error = toError(reason, "Failed to close MessagePack-RPC transport");
        this.#terminalError = error;
        this.#reportError(error);
        this.#finishClosed(error);
        throw error;
      },
    );
    return this.#closePromise;
  }

  #acceptChunk(chunk: Uint8Array): void {
    if (
      chunk.byteLength === 0 ||
      this.#state === "closing" ||
      this.#state === "closed"
    ) {
      return;
    }

    const diagnosticsEnabled = performanceDiagnosticsEnabled();
    let framingStartedAt = diagnosticsEnabled ? performanceNow() : 0;
    let scannedBefore = this.#framer.scannedByteCount;
    let copiedBefore = this.#framer.copiedByteCount;
    let failure: MessagePackRpcProtocolError | undefined;

    try {
      if (diagnosticsEnabled) {
        this.#framer.push(chunk, (frame) => {
          this.#recordFramingWork(
            framingStartedAt,
            scannedBefore,
            copiedBefore,
          );
          try {
            this.#acceptFrame(frame);
          } finally {
            // Delivery can synchronously close the client and reset framing.
            scannedBefore = this.#framer.scannedByteCount;
            copiedBefore = this.#framer.copiedByteCount;
            framingStartedAt = performanceNow();
          }
        });
      } else {
        this.#framer.push(chunk, this.#receiveFrame);
      }
    } catch (cause) {
      failure =
        cause instanceof MessagePackRpcProtocolError
          ? cause
          : new MessagePackRpcProtocolError(
              "Invalid MessagePack data received from the transport",
              cause,
            );
    } finally {
      if (diagnosticsEnabled) {
        this.#recordFramingWork(
          framingStartedAt,
          scannedBefore,
          copiedBefore,
        );
      }
    }

    if (failure !== undefined) {
      this.#fail(failure);
    }
  }

  #acceptFrame(frame: Uint8Array): void {
    const diagnosticsEnabled = performanceDiagnosticsEnabled();
    const decodeStartedAt = diagnosticsEnabled ? performanceNow() : 0;
    let message: unknown;
    try {
      message = this.#decoder.decode(frame);
    } catch (cause) {
      throw new MessagePackRpcProtocolError(
        "Failed to decode a MessagePack-RPC value",
        cause,
      );
    } finally {
      if (diagnosticsEnabled) {
        recordPerformance("msgpack_decode", {
          startedAtMs: decodeStartedAt,
          tags: { source: "rpc", byteLength: frame.byteLength },
        });
      }
    }

    try {
      this.#handleMessage(message);
    } catch (cause) {
      throw cause instanceof MessagePackRpcProtocolError
        ? cause
        : new MessagePackRpcProtocolError(
            "Invalid MessagePack-RPC message",
            cause,
          );
    }
  }

  #recordFramingWork(
    startedAtMs: number,
    scannedBefore: number,
    copiedBefore: number,
  ): void {
    const scannedBytes = Math.max(
      0,
      this.#framer.scannedByteCount - scannedBefore,
    );
    const copiedBytes = Math.max(
      0,
      this.#framer.copiedByteCount - copiedBefore,
    );
    if (scannedBytes === 0 && copiedBytes === 0) {
      return;
    }
    recordPerformance("msgpack_framing", {
      startedAtMs,
      tags: {
        source: "rpc",
        byteLength: scannedBytes,
        scannedBytes,
        copiedBytes,
        segmentCount: this.#framer.queuedSegmentCount,
      },
    });
  }

  #handleMessage(message: unknown): void {
    if (!Array.isArray(message) || message.length === 0) {
      throw new MessagePackRpcProtocolError(
        "An RPC message must be a non-empty array",
      );
    }

    switch (message[0]) {
      case 0:
        this.#handleRequest(message);
        return;
      case 1:
        this.#handleResponse(message);
        return;
      case 2:
        this.#handleNotification(message);
        return;
      default:
        throw new MessagePackRpcProtocolError(
          `Unknown MessagePack-RPC message type: ${String(message[0])}`,
        );
    }
  }

  #handleResponse(message: unknown[]): void {
    if (message.length !== 4 || !isRequestId(message[1])) {
      throw new MessagePackRpcProtocolError("Malformed RPC response");
    }

    const requestId = message[1];
    const pending = this.#pendingRequests.get(requestId);
    if (pending === undefined) {
      throw new MessagePackRpcProtocolError(
        `Received a response for unknown request ID ${requestId}`,
      );
    }
    this.#pendingRequests.delete(requestId);

    if (message[2] != null) {
      pending.reject(
        new MessagePackRpcRemoteError(
          requestId,
          pending.method,
          message[2],
        ),
      );
    } else {
      pending.resolve(message[3]);
    }
  }

  #handleNotification(message: unknown[]): void {
    if (
      message.length !== 3 ||
      typeof message[1] !== "string" ||
      !Array.isArray(message[2])
    ) {
      throw new MessagePackRpcProtocolError("Malformed RPC notification");
    }

    for (const listener of this.#notificationListeners) {
      try {
        listener(message[1], message[2]);
      } catch (reason) {
        this.#reportError(toError(reason, "RPC notification listener failed"));
      }
    }
  }

  #handleRequest(message: unknown[]): void {
    if (
      message.length !== 4 ||
      !isRequestId(message[1]) ||
      typeof message[2] !== "string" ||
      !Array.isArray(message[3])
    ) {
      throw new MessagePackRpcProtocolError("Malformed RPC request");
    }

    const requestId = message[1];
    const method = message[2];
    const params = message[3];
    const handler = this.#requestHandlers.get(method);

    if (handler === undefined) {
      void this.#writeServerResponse(requestId, {
        name: "MethodNotFound",
        message: `No RPC request handler is registered for ${method}`,
      });
      return;
    }

    void Promise.resolve()
      .then(() => handler(params))
      .then(
        (result) => this.#writeServerResponse(requestId, null, result),
        (reason: unknown) =>
          this.#writeServerResponse(requestId, serializeError(reason)),
      );
  }

  async #writeServerResponse(
    requestId: number,
    error: unknown,
    result: unknown = null,
  ): Promise<void> {
    if (this.#state !== "connected" && this.#state !== "connecting") {
      return;
    }

    try {
      await this.#writeFrame([
        1,
        requestId,
        error ?? null,
        result === undefined ? null : result,
      ]);
    } catch (reason) {
      this.#fail(toError(reason, "Failed to write an RPC response"));
    }
  }

  async #writeFrame(message: unknown[]): Promise<void> {
    // Keep encoding inside the async boundary so unsupported/cyclic values
    // reject callers instead of escaping synchronously and leaking pending IDs.
    const diagnosticsEnabled = performanceDiagnosticsEnabled();
    const encodeStartedAt = diagnosticsEnabled ? performanceNow() : 0;
    const encodeSource = diagnosticsEnabled
      ? (currentPerformanceTags().source ?? "rpc")
      : "rpc";
    let bytes: Uint8Array | undefined;
    try {
      bytes = this.#encoder.encode(message);
    } finally {
      if (diagnosticsEnabled) {
        recordPerformance("msgpack_encode", {
          startedAtMs: encodeStartedAt,
          tags:
            bytes === undefined
              ? { source: encodeSource }
              : { source: encodeSource, byteLength: bytes.byteLength },
        });
      }
    }
    if (bytes === undefined) {
      throw new Error("MessagePack encoder returned no bytes");
    }
    await this.#transport.write(bytes);
  }

  #handleTransportClose(transportError?: Error): void {
    if (this.#state === "closed") {
      return;
    }

    // A fatal decoder/protocol error initiated this close and was already
    // surfaced. The transport's resulting close event only completes cleanup.
    if (this.#state === "closing" && this.#terminalError !== undefined) {
      this.#finishClosed(this.#terminalError);
      return;
    }

    if (this.#explicitClose) {
      this.#finishClosed();
      return;
    }

    let error = this.#terminalError;
    if (error === undefined && this.#framer.hasIncompleteFrame) {
      error = new MessagePackRpcProtocolError(
        "Transport closed with an incomplete MessagePack value",
        transportError,
      );
    }
    error ??= new MessagePackRpcConnectionClosedError(
      transportError === undefined
        ? "MessagePack-RPC transport closed unexpectedly"
        : `MessagePack-RPC transport closed: ${transportError.message}`,
      transportError,
    );

    this.#terminalError = error;
    this.#reportError(error);
    this.#finishClosed(error);
  }

  #fail(error: Error): void {
    if (this.#state === "closing" || this.#state === "closed") {
      return;
    }

    this.#terminalError = error;
    this.#reportError(error);
    this.#rejectPending(error);
    this.#framer.reset();
    this.#state = "closing";

    this.#closePromise = this.#transport.close().then(
      () => {
        this.#finishClosed(error);
      },
      (closeReason: unknown) => {
        this.#reportError(toError(closeReason, "Failed to close RPC transport"));
        this.#finishClosed(error);
      },
    );
  }

  #finishClosed(error?: Error): void {
    if (this.#state === "closed") {
      return;
    }
    this.#state = "closed";
    this.#terminalError ??= error;
    if (error !== undefined) {
      this.#rejectPending(error);
    }
    this.#framer.reset();
    this.#unsubscribeData?.();
    this.#unsubscribeClose?.();
    this.#unsubscribeData = undefined;
    this.#unsubscribeClose = undefined;
  }

  #rejectPending(error: Error): void {
    const pending = [...this.#pendingRequests.values()];
    this.#pendingRequests.clear();
    for (const request of pending) {
      request.reject(error);
    }
  }

  #reportError(error: Error): void {
    for (const listener of this.#errorListeners) {
      try {
        listener(error);
      } catch {
        // Error listeners are observers; one must not break protocol handling.
      }
    }
  }

  #allocateRequestId(): number {
    let candidate = this.#nextRequestId;
    while (this.#pendingRequests.has(candidate)) {
      candidate = candidate === 0xffff_ffff ? 1 : candidate + 1;
    }
    this.#nextRequestId = candidate === 0xffff_ffff ? 1 : candidate + 1;
    return candidate;
  }

  #closedError(): Error {
    return (
      this.#terminalError ??
      new MessagePackRpcConnectionClosedError(
        this.#state === "idle"
          ? "MessagePack-RPC client is not connected"
          : "MessagePack-RPC connection is closed",
      )
    );
  }
}

function isRequestId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function toError(reason: unknown, fallbackMessage: string): Error {
  if (reason instanceof Error) {
    return reason;
  }
  return new Error(fallbackMessage, { cause: reason });
}

function serializeError(reason: unknown): { name: string; message: string } {
  if (reason instanceof Error) {
    return { name: reason.name, message: reason.message };
  }
  return { name: "Error", message: String(reason) };
}

function formatRemoteError(remoteError: unknown): string {
  if (typeof remoteError === "string") {
    return remoteError;
  }
  if (
    typeof remoteError === "object" &&
    remoteError !== null &&
    "message" in remoteError &&
    typeof remoteError.message === "string"
  ) {
    return remoteError.message;
  }
  try {
    return JSON.stringify(remoteError);
  } catch {
    return String(remoteError);
  }
}
