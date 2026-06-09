import { del, type DocUpdate, upsert } from '@gety-ai/connector-sdk';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface CodexSessionFile {
	path: string;
	stateKey: string;
	mtimeMs: number;
	size: number;
}

export interface ListCodexSessionFilesOptions {
	includeArchivedSessions: boolean;
}

export interface ParseCodexSessionOptions {
	includeToolCalls: boolean;
}

export interface CodexSession {
	id: string;
	title: string;
	sourcePath: string;
	sourceSize: number;
	url: string;
	startedAt?: string;
	updatedAt: string;
	cwd?: string;
	workspaceRoots: string[];
	model?: string;
	modelProvider?: string;
	cliVersion?: string;
	source?: string;
	messageCount: number;
	userMessageCount: number;
	codexMessageCount: number;
	toolCallCount: number;
	contentTruncated: boolean;
	content: string;
}

export function isIndexableCodexSession(session: CodexSession): boolean {
	return session.userMessageCount > 0 && session.codexMessageCount > 0;
}

interface LogEvent {
	timestamp?: string;
	type?: string;
	payload?: Record<string, unknown>;
}

interface MessageItem {
	type?: string;
	role?: string;
	phase?: string;
	content?: unknown;
}

interface ToolCallItem {
	type?: string;
	name?: string;
	arguments?: unknown;
	input?: unknown;
}

interface ConversationRound {
	userMessages: string[];
	codexMessages: string[];
	toolCalls: string[];
}

interface SessionContentMeta {
	cwd?: string;
	workspaceRoots: readonly string[];
	model?: string;
}

interface ParseAccumulator {
	id?: string;
	summary?: string;
	firstPrompt?: string;
	startedAt?: string;
	cwd?: string;
	workspaceRoots: string[];
	model?: string;
	modelProvider?: string;
	cliVersion?: string;
	source?: string;
	messageCount: number;
	userMessageCount: number;
	codexMessageCount: number;
	toolCallCount: number;
	rounds: ConversationRound[];
	currentRound: ConversationRound | null;
}

const SESSION_DOC_TYPE = 'codex:session';
const MAX_CONTENT_CHARS = 900_000;
const READ_CHUNK_SIZE = 64 * 1024;

export async function listCodexSessionFiles(
	options: ListCodexSessionFilesOptions,
): Promise<CodexSessionFile[]> {
	const root = resolveCodexHome();
	const roots = [
		{ path: join(root, 'sessions'), stateKey: 'sessions' },
	];
	if (options.includeArchivedSessions) {
		roots.push({
			path: join(root, 'archived_sessions'),
			stateKey: 'archived_sessions',
		});
	}

	const files: CodexSessionFile[] = [];
	for (const sessionRoot of roots) {
		files.push(...await listJsonlFiles(sessionRoot.path, sessionRoot.stateKey));
	}

	files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
	return files;
}

export function resolveCodexHome(
	env: Record<string, string | undefined> = Deno.env.toObject(),
	os: typeof Deno.build.os = Deno.build.os,
): string {
	const explicit = env.CODEX_HOME?.trim();
	if (explicit) {
		return explicit;
	}

	if (os === 'windows') {
		const profile = env.USERPROFILE?.trim();
		if (profile) {
			return join(profile, '.codex');
		}

		const homeDrive = env.HOMEDRIVE?.trim();
		const homePath = env.HOMEPATH?.trim();
		if (homeDrive && homePath) {
			return join(`${homeDrive}${homePath}`, '.codex');
		}
	}

	const home = env.HOME?.trim() || env.USERPROFILE?.trim();
	if (home) {
		return join(home, '.codex');
	}

	return '.codex';
}

export async function parseCodexSessionFile(
	file: CodexSessionFile,
	options: ParseCodexSessionOptions,
): Promise<CodexSession> {
	const accumulator = emptyAccumulator();
	for await (const line of readJsonlLines(file.path)) {
		const event = parseRelevantLine(line, options);
		if (event != null) {
			applyEvent(accumulator, event, options);
		}
	}
	return sessionFromAccumulator(accumulator, file);
}

export function parseCodexSessionLines(
	lines: readonly string[],
	file: CodexSessionFile,
	options: ParseCodexSessionOptions,
): CodexSession {
	const accumulator = emptyAccumulator();
	for (const line of lines) {
		const event = parseRelevantLine(line, options);
		if (event == null) {
			continue;
		}
		applyEvent(accumulator, event, options);
	}

	return sessionFromAccumulator(accumulator, file);
}

function emptyAccumulator(): ParseAccumulator {
	return {
		workspaceRoots: [],
		messageCount: 0,
		userMessageCount: 0,
		codexMessageCount: 0,
		toolCallCount: 0,
		rounds: [],
		currentRound: null,
	};
}

function sessionFromAccumulator(
	accumulator: ParseAccumulator,
	file: CodexSessionFile,
): CodexSession {
	finishCurrentRound(accumulator);

	const id = accumulator.id ?? sessionIdFromPath(file.path);
	const title = titleForSession(accumulator, file.path);
	const updatedAt = new Date(file.mtimeMs).toISOString();
	const contentResult = renderSessionContent(title, accumulator.rounds, {
		cwd: accumulator.cwd,
		workspaceRoots: accumulator.workspaceRoots,
		model: accumulator.model,
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
		content: contentResult.content,
	};
}

export function buildCodexSessionUpdate(session: CodexSession): DocUpdate {
	return upsert({
		id: codexSessionDocId(session.id),
		title: session.title,
		content: session.content,
		content_format: 'markdown',
		doc_updated_at: session.updatedAt,
		doc_type: SESSION_DOC_TYPE,
		original_file_size: session.sourceSize,
		metadata: {
			url: session.url,
			source: 'codex',
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
			content_truncated: session.contentTruncated,
		},
	});
}

export function buildCodexSessionDelete(
	session: Pick<CodexSession, 'id'>,
): DocUpdate {
	return del(codexSessionDocId(session.id));
}

function codexSessionDocId(sessionId: string): string {
	return `codex:session:${sessionId}`;
}

async function listJsonlFiles(
	root: string,
	stateKey: string,
): Promise<CodexSessionFile[]> {
	const files: CodexSessionFile[] = [];

	try {
		for await (const entry of Deno.readDir(root)) {
			const path = join(root, entry.name);
			const childStateKey = `${stateKey}/${entry.name}`;
			if (entry.isDirectory) {
				files.push(...await listJsonlFiles(path, childStateKey));
				continue;
			}
			if (!entry.isFile || !entry.name.endsWith('.jsonl')) {
				continue;
			}

			const stat = await Deno.stat(path);
			files.push({
				path,
				stateKey: childStateKey,
				mtimeMs: stat.mtime?.getTime() ?? 0,
				size: stat.size,
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

async function* readJsonlLines(path: string): AsyncGenerator<string> {
	const file = await Deno.open(path, { read: true });
	const decoder = new TextDecoder();
	const chunk = new Uint8Array(READ_CHUNK_SIZE);
	let buffer = '';

	try {
		while (true) {
			const bytesRead = await file.read(chunk);
			if (bytesRead == null) {
				break;
			}

			buffer += decoder.decode(chunk.subarray(0, bytesRead), {
				stream: true,
			});
			let lineEnd = buffer.indexOf('\n');
			while (lineEnd >= 0) {
				yield trimLineEnding(buffer.slice(0, lineEnd));
				buffer = buffer.slice(lineEnd + 1);
				lineEnd = buffer.indexOf('\n');
			}
		}

		buffer += decoder.decode();
		if (buffer.trim() !== '') {
			yield trimLineEnding(buffer);
		}
	} finally {
		file.close();
	}
}

function parseRelevantLine(
	line: string,
	options: ParseCodexSessionOptions,
): LogEvent | null {
	if (!shouldParseLine(line, options)) {
		return null;
	}

	try {
		return JSON.parse(line) as LogEvent;
	} catch {
		return null;
	}
}

function shouldParseLine(
	line: string,
	options: ParseCodexSessionOptions,
): boolean {
	if (
		line.includes('"type":"session_meta"') ||
		line.includes('"type":"turn_context"') ||
		line.includes('"type":"message"')
	) {
		return true;
	}

	if (!options.includeToolCalls) {
		return false;
	}

	return line.includes('"type":"function_call"') ||
		line.includes('"type":"custom_tool_call"') ||
		line.includes('"name":"apply_patch"');
}

function applyEvent(
	accumulator: ParseAccumulator,
	event: LogEvent,
	options: ParseCodexSessionOptions,
): void {
	if (event.type === 'session_meta') {
		applySessionMeta(accumulator, event);
		return;
	}

	if (event.type === 'turn_context') {
		applyTurnContext(accumulator, event);
		return;
	}

	if (event.type !== 'response_item') {
		return;
	}

	const item = responseItem(event);
	if (item?.type === 'message') {
		applyMessage(accumulator, item as MessageItem);
		return;
	}

	if (
		options.includeToolCalls &&
		(item?.type === 'function_call' || item?.type === 'custom_tool_call')
	) {
		applyToolCall(accumulator, item as ToolCallItem);
	}
}

function applySessionMeta(
	accumulator: ParseAccumulator,
	event: LogEvent,
): void {
	const payload = event.payload;
	if (payload == null) {
		return;
	}

	accumulator.id = stringValue(payload.id) ?? accumulator.id;
	accumulator.startedAt = stringValue(payload.timestamp) ??
		stringValue(event.timestamp) ??
		accumulator.startedAt;
	accumulator.cwd = stringValue(payload.cwd) ?? accumulator.cwd;
	accumulator.cliVersion = stringValue(payload.cli_version) ??
		accumulator.cliVersion;
	accumulator.source = stringValue(payload.source) ?? accumulator.source;
	accumulator.modelProvider = stringValue(payload.model_provider) ??
		accumulator.modelProvider;
}

function applyTurnContext(
	accumulator: ParseAccumulator,
	event: LogEvent,
): void {
	const payload = event.payload;
	if (payload == null) {
		return;
	}

	accumulator.cwd = stringValue(payload.cwd) ?? accumulator.cwd;
	accumulator.workspaceRoots = stringArrayValue(payload.workspace_roots) ??
		accumulator.workspaceRoots;
	accumulator.model = stringValue(payload.model) ?? accumulator.model;
	const summary = cleanSummary(stringValue(payload.summary));
	if (accumulator.summary == null && summary != null) {
		accumulator.summary = summary;
	}
}

function applyMessage(
	accumulator: ParseAccumulator,
	item: MessageItem,
): void {
	const role = item.role;
	const text = extractMessageText(item.content);
	if (text == null) {
		return;
	}

	if (role === 'user') {
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

	if (role === 'assistant' && isFinalCodexMessage(item)) {
		const round = ensureRound(accumulator);
		round.codexMessages.push(text);
		accumulator.messageCount += 1;
		accumulator.codexMessageCount += 1;
	}
}

function applyToolCall(
	accumulator: ParseAccumulator,
	item: ToolCallItem,
): void {
	const summary = summarizeToolCall(item);
	if (summary == null) {
		return;
	}

	ensureRound(accumulator).toolCalls.push(summary);
	accumulator.toolCallCount += 1;
}

function responseItem(event: LogEvent): Record<string, unknown> | null {
	const payload = event.payload;
	if (payload == null) {
		return null;
	}

	const nested = payload.item;
	return isRecord(nested) ? nested : payload;
}

function isFinalCodexMessage(item: MessageItem): boolean {
	return item.phase == null || item.phase === '' ||
		item.phase === 'final_answer';
}

function ensureRound(accumulator: ParseAccumulator): ConversationRound {
	if (accumulator.currentRound == null) {
		accumulator.currentRound = emptyRound();
	}
	return accumulator.currentRound;
}

function finishCurrentRound(accumulator: ParseAccumulator): void {
	const round = accumulator.currentRound;
	if (round == null) {
		return;
	}

	if (
		round.userMessages.length > 0 ||
		round.codexMessages.length > 0 ||
		round.toolCalls.length > 0
	) {
		accumulator.rounds.push(round);
	}
	accumulator.currentRound = null;
}

function emptyRound(): ConversationRound {
	return {
		userMessages: [],
		codexMessages: [],
		toolCalls: [],
	};
}

function extractMessageText(content: unknown): string | null {
	if (typeof content === 'string') {
		return cleanMessageText(content);
	}
	if (!Array.isArray(content)) {
		return null;
	}

	const parts: string[] = [];
	for (const item of content) {
		if (!isRecord(item)) {
			continue;
		}

		const text = stringValue(item.text) ??
			stringValue(item.input_text) ??
			stringValue(item.output_text);
		if (text != null) {
			parts.push(text);
		}
	}

	return cleanMessageText(parts.join('\n\n'));
}

function cleanMessageText(text: string): string | null {
	const cleaned = text.replace(/\r\n/g, '\n').trim();
	return cleaned === '' ? null : cleaned;
}

function summarizeToolCall(item: ToolCallItem): string | null {
	const name = item.name?.trim();
	if (!name) {
		return null;
	}

	const input = item.arguments ?? item.input;
	if (name === 'exec_command') {
		const args = parseJsonObject(input);
		const cmd = stringValue(args?.cmd);
		return cmd == null ? name : `${name}: ${oneLine(cmd)}`;
	}

	if (name === 'apply_patch') {
		const patch = typeof input === 'string' ? input : '';
		const files = [
			...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm),
		]
			.map((match) => match[1].trim())
			.slice(0, 3);
		return files.length === 0 ? name : `${name}: ${files.join(', ')}`;
	}

	return name;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
	if (isRecord(value)) {
		return value;
	}
	if (typeof value !== 'string') {
		return null;
	}

	try {
		const parsed = JSON.parse(value);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function renderSessionContent(
	title: string,
	rounds: readonly ConversationRound[],
	meta: SessionContentMeta,
): { content: string; truncated: boolean } {
	const lines = [`# ${title}`];
	const sessionLines = renderSessionMeta(meta);
	if (sessionLines.length > 0) {
		lines.push('', '## Session', '', ...sessionLines);
	}

	for (const [index, round] of rounds.entries()) {
		if (index > 0 || lines.length > 1) {
			lines.push('', '---', '');
		}

		if (round.userMessages.length > 0) {
			lines.push('## User', '', round.userMessages.join('\n\n'));
		}

		if (round.codexMessages.length > 0) {
			if (round.userMessages.length > 0) {
				lines.push('');
			}
			lines.push('## Codex', '', round.codexMessages.join('\n\n'));
		}

		if (round.toolCalls.length > 0) {
			if (
				round.userMessages.length > 0 ||
				round.codexMessages.length > 0
			) {
				lines.push('');
			}
			lines.push(
				'## Tool Calls',
				'',
				...round.toolCalls.map((toolCall) => `- ${toolCall}`),
			);
		}
	}

	const content = lines.join('\n');
	if (content.length <= MAX_CONTENT_CHARS) {
		return { content, truncated: false };
	}

	return {
		content: content.slice(0, MAX_CONTENT_CHARS).trimEnd(),
		truncated: true,
	};
}

function renderSessionMeta(meta: SessionContentMeta): string[] {
	const lines: string[] = [];

	if (meta.workspaceRoots.length === 1) {
		lines.push(`- Workspace: \`${meta.workspaceRoots[0]}\``);
	} else if (meta.workspaceRoots.length > 1) {
		lines.push(
			'- Workspace:',
			...meta.workspaceRoots.map((root) => `  - \`${root}\``),
		);
	} else if (meta.cwd != null) {
		lines.push(`- Directory: \`${meta.cwd}\``);
	}

	if (meta.model != null) {
		lines.push(`- Model: \`${meta.model}\``);
	}

	return lines;
}

function titleForSession(
	accumulator: ParseAccumulator,
	path: string,
): string {
	return accumulator.summary ??
		firstPromptTitle(accumulator.firstPrompt) ??
		basename(path, '.jsonl');
}

function firstPromptTitle(prompt: string | undefined): string | null {
	if (prompt == null) {
		return null;
	}

	const firstParagraph = prompt.split(/\n\s*\n/)[0]?.trim();
	if (!firstParagraph) {
		return null;
	}

	return oneLine(firstParagraph).slice(0, 120);
}

function cleanSummary(summary: string | undefined): string | null {
	const cleaned = summary?.trim();
	if (!cleaned) {
		return null;
	}

	const normalized = cleaned.toLowerCase();
	if (
		normalized === 'null' || normalized === 'none' || normalized === 'n/a' ||
		normalized === 'auto'
	) {
		return null;
	}
	return oneLine(cleaned);
}

function isInjectedUserContext(text: string): boolean {
	return text.startsWith('# AGENTS.md instructions for ') ||
		text.startsWith('<environment_context>') ||
		text.startsWith('<user_instructions>') ||
		text.startsWith('<INSTRUCTIONS>');
}

function sessionIdFromPath(path: string): string {
	const filename = basename(path, '.jsonl');
	const match = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
		.exec(filename);
	return match?.[0] ?? filename;
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}

	const strings = value.filter((item): item is string =>
		typeof item === 'string' && item.trim() !== ''
	);
	return strings.length > 0 ? [...new Set(strings)] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimLineEnding(line: string): string {
	return line.endsWith('\r') ? line.slice(0, -1) : line;
}
