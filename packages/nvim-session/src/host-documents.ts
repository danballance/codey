import type { MessagePackRpcClient } from "@codey/msgpack-rpc";

export const MAX_HOST_DOCUMENT_BYTES = 1024 * 1024;

export interface HostDocument {
  readonly path: string;
  readonly resolvedPath: string;
  readonly text: string | null;
  readonly revision: string | null;
}

export interface HostDocumentWrite {
  readonly path: string;
  readonly text: string;
  readonly expectedRevision: string | null;
  readonly expectedResolvedPath?: string;
}

export type HostDocumentErrorCode =
  | "conflict"
  | "modified-buffer"
  | "invalid-path"
  | "not-found"
  | "permission"
  | "too-large"
  | "io";

export type HostDocumentErrorStage =
  | "validation"
  | "filesystem"
  | "conflict"
  | "permission"
  | "publication"
  | "sync"
  | "read-back";

export class HostDocumentError extends Error {
  public constructor(
    public readonly code: HostDocumentErrorCode,
    message: string,
    public readonly stage?: HostDocumentErrorStage,
  ) {
    super(message);
    this.name = "HostDocumentError";
  }
}

type DocumentRpc = Pick<MessagePackRpcClient, "request">;

// Only this fixed program executes on the host. Paths, YAML, and revisions are
// arguments, never executable Lua, Ex commands, or shell fragments.
const HOST_DOCUMENT_LUA = String.raw`
local operation, request = ...
local uv = vim.uv or vim.loop
local max_bytes = 1048576
local descriptors = {}
local temporary_path
local published = false
local current_stage = "validation"

local function fail(code, message, stage)
  error({
    code = code, message = message, stage = stage or current_stage,
    host_document_error = true,
  }, 0)
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
  if temporary_path then
    pcall(uv.fs_unlink, temporary_path)
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
  if not parent then
    fail("invalid-path", "The host path has no parent directory.")
  end
  return parent == "" and "/" or parent, name
end

local function child_path(parent, name)
  if name == "." or name == "" then return parent end
  if name == ".." then
    local ancestor = parent:match("^(.*)/[^/]+$")
    return ancestor and ancestor ~= "" and ancestor or "/"
  end
  return (parent == "/" and "" or parent) .. "/" .. name
end

local function resolve_directory(path)
  local resolved, detail, code = uv.fs_realpath(path)
  if resolved then
    local stat = checked(uv.fs_stat(resolved))
    if stat.type ~= "directory" then
      fail("invalid-path", "The host file's parent is not a directory.")
    end
    return resolved
  end
  if code ~= "ENOENT" then
    io_error("Cannot resolve the host directory", detail, code)
  end
  local link, link_detail, link_code = uv.fs_lstat(path)
  if link then
    fail("not-found", "A host directory symlink has a missing target.")
  elseif link_code ~= "ENOENT" then
    io_error("Cannot inspect the host directory", link_detail, link_code)
  end
  if path == "/" then fail("not-found", "The host root directory is unavailable.") end
  local parent, name = split_path(path)
  return child_path(resolve_directory(parent), name)
end

local function resolve_path(path)
  local resolved, detail, code = uv.fs_realpath(path)
  if resolved then return resolved end
  if code ~= "ENOENT" then
    io_error("Cannot resolve the host file", detail, code)
  end
  local link, link_detail, link_code = uv.fs_lstat(path)
  if link then
    fail("not-found", "The host file symlink has a missing target.")
  elseif link_code ~= "ENOENT" then
    io_error("Cannot inspect the host file", link_detail, link_code)
  end
  local parent, name = split_path(path)
  return child_path(resolve_directory(parent), name)
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

local function read_document(path)
  if current_stage ~= "read-back" then current_stage = "filesystem" end
  local resolved = resolve_path(path)
  local stat, detail, code = uv.fs_lstat(resolved)
  if not stat then
    if code == "ENOENT" then
      return { path = path, resolvedPath = resolved, text = vim.NIL, revision = vim.NIL }
    end
    io_error("Cannot inspect the host file", detail, code)
  end
  if stat.type ~= "file" then
    fail("invalid-path", "The selected host document must be a regular file.")
  end
  if stat.size > max_bytes then fail("too-large", "The host YAML file exceeds 1 MiB.") end

  -- NONBLOCK prevents an external replacement with a FIFO from hanging Nvim.
  -- fstat also checks that the opened descriptor still refers to the inspected file.
  local flags = bit.bor(uv.constants.O_RDONLY, uv.constants.O_NONBLOCK)
  local fd = checked(uv.fs_open(resolved, flags, 0))
  descriptors[fd] = true
  local opened = checked(uv.fs_fstat(fd))
  if opened.type ~= "file" or not same_identity(stat, opened) then
    fail("conflict", "The host file changed while it was being opened.")
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
    fail("conflict", "The host file changed while it was being read.")
  end
  local text = table.concat(chunks)
  if not valid_utf8(text) then fail("io", "The host document is not valid UTF-8.") end
  return {
    path = path, resolvedPath = resolved, text = text,
    revision = vim.fn.sha256(text), stat = finished,
  }
end

local function public_document(document)
  return {
    path = document.path, resolvedPath = document.resolvedPath,
    text = document.text, revision = document.revision,
  }
end

local function check_baseline(document, expected_revision, expected_path)
  current_stage = "conflict"
  if expected_path and expected_path ~= vim.NIL and document.resolvedPath ~= expected_path then
    fail("conflict", "The host path now resolves to a different file. Reload it before saving.")
  end
  if document.revision ~= expected_revision then
    fail("conflict", expected_revision == vim.NIL
      and "The host file already exists. Reload or choose a different export path."
      or "The host file changed or was removed. Reload it before saving.")
  end
end

local function check_modified_buffers(document)
  current_stage = "conflict"
  for _, buffer in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_valid(buffer)
      and vim.api.nvim_get_option_value("modified", { buf = buffer }) then
      local name = vim.api.nvim_buf_get_name(buffer)
      if name ~= "" then
        local ok, resolved = pcall(resolve_path, name)
        if name == document.path or name == document.resolvedPath
          or (ok and resolved == document.resolvedPath) then
          fail("modified-buffer", "The host file has unsaved changes in a Neovim buffer.")
        end
      end
    end
  end
end

local function check_writable(path)
  current_stage = "permission"
  -- luv's access check returns false without an errno for denied access.
  if not uv.fs_access(path, "W") then
    fail("permission", "The selected host file is not writable.")
  end
end

local function sync_directory(path)
  local previous_stage = current_stage
  current_stage = "sync"
  local flags = bit.bor(uv.constants.O_RDONLY, uv.constants.O_NONBLOCK, uv.constants.O_DIRECTORY or 0)
  local fd = checked(uv.fs_open(path, flags, 0))
  descriptors[fd] = true
  local stat = checked(uv.fs_fstat(fd))
  if stat.type ~= "directory" then
    fail("conflict", "The host parent changed before its directory entry could be synced.")
  end
  checked(uv.fs_fsync(fd))
  close_descriptor(fd)
  current_stage = previous_stage
end

local function ensure_directory(path)
  current_stage = "filesystem"
  local stat, detail, code = uv.fs_stat(path)
  if stat then
    if stat.type ~= "directory" then fail("invalid-path", "The host parent is not a directory.") end
    return
  end
  if code ~= "ENOENT" then io_error("Cannot inspect the host directory", detail, code) end
  local parent = split_path(path)
  ensure_directory(parent)
  local created, create_detail, create_code = uv.fs_mkdir(path, 448)
  if not created and create_code ~= "EEXIST" then
    io_error("Cannot create the host directory", create_detail, create_code)
  end
  if not created then
    local current = checked(uv.fs_stat(path))
    if current.type ~= "directory" then fail("invalid-path", "The host parent is not a directory.") end
  else
    -- A new directory's entry belongs to its parent; syncing only the final
    -- file directory would not make a newly created ancestor chain durable.
    sync_directory(parent)
  end
end

local function write_document(path, input)
  current_stage = "validation"
  if type(input.text) ~= "string" then fail("io", "Host document text must be a string.") end
  if #input.text > max_bytes then fail("too-large", "The host YAML file exceeds 1 MiB.") end
  if not valid_utf8(input.text) then fail("io", "The host document is not valid UTF-8.") end
  local expected = input.expectedRevision
  if expected == nil then expected = vim.NIL end
  if expected ~= vim.NIL and type(expected) ~= "string" then fail("io", "Invalid host revision.") end
  current_stage = "filesystem"
  local original = read_document(path)
  check_baseline(original, expected, input.expectedResolvedPath)
  check_modified_buffers(original)
  if original.stat then check_writable(original.resolvedPath) end

  current_stage = "filesystem"
  local parent = split_path(original.resolvedPath)
  -- A read never creates directories. This is reached only by an explicit write.
  ensure_directory(parent)
  local fd, temp, temp_code = uv.fs_mkstemp(child_path(parent, ".codey-action-pad-XXXXXX"))
  if not fd then io_error("Cannot create the temporary host file", temp, temp_code) end
  descriptors[fd] = true
  temporary_path = temp
  local offset = 0
  while offset < #input.text do
    local written = checked(uv.fs_write(fd, input.text:sub(offset + 1), offset))
    if written == 0 then fail("io", "The host file write made no progress.") end
    offset = offset + written
  end

  -- Recheck after preparing the replacement, including symlink identity. External
  -- writers do not share a lock with Nvim, so existing-file comparison is best effort.
  current_stage = "filesystem"
  local current = read_document(path)
  check_baseline(current, expected, original.resolvedPath)
  check_modified_buffers(current)
  if current.stat then
    check_writable(current.resolvedPath)
    -- Preserve mode bits only. Ownership/group, ACLs and extended attributes
    -- remain those of the newly created replacement file.
    checked(uv.fs_fchmod(fd, bit.band(current.stat.mode, 4095)))
  end
  current_stage = "filesystem"
  checked(uv.fs_fsync(fd))
  close_descriptor(fd)

  current_stage = "publication"
  if expected == vim.NIL then
    -- link publishes the complete temporary file without ever replacing a file
    -- created after the baseline check. rename alone cannot provide create-only.
    local linked, detail, code = uv.fs_link(temporary_path, current.resolvedPath)
    if not linked and code == "EEXIST" then fail("conflict", "The host file already exists.") end
    checked(linked, detail, code)
    published = true
    checked(uv.fs_unlink(temporary_path))
  else
    checked(uv.fs_rename(temporary_path, current.resolvedPath))
    published = true
  end
  temporary_path = nil
  -- File fsync cannot persist the link/rename or removal of the temporary
  -- directory entry. Confirm those before acknowledging the completed save.
  sync_directory(parent)
  current_stage = "read-back"
  local saved = read_document(path)
  if saved.resolvedPath ~= current.resolvedPath or saved.text ~= input.text then
    fail("conflict", "The host file changed immediately after saving. Reload to verify its contents.")
  end
  return public_document(saved)
end

local ok, result = pcall(function()
  current_stage = "validation"
  if operation == "default-path" then
    return { path = absolute_path(vim.fn.stdpath("config") .. "/codey/action-pad.yaml") }
  end
  if type(request) ~= "table" then fail("io", "Invalid host document request.") end
  local path = absolute_path(request.path)
  if operation == "read" then return { document = public_document(read_document(path)) } end
  if operation == "write" then return { document = write_document(path, request) } end
  fail("io", "Unknown host document operation.")
end)
cleanup()
if ok then
  result.ok = true
  return result
end
if published then
  local detail = type(result) == "table" and result.message or tostring(result)
  return {
    ok = false, code = "io",
    stage = type(result) == "table" and result.stage or current_stage,
    message = "The host file was published, but the save could not be confirmed. "
      .. "Its result is uncertain; reload or reconcile before retrying. " .. tostring(detail),
  }
end
if type(result) == "table" and result.host_document_error then
  return { ok = false, code = result.code, message = result.message, stage = result.stage }
end
return {
  ok = false, code = "io", stage = current_stage,
  message = "Host document operation failed: " .. tostring(result),
}
`;

export async function defaultActionPadPath(rpc: DocumentRpc): Promise<string> {
  const result = await execute(rpc, "default-path", {});
  if (typeof result.path !== "string" || !result.path.startsWith("/")) {
    throw invalidResponse();
  }
  return result.path;
}

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
): Promise<HostDocument> {
  assertPath(request.path);
  if (request.expectedResolvedPath !== undefined) {
    assertPath(request.expectedResolvedPath);
  }
  if (typeof request.text !== "string") {
    throw new HostDocumentError("io", "Host document text must be a string.", "validation");
  }
  if (utf8ByteLength(request.text) > MAX_HOST_DOCUMENT_BYTES) {
    throw new HostDocumentError("too-large", "The host YAML file exceeds 1 MiB.", "validation");
  }
  if (request.expectedRevision !== null && typeof request.expectedRevision !== "string") {
    throw new HostDocumentError("io", "A host revision or explicit create-only null is required.", "validation");
  }
  return documentResult(await execute(rpc, "write", {
    path: request.path,
    text: request.text,
    expectedRevision: request.expectedRevision,
    ...(request.expectedResolvedPath !== undefined
      ? { expectedResolvedPath: request.expectedResolvedPath }
      : {}),
  }));
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
    throw new HostDocumentError(
      result.code,
      result.message,
      isErrorStage(result.stage) ? result.stage : undefined,
    );
  }
  if (result.ok !== true) throw invalidResponse();
  return result;
}

function documentResult(result: Record<string, unknown>): HostDocument {
  const value = result.document;
  if (
    !isRecord(value) ||
    typeof value.path !== "string" || !value.path.startsWith("/") ||
    typeof value.resolvedPath !== "string" || !value.resolvedPath.startsWith("/") ||
    !(value.text === null && value.revision === null ||
      typeof value.text === "string" && typeof value.revision === "string" &&
      /^[a-f0-9]{64}$/.test(value.revision))
  ) {
    throw invalidResponse();
  }
  if (typeof value.text === "string" && utf8ByteLength(value.text) > MAX_HOST_DOCUMENT_BYTES) {
    throw new HostDocumentError("too-large", "The host YAML file exceeds 1 MiB.", "filesystem");
  }
  return {
    path: value.path,
    resolvedPath: value.resolvedPath,
    text: value.text as string | null,
    revision: value.revision as string | null,
  };
}

function assertPath(path: string): void {
  if (
    typeof path !== "string" || !(path.startsWith("/") || path.startsWith("~/")) ||
    path.includes("\0") || path === "/" || path.endsWith("/")
  ) {
    throw new HostDocumentError(
      "invalid-path",
      "Enter an absolute host file path or a path starting with ~/.",
      "validation",
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
    ["conflict", "modified-buffer", "invalid-path", "not-found", "permission", "too-large", "io"]
      .includes(value);
}

function isErrorStage(value: unknown): value is HostDocumentErrorStage {
  return typeof value === "string" &&
    ["validation", "filesystem", "conflict", "permission", "publication", "sync", "read-back"]
      .includes(value);
}

function invalidResponse(): HostDocumentError {
  return new HostDocumentError("io", "The host returned an invalid document response.");
}
