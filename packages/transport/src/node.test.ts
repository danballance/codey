import { createServer, type Server, type Socket } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { NodeTcpTransport } from "./node.js";

const servers = new Set<Server>();
const sockets = new Set<Socket>();

afterEach(async () => {
  for (const socket of sockets) {
    socket.destroy();
  }
  sockets.clear();
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  servers.clear();
});

async function listen(
  onConnection?: (socket: Socket) => void,
): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    onConnection?.(socket);
  });
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP address");
  }
  return { server, port: address.port };
}

describe("NodeTcpTransport", () => {
  it("connects, forwards arbitrary chunks, and writes bytes", async () => {
    let peer: Socket | undefined;
    const { port } = await listen((socket) => {
      peer = socket;
    });
    const transport = new NodeTcpTransport({ host: "127.0.0.1", port });
    const received: number[] = [];
    transport.onData((chunk) => received.push(...chunk));

    await transport.connect();
    await new Promise<void>((resolve) => setImmediate(resolve));

    const written = new Promise<Buffer>((resolve) => peer!.once("data", resolve));
    await transport.write(Uint8Array.of(9, 8, 7));
    expect([...await written]).toEqual([9, 8, 7]);

    peer!.write(Uint8Array.of(1, 2));
    peer!.write(Uint8Array.of(3, 4));
    await vi.waitFor(() => expect(received).toEqual([1, 2, 3, 4]));

    await transport.close();
  });

  it("shares an in-flight connect and makes close idempotent", async () => {
    const { port } = await listen();
    const transport = new NodeTcpTransport({ host: "127.0.0.1", port });
    const firstConnect = transport.connect();
    expect(transport.connect()).toBe(firstConnect);
    await firstConnect;

    let closeCount = 0;
    transport.onClose(() => closeCount++);
    const firstClose = transport.close();
    expect(transport.close()).toBe(firstClose);
    await firstClose;
    expect(closeCount).toBe(1);
    await transport.close();
    expect(closeCount).toBe(1);
  });

  it("rejects connection failures and reports the reason on close", async () => {
    const { server, port } = await listen();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    servers.delete(server);

    const transport = new NodeTcpTransport({
      host: "127.0.0.1",
      port,
      connectTimeoutMs: 1_000,
    });
    const closed = new Promise<Error | undefined>((resolve) => {
      transport.onClose(resolve);
    });

    await expect(transport.connect()).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });
    await expect(closed).resolves.toBeInstanceOf(Error);
    await expect(transport.write(Uint8Array.of(1))).rejects.toThrow(
      "not connected",
    );
  });

  it("validates its endpoint", () => {
    expect(() => new NodeTcpTransport({ host: " ", port: 6666 })).toThrow(
      "host",
    );
    expect(() => new NodeTcpTransport({ host: "localhost", port: 0 })).toThrow(
      "port",
    );
  });
});
