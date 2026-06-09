// src/index.ts
import { Connector } from "@gety-ai/connector-sdk";

// src/codex_log.ts
import { del, upsert } from "@gety-ai/connector-sdk";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
function isIndexableCodexSession(session) {
  return session.userMessageCount > 0 && session.codexMessageCount > 0;
}
var SESSION_DOC_TYPE = "codex:session";
var MAX_CONTENT_CHARS = 9e5;
var READ_CHUNK_SIZE = 64 * 1024;
async function listCodexSessionFiles(options) {
  const root = resolveCodexHome();
  const roots = [
    { path: join(root, "sessions"), stateKey: "sessions" }
  ];
  if (options.includeArchivedSessions) {
    roots.push({
      path: join(root, "archived_sessions"),
      stateKey: "archived_sessions"
    });
  }
  const files = [];
  for (const sessionRoot of roots) {
    files.push(...await listJsonlFiles(sessionRoot.path, sessionRoot.stateKey));
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  return files;
}
function resolveCodexHome(env = Deno.env.toObject(), os = Deno.build.os) {
  const explicit = env.CODEX_HOME?.trim();
  if (explicit) {
    return explicit;
  }
  if (os === "windows") {
    const profile = env.USERPROFILE?.trim();
    if (profile) {
      return join(profile, ".codex");
    }
    const homeDrive = env.HOMEDRIVE?.trim();
    const homePath = env.HOMEPATH?.trim();
    if (homeDrive && homePath) {
      return join(`${homeDrive}${homePath}`, ".codex");
    }
  }
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (home) {
    return join(home, ".codex");
  }
  return ".codex";
}
async function parseCodexSessionFile(file, options) {
  const accumulator = emptyAccumulator();
  for await (const line of readJsonlLines(file.path)) {
    const event = parseRelevantLine(line, options);
    if (event != null) {
      applyEvent(accumulator, event, options);
    }
  }
  return sessionFromAccumulator(accumulator, file);
}
function emptyAccumulator() {
  return {
    workspaceRoots: [],
    messageCount: 0,
    userMessageCount: 0,
    codexMessageCount: 0,
    toolCallCount: 0,
    rounds: [],
    currentRound: null
  };
}
function sessionFromAccumulator(accumulator, file) {
  finishCurrentRound(accumulator);
  const id = accumulator.id ?? sessionIdFromPath(file.path);
  const title = titleForSession(accumulator, file.path);
  const updatedAt = new Date(file.mtimeMs).toISOString();
  const contentResult = renderSessionContent(title, accumulator.rounds, {
    cwd: accumulator.cwd,
    workspaceRoots: accumulator.workspaceRoots,
    model: accumulator.model
  });
  return {
    id,
    title,
    sourcePath: file.path,
    sourceSize: file.size,
    url: pathToFileURL(file.path).href,
    startedAt: accumulator.startedAt,
    updatedAt,
    cwd: accumulator.cwd,
    workspaceRoots: accumulator.workspaceRoots,
    model: accumulator.model,
    modelProvider: accumulator.modelProvider,
    cliVersion: accumulator.cliVersion,
    source: accumulator.source,
    messageCount: accumulator.messageCount,
    userMessageCount: accumulator.userMessageCount,
    codexMessageCount: accumulator.codexMessageCount,
    toolCallCount: accumulator.toolCallCount,
    contentTruncated: contentResult.truncated,
    content: contentResult.content
  };
}
function buildCodexSessionUpdate(session) {
  return upsert({
    id: codexSessionDocId(session.id),
    title: session.title,
    content: session.content,
    content_format: "markdown",
    doc_updated_at: session.updatedAt,
    doc_type: SESSION_DOC_TYPE,
    original_file_size: session.sourceSize,
    metadata: {
      url: session.url,
      source: "codex",
      source_path: session.sourcePath,
      session_id: session.id,
      cwd: session.cwd,
      workspace_roots: session.workspaceRoots,
      model: session.model,
      model_provider: session.modelProvider,
      created_at: session.startedAt,
      cli_version: session.cliVersion,
      message_count: session.messageCount,
      user_message_count: session.userMessageCount,
      codex_message_count: session.codexMessageCount,
      tool_call_count: session.toolCallCount,
      content_truncated: session.contentTruncated
    }
  });
}
function buildCodexSessionDelete(session) {
  return del(codexSessionDocId(session.id));
}
function codexSessionDocId(sessionId) {
  return `codex:session:${sessionId}`;
}
async function listJsonlFiles(root, stateKey) {
  const files = [];
  try {
    for await (const entry of Deno.readDir(root)) {
      const path = join(root, entry.name);
      const childStateKey = `${stateKey}/${entry.name}`;
      if (entry.isDirectory) {
        files.push(...await listJsonlFiles(path, childStateKey));
        continue;
      }
      if (!entry.isFile || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      const stat = await Deno.stat(path);
      files.push({
        path,
        stateKey: childStateKey,
        mtimeMs: stat.mtime?.getTime() ?? 0,
        size: stat.size
      });
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return files;
    }
    throw error;
  }
  return files;
}
async function* readJsonlLines(path) {
  const file = await Deno.open(path, { read: true });
  const decoder = new TextDecoder();
  const chunk = new Uint8Array(READ_CHUNK_SIZE);
  let buffer = "";
  try {
    while (true) {
      const bytesRead = await file.read(chunk);
      if (bytesRead == null) {
        break;
      }
      buffer += decoder.decode(chunk.subarray(0, bytesRead), {
        stream: true
      });
      let lineEnd = buffer.indexOf("\n");
      while (lineEnd >= 0) {
        yield trimLineEnding(buffer.slice(0, lineEnd));
        buffer = buffer.slice(lineEnd + 1);
        lineEnd = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== "") {
      yield trimLineEnding(buffer);
    }
  } finally {
    file.close();
  }
}
function parseRelevantLine(line, options) {
  if (!shouldParseLine(line, options)) {
    return null;
  }
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
function shouldParseLine(line, options) {
  if (line.includes('"type":"session_meta"') || line.includes('"type":"turn_context"') || line.includes('"type":"message"')) {
    return true;
  }
  if (!options.includeToolCalls) {
    return false;
  }
  return line.includes('"type":"function_call"') || line.includes('"type":"custom_tool_call"') || line.includes('"name":"apply_patch"');
}
function applyEvent(accumulator, event, options) {
  if (event.type === "session_meta") {
    applySessionMeta(accumulator, event);
    return;
  }
  if (event.type === "turn_context") {
    applyTurnContext(accumulator, event);
    return;
  }
  if (event.type !== "response_item") {
    return;
  }
  const item = responseItem(event);
  if (item?.type === "message") {
    applyMessage(accumulator, item);
    return;
  }
  if (options.includeToolCalls && (item?.type === "function_call" || item?.type === "custom_tool_call")) {
    applyToolCall(accumulator, item);
  }
}
function applySessionMeta(accumulator, event) {
  const payload = event.payload;
  if (payload == null) {
    return;
  }
  accumulator.id = stringValue(payload.id) ?? accumulator.id;
  accumulator.startedAt = stringValue(payload.timestamp) ?? stringValue(event.timestamp) ?? accumulator.startedAt;
  accumulator.cwd = stringValue(payload.cwd) ?? accumulator.cwd;
  accumulator.cliVersion = stringValue(payload.cli_version) ?? accumulator.cliVersion;
  accumulator.source = stringValue(payload.source) ?? accumulator.source;
  accumulator.modelProvider = stringValue(payload.model_provider) ?? accumulator.modelProvider;
}
function applyTurnContext(accumulator, event) {
  const payload = event.payload;
  if (payload == null) {
    return;
  }
  accumulator.cwd = stringValue(payload.cwd) ?? accumulator.cwd;
  accumulator.workspaceRoots = stringArrayValue(payload.workspace_roots) ?? accumulator.workspaceRoots;
  accumulator.model = stringValue(payload.model) ?? accumulator.model;
  const summary = cleanSummary(stringValue(payload.summary));
  if (accumulator.summary == null && summary != null) {
    accumulator.summary = summary;
  }
}
function applyMessage(accumulator, item) {
  const role = item.role;
  const text = extractMessageText(item.content);
  if (text == null) {
    return;
  }
  if (role === "user") {
    if (isInjectedUserContext(text)) {
      return;
    }
    finishCurrentRound(accumulator);
    accumulator.currentRound = emptyRound();
    accumulator.currentRound.userMessages.push(text);
    accumulator.firstPrompt ??= text;
    accumulator.messageCount += 1;
    accumulator.userMessageCount += 1;
    return;
  }
  if (role === "assistant" && isFinalCodexMessage(item)) {
    const round = ensureRound(accumulator);
    round.codexMessages.push(text);
    accumulator.messageCount += 1;
    accumulator.codexMessageCount += 1;
  }
}
function applyToolCall(accumulator, item) {
  const summary = summarizeToolCall(item);
  if (summary == null) {
    return;
  }
  ensureRound(accumulator).toolCalls.push(summary);
  accumulator.toolCallCount += 1;
}
function responseItem(event) {
  const payload = event.payload;
  if (payload == null) {
    return null;
  }
  const nested = payload.item;
  return isRecord(nested) ? nested : payload;
}
function isFinalCodexMessage(item) {
  return item.phase == null || item.phase === "" || item.phase === "final_answer";
}
function ensureRound(accumulator) {
  if (accumulator.currentRound == null) {
    accumulator.currentRound = emptyRound();
  }
  return accumulator.currentRound;
}
function finishCurrentRound(accumulator) {
  const round = accumulator.currentRound;
  if (round == null) {
    return;
  }
  if (round.userMessages.length > 0 || round.codexMessages.length > 0 || round.toolCalls.length > 0) {
    accumulator.rounds.push(round);
  }
  accumulator.currentRound = null;
}
function emptyRound() {
  return {
    userMessages: [],
    codexMessages: [],
    toolCalls: []
  };
}
function extractMessageText(content) {
  if (typeof content === "string") {
    return cleanMessageText(content);
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts = [];
  for (const item of content) {
    if (!isRecord(item)) {
      continue;
    }
    const text = stringValue(item.text) ?? stringValue(item.input_text) ?? stringValue(item.output_text);
    if (text != null) {
      parts.push(text);
    }
  }
  return cleanMessageText(parts.join("\n\n"));
}
function cleanMessageText(text) {
  const cleaned = text.replace(/\r\n/g, "\n").trim();
  return cleaned === "" ? null : cleaned;
}
function summarizeToolCall(item) {
  const name = item.name?.trim();
  if (!name) {
    return null;
  }
  const input = item.arguments ?? item.input;
  if (name === "exec_command") {
    const args = parseJsonObject(input);
    const cmd = stringValue(args?.cmd);
    return cmd == null ? name : `${name}: ${oneLine(cmd)}`;
  }
  if (name === "apply_patch") {
    const patch = typeof input === "string" ? input : "";
    const files = [
      ...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)
    ].map((match) => match[1].trim()).slice(0, 3);
    return files.length === 0 ? name : `${name}: ${files.join(", ")}`;
  }
  return name;
}
function parseJsonObject(value) {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function renderSessionContent(title, rounds, meta) {
  const lines = [`# ${title}`];
  const sessionLines = renderSessionMeta(meta);
  if (sessionLines.length > 0) {
    lines.push("", "## Session", "", ...sessionLines);
  }
  for (const [index, round] of rounds.entries()) {
    if (index > 0 || lines.length > 1) {
      lines.push("", "---", "");
    }
    if (round.userMessages.length > 0) {
      lines.push("## User", "", round.userMessages.join("\n\n"));
    }
    if (round.codexMessages.length > 0) {
      if (round.userMessages.length > 0) {
        lines.push("");
      }
      lines.push("## Codex", "", round.codexMessages.join("\n\n"));
    }
    if (round.toolCalls.length > 0) {
      if (round.userMessages.length > 0 || round.codexMessages.length > 0) {
        lines.push("");
      }
      lines.push(
        "## Tool Calls",
        "",
        ...round.toolCalls.map((toolCall) => `- ${toolCall}`)
      );
    }
  }
  const content = lines.join("\n");
  if (content.length <= MAX_CONTENT_CHARS) {
    return { content, truncated: false };
  }
  return {
    content: content.slice(0, MAX_CONTENT_CHARS).trimEnd(),
    truncated: true
  };
}
function renderSessionMeta(meta) {
  const lines = [];
  if (meta.workspaceRoots.length === 1) {
    lines.push(`- Workspace: \`${meta.workspaceRoots[0]}\``);
  } else if (meta.workspaceRoots.length > 1) {
    lines.push(
      "- Workspace:",
      ...meta.workspaceRoots.map((root) => `  - \`${root}\``)
    );
  } else if (meta.cwd != null) {
    lines.push(`- Directory: \`${meta.cwd}\``);
  }
  if (meta.model != null) {
    lines.push(`- Model: \`${meta.model}\``);
  }
  return lines;
}
function titleForSession(accumulator, path) {
  return accumulator.summary ?? firstPromptTitle(accumulator.firstPrompt) ?? basename(path, ".jsonl");
}
function firstPromptTitle(prompt) {
  if (prompt == null) {
    return null;
  }
  const firstParagraph = prompt.split(/\n\s*\n/)[0]?.trim();
  if (!firstParagraph) {
    return null;
  }
  return oneLine(firstParagraph).slice(0, 120);
}
function cleanSummary(summary) {
  const cleaned = summary?.trim();
  if (!cleaned) {
    return null;
  }
  const normalized = cleaned.toLowerCase();
  if (normalized === "null" || normalized === "none" || normalized === "n/a" || normalized === "auto") {
    return null;
  }
  return oneLine(cleaned);
}
function isInjectedUserContext(text) {
  return text.startsWith("# AGENTS.md instructions for ") || text.startsWith("<environment_context>") || text.startsWith("<user_instructions>") || text.startsWith("<INSTRUCTIONS>");
}
function sessionIdFromPath(path) {
  const filename = basename(path, ".jsonl");
  const match = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(filename);
  return match?.[0] ?? filename;
}
function oneLine(value) {
  return value.replace(/\s+/g, " ").trim();
}
function stringValue(value) {
  return typeof value === "string" ? value : void 0;
}
function stringArrayValue(value) {
  if (!Array.isArray(value)) {
    return void 0;
  }
  const strings = value.filter(
    (item) => typeof item === "string" && item.trim() !== ""
  );
  return strings.length > 0 ? [...new Set(strings)] : void 0;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function trimLineEnding(line) {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

// src/index.ts
var STATE_SCHEMA_VERSION = 3;
var CodexConnector = class extends Connector {
  async *poll() {
    const includeToolCalls = this.config.include_tool_calls ?? false;
    const includeArchivedSessions = this.config.include_archived_sessions ?? true;
    const state = initialState(
      this.lastState,
      includeToolCalls,
      includeArchivedSessions
    );
    const previousFiles = state.files ?? {};
    const previousIndexed = new Set(
      state.indexed_sessions ?? indexedSessionIds(previousFiles)
    );
    const currentFiles = {};
    const currentIndexed = /* @__PURE__ */ new Set();
    const files = await listCodexSessionFiles({ includeArchivedSessions });
    for (const file of files) {
      this.signal.throwIfAborted();
      const previousFile = previousFiles[file.stateKey];
      if (!fileNeedsParse(file, previousFile)) {
        currentFiles[file.stateKey] = previousFile;
        if (previousFile.indexed && previousFile.session_id != null) {
          currentIndexed.add(previousFile.session_id);
        }
        continue;
      }
      const session = await parseCodexSessionFile(file, { includeToolCalls });
      if (isIndexableCodexSession(session)) {
        currentFiles[file.stateKey] = {
          session_id: session.id,
          mtime_ms: file.mtimeMs,
          size: file.size,
          indexed: true
        };
        currentIndexed.add(session.id);
        yield { updates: [buildCodexSessionUpdate(session)] };
        continue;
      }
      currentFiles[file.stateKey] = {
        mtime_ms: file.mtimeMs,
        size: file.size,
        indexed: false
      };
    }
    for (const sessionId of previousIndexed) {
      if (!currentIndexed.has(sessionId)) {
        yield { updates: [buildCodexSessionDelete({ id: sessionId })] };
      }
    }
    yield {
      updates: [],
      state: nextStateAfterReconcile(
        currentFiles,
        includeToolCalls,
        includeArchivedSessions
      )
    };
  }
};
function initialState(state, includeToolCalls, includeArchivedSessions) {
  if (state?.schema_version !== STATE_SCHEMA_VERSION || state.include_tool_calls !== includeToolCalls || state.include_archived_sessions !== includeArchivedSessions) {
    return nextBaseState(
      {
        indexed_sessions: state?.indexed_sessions ?? indexedSessionIds(state?.files ?? {})
      },
      includeToolCalls,
      includeArchivedSessions
    );
  }
  return state;
}
function fileNeedsParse(file, previousFile) {
  return previousFile == null || previousFile.mtime_ms !== file.mtimeMs || previousFile.size !== file.size;
}
function nextStateAfterReconcile(files, includeToolCalls, includeArchivedSessions) {
  return nextBaseState(
    {
      files: sortFileState(files),
      indexed_sessions: indexedSessionIds(files)
    },
    includeToolCalls,
    includeArchivedSessions
  );
}
function nextBaseState(state, includeToolCalls, includeArchivedSessions) {
  return {
    ...state,
    schema_version: STATE_SCHEMA_VERSION,
    include_tool_calls: includeToolCalls,
    include_archived_sessions: includeArchivedSessions,
    files: state.files ?? {},
    indexed_sessions: [...new Set(state.indexed_sessions ?? [])].sort()
  };
}
function indexedSessionIds(files) {
  const ids = [];
  for (const file of Object.values(files)) {
    if (file.indexed && file.session_id != null) {
      ids.push(file.session_id);
    }
  }
  return [...new Set(ids)].sort();
}
function sortFileState(files) {
  return Object.fromEntries(
    Object.entries(files).sort(([left], [right]) => left.localeCompare(right))
  );
}
export {
  CodexConnector as default,
  fileNeedsParse,
  initialState,
  nextStateAfterReconcile
};
//# sourceMappingURL=main.js.map
