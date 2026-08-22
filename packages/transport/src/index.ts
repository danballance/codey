export interface DuplexTransport {
  connect(): Promise<void>;
  write(data: Uint8Array): Promise<void>;
  onData(listener: (chunk: Uint8Array) => void): () => void;
  onClose(listener: (error?: Error) => void): () => void;
  close(): Promise<void>;
}
