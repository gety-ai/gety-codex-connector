import { Connector, type PollResult } from '@gety-ai/connector-sdk';
import type { ManifestConfig } from './gen/manifest.d.ts';
import {
	buildCodexSessionDelete,
	buildCodexSessionUpdate,
	type CodexSessionFile,
	isIndexableCodexSession,
	listCodexSessionFiles,
	parseCodexSessionFile,
} from './codex_log.ts';

export interface CodexFileState {
	session_id?: string;
	mtime_ms: number;
	size: number;
	indexed: boolean;
}

export interface CodexState {
	schema_version?: number;
	include_tool_calls?: boolean;
	include_archived_sessions?: boolean;
	files?: Record<string, CodexFileState>;
	indexed_sessions?: string[];
}

const STATE_SCHEMA_VERSION = 3;

export default class CodexConnector extends Connector<
	ManifestConfig,
	CodexState
> {
	async *poll(): AsyncGenerator<PollResult, void, unknown> {
		const includeToolCalls = this.config.include_tool_calls ?? false;
		const includeArchivedSessions = this.config.include_archived_sessions ??
			true;
		const state = initialState(
			this.lastState,
			includeToolCalls,
			includeArchivedSessions,
		);
		const previousFiles = state.files ?? {};
		const previousIndexed = new Set(
			state.indexed_sessions ?? indexedSessionIds(previousFiles),
		);
		const currentFiles: Record<string, CodexFileState> = {};
		const currentIndexed = new Set<string>();
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
					indexed: true,
				};
				currentIndexed.add(session.id);
				yield { updates: [buildCodexSessionUpdate(session)] };
				continue;
			}

			currentFiles[file.stateKey] = {
				mtime_ms: file.mtimeMs,
				size: file.size,
				indexed: false,
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
				includeArchivedSessions,
			),
		};
	}
}

export function initialState(
	state: CodexState | null | undefined,
	includeToolCalls: boolean,
	includeArchivedSessions: boolean,
): CodexState {
	if (
		state?.schema_version !== STATE_SCHEMA_VERSION ||
		state.include_tool_calls !== includeToolCalls ||
		state.include_archived_sessions !== includeArchivedSessions
	) {
		return nextBaseState(
			{
				indexed_sessions: state?.indexed_sessions ??
					indexedSessionIds(state?.files ?? {}),
			},
			includeToolCalls,
			includeArchivedSessions,
		);
	}
	return state;
}

export function fileNeedsParse(
	file: CodexSessionFile,
	previousFile: CodexFileState | undefined,
): boolean {
	return previousFile == null ||
		previousFile.mtime_ms !== file.mtimeMs ||
		previousFile.size !== file.size;
}

export function nextStateAfterReconcile(
	files: Record<string, CodexFileState>,
	includeToolCalls: boolean,
	includeArchivedSessions: boolean,
): CodexState {
	return nextBaseState(
		{
			files: sortFileState(files),
			indexed_sessions: indexedSessionIds(files),
		},
		includeToolCalls,
		includeArchivedSessions,
	);
}

function nextBaseState(
	state: CodexState,
	includeToolCalls: boolean,
	includeArchivedSessions: boolean,
): CodexState {
	return {
		...state,
		schema_version: STATE_SCHEMA_VERSION,
		include_tool_calls: includeToolCalls,
		include_archived_sessions: includeArchivedSessions,
		files: state.files ?? {},
		indexed_sessions: [...new Set(state.indexed_sessions ?? [])].sort(),
	};
}

function indexedSessionIds(files: Record<string, CodexFileState>): string[] {
	const ids: string[] = [];
	for (const file of Object.values(files)) {
		if (file.indexed && file.session_id != null) {
			ids.push(file.session_id);
		}
	}
	return [...new Set(ids)].sort();
}

function sortFileState(
	files: Record<string, CodexFileState>,
): Record<string, CodexFileState> {
	return Object.fromEntries(
		Object.entries(files).sort(([left], [right]) => left.localeCompare(right)),
	);
}
