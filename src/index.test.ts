import assert from 'node:assert/strict';
import {
	buildCodexSessionDelete,
	buildCodexSessionUpdate,
	type CodexSessionFile,
	isIndexableCodexSession,
	parseCodexSessionLines,
	resolveCodexHome,
} from './codex_log.ts';
import {
	fileNeedsParse,
	initialState,
	nextStateAfterReconcile,
} from './index.ts';

const file: CodexSessionFile = {
	path:
		'/home/example/.codex/sessions/2026/06/03/rollout-2026-06-03T10-00-00-019e8abc-1234-7abc-8def-123456789abc.jsonl',
	stateKey:
		'sessions/2026/06/03/rollout-2026-06-03T10-00-00-019e8abc-1234-7abc-8def-123456789abc.jsonl',
	mtimeMs: Date.parse('2026-06-03T10:30:00.000Z'),
	size: 1234,
};

Deno.test('parseCodexSessionLines builds a clean session doc without tool outputs', () => {
	const session = parseCodexSessionLines(
		[
			jsonLine('session_meta', {
				id: '019e8abc-1234-7abc-8def-123456789abc',
				timestamp: '2026-06-03T10:00:00.000Z',
				cwd: '/home/example/dev/gety',
				cli_version: '0.136.0',
				source: 'cli',
			}),
			jsonLine('turn_context', {
				summary: 'Codex connector design',
				cwd: '/home/example/dev/gety',
				workspace_roots: ['/home/example/dev/gety'],
				model: 'gpt-5.5',
			}),
			message('user', 'Build a connector.'),
			message('assistant', 'I am checking files.', 'commentary'),
			functionCall('exec_command', { cmd: 'deno task verify' }),
			functionCallOutput('very large output that must not be indexed'),
			message('assistant', 'Done.', 'final_answer'),
			message('user', 'One more change.'),
			message('assistant', 'Updated.', 'final_answer'),
		],
		file,
		{ includeToolCalls: false },
	);

	assert.equal(session.id, '019e8abc-1234-7abc-8def-123456789abc');
	assert.equal(session.title, 'Codex connector design');
	assert.equal(session.cwd, '/home/example/dev/gety');
	assert.equal(session.messageCount, 4);
	assert.equal(session.userMessageCount, 2);
	assert.equal(session.codexMessageCount, 2);
	assert.equal(session.toolCallCount, 0);
	assert.match(session.content, /^# Codex connector design/);
	assert.match(session.content, /## Session/);
	assert.match(session.content, /- Workspace: `\/home\/example\/dev\/gety`/);
	assert.match(session.content, /- Model: `gpt-5\.5`/);
	assert.doesNotMatch(session.content, /- Started:/);
	assert.doesNotMatch(session.content, /- Updated:/);
	assert.doesNotMatch(session.content, /Cwd/);
	assert.match(session.content, /## User\n\nBuild a connector\./);
	assert.match(session.content, /## Codex\n\nDone\./);
	assert.match(session.content, /\n---\n/);
	assert.doesNotMatch(session.content, /checking files/);
	assert.doesNotMatch(session.content, /very large output/);
	assert.doesNotMatch(session.content, /Tool Calls/);
});

Deno.test('parseCodexSessionLines includes tool call summaries when enabled', () => {
	const session = parseCodexSessionLines(
		[
			jsonLine('session_meta', {
				id: '019e8abc-1234-7abc-8def-123456789abc',
			}),
			message('user', 'Run checks.'),
			functionCall('exec_command', { cmd: 'deno task verify' }),
			customToolCall(
				'apply_patch',
				[
					'*** Begin Patch',
					'*** Update File: src/index.ts',
					'@@',
					'*** End Patch',
				].join('\n'),
			),
			functionCallOutput('this output is still omitted'),
			message('assistant', 'Checks passed.', 'final_answer'),
		],
		file,
		{ includeToolCalls: true },
	);

	assert.equal(session.toolCallCount, 2);
	assert.match(session.content, /## Tool Calls/);
	assert.match(session.content, /- exec_command: deno task verify/);
	assert.match(session.content, /- apply_patch: src\/index\.ts/);
	assert.doesNotMatch(session.content, /this output is still omitted/);
});

Deno.test('parseCodexSessionLines falls back to the first prompt title', () => {
	const session = parseCodexSessionLines(
		[
			jsonLine('turn_context', { summary: 'auto' }),
			message('user', 'First prompt title.\n\nLong body.'),
			message('assistant', 'Answer.', 'final_answer'),
		],
		file,
		{ includeToolCalls: false },
	);

	assert.equal(session.title, 'First prompt title.');
});

Deno.test('parseCodexSessionLines renders directory when workspace is missing', () => {
	const session = parseCodexSessionLines(
		[
			jsonLine('session_meta', {
				cwd: '/home/example/dev/gety',
			}),
			message('user', 'Question.'),
			message('assistant', 'Answer.', 'final_answer'),
		],
		file,
		{ includeToolCalls: false },
	);

	assert.match(session.content, /- Directory: `\/home\/example\/dev\/gety`/);
	assert.doesNotMatch(session.content, /- Workspace:/);
});

Deno.test('parseCodexSessionLines skips injected user context', () => {
	const session = parseCodexSessionLines(
		[
			message(
				'user',
				'# AGENTS.md instructions for /home/example/dev/gety\n\nDo not index.',
			),
			message('user', 'Real prompt.'),
			message('assistant', 'Real answer.', 'final_answer'),
		],
		file,
		{ includeToolCalls: false },
	);

	assert.equal(session.title, 'Real prompt.');
	assert.equal(isIndexableCodexSession(session), true);
	assert.match(session.content, /Real prompt/);
	assert.doesNotMatch(session.content, /Do not index/);
});

Deno.test('isIndexableCodexSession rejects sessions with only injected context', () => {
	const session = parseCodexSessionLines(
		[
			message(
				'user',
				'# AGENTS.md instructions for /home/example/dev/gety\n\nDo not index.',
			),
			message(
				'user',
				'<environment_context>\n  <cwd>/home/example/dev/gety</cwd>\n</environment_context>',
			),
			message('assistant', 'Orphan final answer.', 'final_answer'),
		],
		file,
		{ includeToolCalls: false },
	);

	assert.equal(session.userMessageCount, 0);
	assert.equal(isIndexableCodexSession(session), false);
});

Deno.test('isIndexableCodexSession rejects prompt-only sessions', () => {
	const session = parseCodexSessionLines(
		[
			message('user', 'whats 2+2?'),
		],
		file,
		{ includeToolCalls: false },
	);

	assert.equal(session.userMessageCount, 1);
	assert.equal(session.codexMessageCount, 0);
	assert.equal(isIndexableCodexSession(session), false);
});

Deno.test('buildCodexSessionUpdate emits stable Gety metadata', () => {
	const session = parseCodexSessionLines(
		[
			jsonLine('session_meta', {
				id: '019e8abc-1234-7abc-8def-123456789abc',
				timestamp: '2026-06-03T10:00:00.000Z',
				model_provider: 'openai',
			}),
			jsonLine('turn_context', {
				workspace_roots: ['/home/example/dev/gety'],
				model: 'gpt-5.5',
			}),
			message('user', 'Question.'),
			message('assistant', 'Answer.', 'final_answer'),
		],
		file,
		{ includeToolCalls: false },
	);
	const update = buildCodexSessionUpdate(session);

	assert.equal(update.kind, 'upsert');
	if (update.kind !== 'upsert') {
		throw new Error('Expected an upsert.');
	}

	assert.equal(
		update.doc.id,
		'codex:session:019e8abc-1234-7abc-8def-123456789abc',
	);
	assert.equal(update.doc.doc_type, 'codex:session');
	assert.equal(update.doc.content_format, 'markdown');
	assert.equal(update.doc.doc_updated_at, '2026-06-03T10:30:00.000Z');
	assert.equal(update.doc.original_file_size, 1234);
	assert.deepEqual(update.doc.metadata, {
		url:
			'file:///home/example/.codex/sessions/2026/06/03/rollout-2026-06-03T10-00-00-019e8abc-1234-7abc-8def-123456789abc.jsonl',
		source: 'codex',
		source_path: file.path,
		session_id: '019e8abc-1234-7abc-8def-123456789abc',
		cwd: undefined,
		workspace_roots: ['/home/example/dev/gety'],
		model: 'gpt-5.5',
		model_provider: 'openai',
		created_at: '2026-06-03T10:00:00.000Z',
		cli_version: undefined,
		message_count: 2,
		user_message_count: 1,
		codex_message_count: 1,
		tool_call_count: 0,
		content_truncated: false,
	});
});

Deno.test('buildCodexSessionDelete targets the same stable session doc id', () => {
	const session = parseCodexSessionLines(
		[
			jsonLine('session_meta', {
				id: '019e8abc-1234-7abc-8def-123456789abc',
			}),
		],
		file,
		{ includeToolCalls: false },
	);

	assert.deepEqual(buildCodexSessionDelete(session), {
		kind: 'delete',
		id: 'codex:session:019e8abc-1234-7abc-8def-123456789abc',
	});
});

Deno.test('resolveCodexHome chooses platform-specific defaults', () => {
	assert.equal(
		resolveCodexHome({ CODEX_HOME: '/custom/codex' }, 'linux'),
		'/custom/codex',
	);
	assert.equal(
		resolveCodexHome({ HOME: '/home/example' }, 'linux'),
		'/home/example/.codex',
	);
	assert.equal(
		resolveCodexHome({ USERPROFILE: 'C:\\Users\\yuche' }, 'windows'),
		'C:\\Users\\yuche/.codex',
	);
});

Deno.test('fileNeedsParse tracks new and changed JSONL files', () => {
	const previousFile = {
		session_id: 'session-a',
		mtime_ms: 1,
		size: 10,
		indexed: true,
	};

	assert.equal(
		fileNeedsParse(
			{ path: '/a.jsonl', stateKey: 'sessions/a.jsonl', mtimeMs: 1, size: 10 },
			previousFile,
		),
		false,
	);
	assert.equal(
		fileNeedsParse(
			{ path: '/a.jsonl', stateKey: 'sessions/a.jsonl', mtimeMs: 2, size: 10 },
			previousFile,
		),
		true,
	);
	assert.equal(
		fileNeedsParse(
			{ path: '/a.jsonl', stateKey: 'sessions/a.jsonl', mtimeMs: 1, size: 11 },
			previousFile,
		),
		true,
	);
	assert.equal(
		fileNeedsParse(
			{
				path: '/new.jsonl',
				stateKey: 'sessions/new.jsonl',
				mtimeMs: 1,
				size: 10,
			},
			undefined,
		),
		true,
	);
});

Deno.test('nextStateAfterReconcile stores sorted file fingerprints and indexed sessions', () => {
	assert.deepEqual(
		nextStateAfterReconcile(
			{
				'/b.jsonl': {
					mtime_ms: 2,
					size: 20,
					indexed: false,
				},
				'/a.jsonl': {
					session_id: 'session-a',
					mtime_ms: 1,
					size: 10,
					indexed: true,
				},
			},
			false,
			true,
		),
		{
			schema_version: 3,
			include_tool_calls: false,
			include_archived_sessions: true,
			files: {
				'/a.jsonl': {
					session_id: 'session-a',
					mtime_ms: 1,
					size: 10,
					indexed: true,
				},
				'/b.jsonl': {
					mtime_ms: 2,
					size: 20,
					indexed: false,
				},
			},
			indexed_sessions: ['session-a'],
		},
	);
});

Deno.test('initialState resets file fingerprints when config changes', () => {
	assert.deepEqual(
		initialState(
			{
				schema_version: 3,
				include_tool_calls: false,
				include_archived_sessions: true,
				files: {
					'/a.jsonl': {
						session_id: 'session-a',
						mtime_ms: 1,
						size: 10,
						indexed: true,
					},
				},
			},
			true,
			true,
		),
		{
			schema_version: 3,
			include_tool_calls: true,
			include_archived_sessions: true,
			files: {},
			indexed_sessions: ['session-a'],
		},
	);
});

function jsonLine(type: string, payload: Record<string, unknown>): string {
	return JSON.stringify({ type, payload });
}

function message(
	role: string,
	text: string,
	phase?: string,
): string {
	return jsonLine('response_item', {
		type: 'message',
		role,
		phase,
		content: [
			{
				type: role === 'assistant' ? 'output_text' : 'input_text',
				text,
			},
		],
	});
}

function functionCall(name: string, args: Record<string, unknown>): string {
	return jsonLine('response_item', {
		type: 'function_call',
		name,
		arguments: JSON.stringify(args),
		call_id: 'call-id',
	});
}

function customToolCall(name: string, input: string): string {
	return jsonLine('response_item', {
		type: 'custom_tool_call',
		name,
		input,
		call_id: 'call-id',
	});
}

function functionCallOutput(output: string): string {
	return jsonLine('response_item', {
		type: 'function_call_output',
		call_id: 'call-id',
		output,
	});
}
