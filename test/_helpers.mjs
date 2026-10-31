/**
 * 测试共用的小工具（不是测试文件本身，`run-all.ps1` 不会直接跑它）。
 *
 * 每个测试都拿一个**独立的临时 DSH_HOME**：本插件的所有路径都从 `process.env.DSH_HOME`
 * 现算，所以只要在 import 之后（其实任何时刻）设好变量，就不会碰到真实的记忆目录。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createBudget } from '../lib/budget.js';
import { backupsDir, consolidateDir, cursorPath, pendingDir } from '../lib/cursor.js';
import { createExtractor } from '../lib/extractor.js';
import { appendRow } from '../lib/pending.js';
import { createRunLog } from '../lib/runlog.js';
import { createWriter } from '../lib/writer.js';

/** 单测统一用的「当前时间」（固定值，别用 Date.now() 让用例互相影响）。 */
export const NOW = 1_800_000_000_000;

/**
 * 造一个临时 DSH_HOME 并挂到环境变量上。
 *
 * @param {string} label 目录名前缀（便于排查是哪条用例留下的）。
 * @returns {{ home: string, cleanup: () => void }}
 */
export function makeHome(label = 'pmc') {
    const home = mkdtempSync(join(tmpdir(), `${label}-`));
    const previous = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    return {
        home,
        cleanup() {
            if (previous === undefined) delete process.env.DSH_HOME;
            else process.env.DSH_HOME = previous;
            try {
                rmSync(home, { recursive: true, force: true });
            } catch {
                /* Windows 上偶发句柄占用，忽略即可（临时目录） */
            }
        },
    };
}

/**
 * 造一个假 store：只实现用得到的方法，调用序列记在 `calls` 里。
 *
 * @param {Record<string, any>} [overrides]
 * @returns {{ calls: { name: string, args: any[] }[], store: Record<string, any> }}
 */
export function fakeStore(overrides = {}) {
    const calls = [];
    const store = {
        calls,
        async validateEntry(scope, entry, options) {
            calls.push({ name: 'validateEntry', args: [scope, entry, options] });
            return { ok: true };
        },
        async insertEntry(scope, entry, options) {
            calls.push({ name: 'insertEntry', args: [scope, entry, options] });
            return { written: true, target: `${scope}:1` };
        },
        async replaceEntry(scope, id, entry, options) {
            calls.push({ name: 'replaceEntry', args: [scope, id, entry, options] });
            return { written: true, replaced: true };
        },
        async deleteEntry(scope, id) {
            calls.push({ name: 'deleteEntry', args: [scope, id] });
            return { deleted: true };
        },
        async assertEntry(scope, text, options) {
            calls.push({ name: 'assertEntry', args: [scope, text, options] });
        },
        async appendJournal(text, tags) {
            calls.push({ name: 'appendJournal', args: [text, tags] });
            return { id: 'j1', ts: 1 };
        },
        async watermark(scope) {
            calls.push({ name: 'watermark', args: [scope] });
            return { lines: 45, bytes: 4261, chars: 4261, limit: 8000 };
        },
        ...overrides,
    };
    return { calls, store };
}

/** 造一个带 `code: 'MEMORY_BUDGET_EXCEEDED'` 的错误。 */
export function budgetError(message = 'MEMORY_BUDGET_EXCEEDED: fact 超限') {
    const error = new Error(message);
    error.code = 'MEMORY_BUDGET_EXCEEDED';
    return error;
}

/**
 * 造会话事件（`turn/start` → 用户消息 → 助手消息 → `turn/end`）。
 *
 * @param {{
 *   turn: number,
 *   user?: string,
 *   userId?: string,
 *   assistant?: string[],
 *   images?: boolean,
 *   injected?: string[],
 *   reason?: string,
 *   open?: boolean,
 * }} spec
 * @param {{ seq: number }} counter 可变序号（模拟宿主 append 自增）。
 * @returns {any[]}
 */
export function makeTurn(spec, counter = { seq: 0 }) {
    const events = [];
    const push = (type, data, extra = {}) => {
        counter.seq += 1;
        events.push({ type, seq: counter.seq, time: 1_700_000_000_000 + counter.seq, data, ...extra });
    };

    push('turn/start', { turn: spec.turn });
    for (const text of spec.injected ?? []) {
        push('user/message', { message: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'time-context' } } });
    }
    if (spec.images === true) {
        push('user/message', { message: { role: 'user', content: [{ type: 'image', image: 'x' }], source: { kind: 'user' } } });
    } else if (spec.user !== undefined) {
        push('user/message', {
            message: { role: 'user', content: [{ type: 'text', text: spec.user }], source: { kind: spec.userId ?? 'user' } },
        });
    }
    push('system/message', { message: { role: 'system', content: [{ type: 'text', text: '系统提示词不该被取样' }] } });
    for (const text of spec.assistant ?? []) {
        push('assistant/message', {
            message: {
                role: 'assistant',
                content: [
                    { type: 'reasoning', text: '思维链不该被取样' },
                    { type: 'text', text },
                    { type: 'tool-call', name: 'shell' },
                ],
            },
        });
    }
    if (spec.open !== true) push('turn/end', { turn: spec.turn, reason: { kind: spec.reason ?? 'completed' } });
    return events;
}

/** 断言某个函数**不抛**（用于「坏输入不炸」的用例）。 */
export function doesNotThrow(fn, message = '不应抛错') {
    try {
        fn();
    } catch (error) {
        assert.fail(`${message}：${String(error?.message ?? error)}`);
    }
}

/* ─────────────────── M1 起新增：真实文件后端的假 store / 假 runtime ─────────────────── */

/**
 * 单测用的配置默认值。
 *
 * 为什么这里抄一份而不是 `import { Config } from '../lib/index.js'`：`index.js` 需要
 * `schemastery`（装配时由 profile 提供），本机开发环境没装 ⇒ 整个用例会被 SKIP 掉。
 * 口径仍以 `Config` 为准：`wiring.test.mjs` 在装了 schemastery 的机器上逐键比对默认值，
 * 这里只抄一份「管线真正会读」的键。
 */
export function consolidateConfig(overrides = {}) {
    return {
        enabled: true,
        dryRun: true,
        scope: 'both',
        minTurns: 6,
        minChars: 8000,
        perTurnCap: 1200,
        maxSampleChars: 8000,
        workspaceIsolation: true,
        workspaceRegistry: '',
        unassignedBucket: '_unassigned',
        pendingMaxRows: 200,
        pendingMaxAgeDays: 30,
        archiveRetentionDays: 90,
        idleScanMinutes: 30,
        dailyLlmBudget: 60,
        maxTurnsPerCall: 6,
        partialKeep: false,
        provider: '',
        model: '',
        subagent: false,
        redact: true,
        crossEnabled: true,
        crossSource: 'auto',
        crossIntervalHours: 24,
        crossMinEntries: 20,
        crossScanEntries: 200,
        crossPromoteHits: 2,
        crossMaxSessions: 20,
        crossLookbackDays: 7,
        ...overrides,
    };
}

/** store 条目规范化（与主插件 `normalizeEntryText` 同口径，只为让 id 稳定）。 */
function normalizeEntryText(text) {
    return String(text ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
        .replace(/`/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[。．.；;，,、]+$/, '')
        .toLowerCase();
}

/**
 * 文件后端的假 store：真的写 `$DSH_HOME/memory/FACT.md` / `JOURNAL.jsonl` / 项目 `MEMORY.md`。
 *
 * 为什么不用记录调用的空 store：M1 要断言的正是「文件有没有被改、SHA256 变没变、
 * 回滚能不能还原」，空 store 拿不到这些证据。方法名与主插件 `lib/store.js` 一致。
 *
 * @param {{
 *   home: string,
 *   projectDir?: string,
 *   factText?: string,
 *   memoryText?: string,
 *   budgetExceeded?: string[],
 * }} options
 */
export function memoryStore(options = {}) {
    const home = options.home;
    const memoryDir = join(home, 'memory');
    mkdirSync(memoryDir, { recursive: true });
    const factFile = join(memoryDir, 'FACT.md');
    const journalFile = join(memoryDir, 'JOURNAL.jsonl');
    const projectDir = options.projectDir;
    const memoryFile = typeof projectDir === 'string' && projectDir !== '' ? join(projectDir, 'MEMORY.md') : null;

    if (typeof options.factText === 'string') writeFileSync(factFile, options.factText, 'utf8');
    if (typeof options.memoryText === 'string' && memoryFile !== null) writeFileSync(memoryFile, options.memoryText, 'utf8');

    const calls = [];
    const state = { budgetExceeded: new Set(options.budgetExceeded ?? []) };

    const readText = (file) => {
        try {
            return readFileSync(file, 'utf8');
        } catch {
            return null;
        }
    };
    const writeText = (file, text) => {
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.tmp-${process.pid}`;
        writeFileSync(tmp, text, 'utf8');
        renameSync(tmp, file);
    };
    const entryId = (ts, text) => createHash('sha1').update(`${String(ts ?? '')}${normalizeEntryText(text)}`).digest('hex').slice(0, 10);
    const fileOf = (scope) => (scope === 'fact' ? factFile : memoryFile);

    const store = {
        calls,
        state,
        factPath: () => factFile,
        journalPath: () => journalFile,
        indexPath: () => join(memoryDir, 'index.json'),
        readText,
        entryId,
        findProjectMemory: (cwd) => (cwd === undefined || cwd === '' || memoryFile === null
            ? null
            : { root: cwd, path: memoryFile, exists: true, content: readText(memoryFile) ?? '' }),
        templates: () => ({ promptFragment: '【条目模板】只写结论，不带原因。' }),
        watermark: (scope, context) => {
            const file = scope === 'memory' ? (memoryFile ?? '') : factFile;
            const raw = file === '' ? '' : (readText(file) ?? '');
            return {
                scope,
                path: file,
                lines: raw === '' ? 0 : raw.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length,
                bytes: Buffer.byteLength(raw, 'utf8'),
                chars: raw.trim().length,
                limit: scope === 'memory' ? { chars: 8000 } : { lines: 100, bytes: 8000 },
            };
        },
        validateEntry(scope, entry) {
            calls.push({ name: 'validateEntry', args: [scope, entry] });
            const text = typeof entry === 'string' ? entry : String(entry?.text ?? '');
            return text === '' ? { ok: false, reason: '条目为空', demote: 'drop' } : { ok: true };
        },
        assertEntry(scope, text, context) {
            calls.push({ name: 'assertEntry', args: [scope, text, context] });
            if (state.budgetExceeded.has(scope)) throw budgetError(`MEMORY_BUDGET_EXCEEDED: ${scope} 超限`);
            return { ok: true };
        },
        async insertEntry(scope, entry, context) {
            calls.push({ name: 'insertEntry', args: [scope, entry, context] });
            if (state.budgetExceeded.has(scope)) throw budgetError(`MEMORY_BUDGET_EXCEEDED: ${scope} 超限`);
            const file = fileOf(scope);
            if (file === null) return { written: false, reason: 'no-project-memory' };
            const current = readText(file) ?? '';
            const glue = current === '' || current.endsWith('\n') ? '' : '\n';
            writeText(file, `${current}${glue}- ${String(entry?.text ?? '')}\n`);
            return { written: true, id: entryId(Date.now(), entry?.text ?? ''), target: file };
        },
        async replaceEntry(scope, id, entry, context) {
            calls.push({ name: 'replaceEntry', args: [scope, id, entry, context] });
            if (state.budgetExceeded.has(scope)) throw budgetError(`MEMORY_BUDGET_EXCEEDED: ${scope} 超限`);
            const file = fileOf(scope);
            const current = file === null ? null : readText(file);
            if (current === null) return { written: false, notFound: true };
            const lines = current.split('\n');
            let hit = -1;
            lines.forEach((line, index) => {
                const bullet = /^\s*-\s+(.+)$/u.exec(line);
                if (bullet !== null && entryId('', bullet[1]) === id) hit = index;
            });
            if (hit < 0) return { written: false, notFound: true };
            lines[hit] = `- ${String(entry?.text ?? '')}`;
            writeText(file, lines.join('\n'));
            return { written: true, replaced: true, target: file };
        },
        async deleteEntry(scope, id) {
            calls.push({ name: 'deleteEntry', args: [scope, id] });
            return { deleted: false };
        },
        async appendJournal(text, tags) {
            calls.push({ name: 'appendJournal', args: [text, tags] });
            const line = JSON.stringify({ ts: new Date(NOW).toISOString(), tags: tags ?? [], text: String(text ?? '') });
            const current = readText(journalFile) ?? '';
            writeText(journalFile, `${current}${line}\n`);
            return { id: entryId(NOW, text), ts: NOW };
        },
    };

    return store;
}

/**
 * 造一个「管线视角」的 runtime：只放 `pipeline` / `commands` 真正读的字段。
 *
 * @param {{
 *   config?: Record<string, any>,
 *   store?: any,
 *   model?: (request: { prompt: string }) => any,
 *   budget?: any,
 *   runLog?: any,
 *   registry?: any,
 * }} [options]
 */
export function makeRuntime(options = {}) {
    const config = consolidateConfig(options.config);
    const store = options.store ?? null;
    const model = options.model ?? (async () => '{"memories":[]}');
    const supersededFile = join(consolidateDir(), 'superseded.jsonl');

    return {
        config,
        runLog: options.runLog ?? createRunLog(),
        resolveStore: async () => store,
        budget: options.budget ?? createBudget({ dailyLlmBudget: config.dailyLlmBudget }),
        writer: createWriter({ store, supersededFile }),
        extractor: createExtractor({
            callModel: model,
            maxChars: config.maxSampleChars,
            templates: () => ({ promptFragment: '【条目模板】只写结论，不带原因。' }),
        }),
        callModel: model,
        templatesCache: null,
        cursorFile: cursorPath(),
        pendingDir: pendingDir(),
        backupsDir: backupsDir(),
        consolidateDir: consolidateDir(),
        supersededFile,
        registryFile: join(consolidateDir(), 'workspace.json'),
        registry: options.registry ?? { workspaces: {} },
        cross: { lastRunAt: 0, lastCount: 0, lastRunId: '' },
    };
}

/**
 * 往 `pending/<bucket>/<session>.jsonl` 灌几行（模拟 M2 会做的 L0 写入）。
 *
 * @param {{
 *   bucket: string,
 *   sessionId: string,
 *   count: number,
 *   startTurn?: number,
 *   chars?: number,
 *   assistant?: string,
 *   cwd?: string,
 *   pendingDir?: string,
 * }} spec
 */
export function seedRows(spec) {
    const dir = typeof spec.pendingDir === 'string' && spec.pendingDir !== '' ? spec.pendingDir : pendingDir();
    const count = Number.isFinite(spec.count) ? spec.count : 6;
    const startTurn = Number.isFinite(spec.startTurn) ? spec.startTurn : 1;
    for (let offset = 0; offset < count; offset += 1) {
        const turn = startTurn + offset;
        const assistant = spec.assistant ?? `第 ${turn} 轮的结论：依赖用 tarball 装，不要用 pnpm install`;
        appendRow({
            pendingDir: dir,
            bucket: spec.bucket,
            sessionId: spec.sessionId,
            now: NOW + turn,
            row: {
                turn,
                endedAt: NOW + turn,
                seqFrom: turn * 10,
                user: `第 ${turn} 轮的问题`,
                assistant,
                chars: Number.isFinite(spec.chars) ? spec.chars : assistant.length + 10,
                session: spec.sessionId,
                cwd: spec.cwd ?? '',
                workspaceId: spec.bucket,
                workspaceTitle: '',
                consumed: false,
            },
        });
    }
    return { bucket: spec.bucket, sessionId: spec.sessionId, turns: count };
}

/** 假模型：按 prompt 形状决定回答「抽取」还是「裁决」。 */
export function fakeModel(replies = {}) {
    const calls = [];
    const model = async (request) => {
        calls.push(String(request?.prompt ?? ''));
        const adjudication = String(request?.prompt ?? '').includes('下面是已存在的记忆条目');
        const reply = adjudication ? (replies.adjudication ?? '{"ops":[]}') : (replies.extraction ?? '{"memories":[]}');
        return typeof reply === 'function' ? reply(request) : reply;
    };
    model.calls = calls;
    return model;
}

/** 文件的 SHA256（不存在 ⇒ 空串），「一字未动」的断言用它。 */
export function sha256(file) {
    try {
        return createHash('sha256').update(readFileSync(file)).digest('hex');
    } catch {
        return '';
    }
}
