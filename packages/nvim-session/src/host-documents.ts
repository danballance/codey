import type { MessagePackRpcClient } from "@codey/msgpack-rpc";

export const MAX_HOST_DOCUMENT_BYTES = 1024 * 1024;

export interface HostDocument {
  readonly path: string;
  readonly text: string | null;
}

export interface HostDocumentWrite {
  readonly path: string;
  readonly text: string;
}

export type HostDocumentErrorCode =
  | "conflict"
  | "invalid-path"
  | "not-found"
  | "permission"
  | "too-large"
  | "io";

export class HostDocumentError extends Error {
  public constructor(
    public readonly code: HostDocumentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HostDocumentError";
  }
}

type DocumentRpc = Pick<MessagePackRpcClient, "request">;

// Only this fixed program executes on the host. Paths and YAML are arguments,
// never executable Lua, Ex commands, or shell fragments.
const HOST_DOCUMENT_LUA = String.raw`
local operation, request = ...
local uv = vim.uv or vim.loop
local max_bytes = 1048576
local descriptors = {}
local write_started = false

local function fail(code, message)
  error({ code = code, message = message, host_document_error = true }, 0)
end

local function io_error(message, detail, code)
  if not code and type(detail) == "string" then code = detail:match("^([A-Z][A-Z0-9_]*)") end
  local kind = "io"
  if code == "EACCES" or code == "EPERM" or code == "EROFS" then
    kind = "permission"
  elseif code == "ENOENT" then
    kind = "not-found"
  elseif code == "ENOTDIR" or code == "EISDIR" or code == "ELOOP" or code == "ENAMETOOLONG" then
    kind = "invalid-path"
  end
  fail(kind, message .. (detail and (": " .. tostring(detail)) or ""))
end

local function checked(value, detail, code)
  if value == nil or value == false then
    io_error("Host file operation failed", detail, code)
  end
  return value
end

local function close_descriptor(fd)
  local result, detail, code = uv.fs_close(fd)
  descriptors[fd] = nil
  checked(result, detail, code)
end

local function cleanup()
  for fd in pairs(descriptors) do
    pcall(uv.fs_close, fd)
  end
end

local function absolute_path(path)
  if type(path) ~= "string" or path == "" or path:find("\0", 1, true) then
    fail("invalid-path", "Enter an absolute host file path or a path starting with ~/.")
  end
  if path:sub(1, 2) == "~/" then
    path = vim.fn.expand("~") .. path:sub(2)
  end
  if path:sub(1, 1) ~= "/" or path == "/" or path:sub(-1) == "/" then
    fail("invalid-path", "Enter an absolute host file path or a path starting with ~/.")
  end
  return path
end

local function split_path(path)
  local parent, name = path:match("^(.*)/([^/]*)$")
  if not parent or name == "" then
    fail("invalid-path", "The host path has no valid file name.")
  end
  return parent == "" and "/" or parent, name
end

local function same_identity(first, second)
  return first.dev == second.dev and first.ino == second.ino
end

local function same_stamp(first, second)
  return same_identity(first, second)
    and first.size == second.size
    and first.mtime.sec == second.mtime.sec and first.mtime.nsec == second.mtime.nsec
    and first.ctime.sec == second.ctime.sec and first.ctime.nsec == second.ctime.nsec
end

local function valid_utf8(text)
  local index = 1
  while index <= #text do
    local first = text:byte(index)
    local count, low, high = 0, 128, 191
    if first < 128 then count = 0
    elseif first >= 194 and first <= 223 then count = 1
    elseif first >= 224 and first <= 239 then
      count = 2
      if first == 224 then low = 160 elseif first == 237 then high = 159 end
    elseif first >= 240 and first <= 244 then
      count = 3
      if first == 240 then low = 144 elseif first == 244 then high = 143 end
    else return false end
    if index + count > #text then return false end
    for offset = 1, count do
      local byte = text:byte(index + offset)
      local minimum, maximum = 128, 191
      if offset == 1 then minimum, maximum = low, high end
      if byte < minimum or byte > maximum then return false end
    end
    index = index + count + 1
  end
  return true
end

local function ensure_directory(path)
  local stat, detail, code = uv.fs_stat(path)
  if stat then
    if stat.type ~= "directory" then fail("invalid-path", "The host parent is not a directory.") end
    return
  end
  if code ~= "ENOENT" then io_error("Cannot inspect the host directory", detail, code) end
  if path == "/" then fail("not-found", "The host root directory is unavailable.") end
  local parent = split_path(path)
  ensure_directory(parent)
  local created, create_detail, create_code = uv.fs_mkdir(path, 448)
  if not created and create_code ~= "EEXIST" then
    io_error("Cannot create the host directory", create_detail, create_code)
  end
  if not created then
    local current = checked(uv.fs_stat(path))
    if current.type ~= "directory" then fail("invalid-path", "The host parent is not a directory.") end
  end
end

local function read_document(path)
  local stat, detail, code = uv.fs_stat(path)
  if not stat then
    if code == "ENOENT" then return { path = path, text = vim.NIL } end
    io_error("Cannot inspect the host file", detail, code)
  end
  if stat.type ~= "file" then
    fail("invalid-path", "The selected host document must be a regular file.")
  end
  if stat.size > max_bytes then fail("too-large", "The host YAML file exceeds 1 MiB.") end

  local flags = bit.bor(uv.constants.O_RDONLY, uv.constants.O_NONBLOCK)
  local fd = checked(uv.fs_open(path, flags, 0))
  descriptors[fd] = true
  local opened = checked(uv.fs_fstat(fd))
  if opened.type ~= "file" or not same_identity(stat, opened) then
    fail("conflict", "The host file changed while it was being opened. Load it again.")
  end
  if opened.size > max_bytes then fail("too-large", "The host YAML file exceeds 1 MiB.") end

  local chunks, length = {}, 0
  while true do
    local chunk = checked(uv.fs_read(fd, math.min(65536, max_bytes + 1 - length), length))
    if #chunk == 0 then break end
    length = length + #chunk
    if length > max_bytes then fail("too-large", "The host YAML file exceeds 1 MiB.") end
    chunks[#chunks + 1] = chunk
  end
  local finished = checked(uv.fs_fstat(fd))
  close_descriptor(fd)
  if not same_stamp(opened, finished) then
    fail("conflict", "The host file changed while it was being read. Load it again.")
  end
  local text = table.concat(chunks)
  if not valid_utf8(text) then fail("io", "The host document is not valid UTF-8.") end
  return { path = path, text = text }
end

local function write_document(path, input)
  if type(input.text) ~= "string" then fail("io", "Host document text must be a string.") end
  if #input.text > max_bytes then fail("too-large", "The host YAML file exceeds 1 MiB.") end
  if not valid_utf8(input.text) then fail("io", "The host document is not valid UTF-8.") end

  local parent = split_path(path)
  ensure_directory(parent)
  local existing, detail, code = uv.fs_stat(path)
  if existing and existing.type ~= "file" then
    fail("invalid-path", "The selected host document must be a regular file.")
  elseif not existing and code ~= "ENOENT" then
    io_error("Cannot inspect the host file", detail, code)
  end

  local flags = bit.bor(
    uv.constants.O_WRONLY,
    uv.constants.O_CREAT,
    uv.constants.O_TRUNC,
    uv.constants.O_NONBLOCK
  )
  local fd = checked(uv.fs_open(path, flags, 384))
  write_started = true
  descriptors[fd] = true
  local opened = checked(uv.fs_fstat(fd))
  if opened.type ~= "file" then
    fail("invalid-path", "The selected host document must be a regular file.")
  end

  local offset = 0
  while offset < #input.text do
    local written = checked(uv.fs_write(fd, input.text:sub(offset + 1), offset))
    if written == 0 then fail("io", "The host file write made no progress.") end
    offset = offset + written
  end
  checked(uv.fs_fsync(fd))
  close_descriptor(fd)
end

local ok, result = pcall(function()
  if type(request) ~= "table" then fail("io", "Invalid host document request.") end
  local path = absolute_path(request.path)
  if operation == "read" then return { document = read_document(path) } end
  if operation == "write" then
    write_document(path, request)
    return {}
  end
  fail("io", "Unknown host document operation.")
end)
cleanup()
if ok then
  result.ok = true
  return result
end
if type(result) == "table" and result.host_document_error then
  local message = result.message
  if write_started then message = message .. " The YAML may be incomplete." end
  return { ok = false, code = result.code, message = message }
end
return { ok = false, code = "io", message = "Host document operation failed: " .. tostring(result) }
`;

export async function readHostDocument(
  rpc: DocumentRpc,
  path: string,
): Promise<HostDocument> {
  assertPath(path);
  return documentResult(await execute(rpc, "read", { path }));
}

export async function writeHostDocument(
  rpc: DocumentRpc,
  request: HostDocumentWrite,
): Promise<void> {
  assertPath(request.path);
  if (typeof request.text !== "string") {
    throw new HostDocumentError("io", "Host document text must be a string.");
  }
  if (utf8ByteLength(request.text) > MAX_HOST_DOCUMENT_BYTES) {
    throw new HostDocumentError("too-large", "The host YAML file exceeds 1 MiB.");
  }
  await execute(rpc, "write", { path: request.path, text: request.text });
}

async function execute(
  rpc: DocumentRpc,
  operation: string,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await rpc.request<unknown>("nvim_exec_lua", [
    HOST_DOCUMENT_LUA,
    [operation, request],
  ]);
  if (!isRecord(result)) throw invalidResponse();
  if (result.ok === false && isErrorCode(result.code) && typeof result.message === "string") {
    throw new HostDocumentError(result.code, result.message);
  }
  if (result.ok !== true) throw invalidResponse();
  return result;
}

function documentResult(result: Record<string, unknown>): HostDocument {
  const value = result.document;
  if (
    !isRecord(value) ||
    typeof value.path !== "string" || !value.path.startsWith("/") ||
    !(value.text === null || typeof value.text === "string")
  ) {
    throw invalidResponse();
  }
  if (typeof value.text === "string" && utf8ByteLength(value.text) > MAX_HOST_DOCUMENT_BYTES) {
    throw new HostDocumentError("too-large", "The host YAML file exceeds 1 MiB.");
  }
  return { path: value.path, text: value.text as string | null };
}

function assertPath(path: string): void {
  if (
    typeof path !== "string" || !(path.startsWith("/") || path.startsWith("~/")) ||
    path.includes("\0") || path === "/" || path.endsWith("/")
  ) {
    throw new HostDocumentError(
      "invalid-path",
      "Enter an absolute host file path or a path starting with ~/.",
    );
  }
}

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes > MAX_HOST_DOCUMENT_BYTES) break;
  }
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorCode(value: unknown): value is HostDocumentErrorCode {
  return typeof value === "string" &&
    ["conflict", "invalid-path", "not-found", "permission", "too-large", "io"].includes(value);
}

function invalidResponse(): HostDocumentError {
  return new HostDocumentError("io", "The host returned an invalid document response.");
}
