/**
 * L1 单次闭环：L0 暂存 → 门槛 → 抽取（1 次 LLM）→ 归并 → 写入 → 标记消费（02 §3 L1 / §6.2 / §7.2–§7.4）。
 *
 * 一次 `runL1` 做且只做**一个工作区桶**的沉淀；`runAllBuckets` 逐桶循环并只占**一次**
 * 全局单飞锁（02 §6.5 规矩 3：全局并发 = 1，不能每个桶再抢一次）。
 *
 * 成本纪律（02 §7.5）：
 *  - **正常是 1 次调用**（抽取 + 裁决同一份 prompt 的原始设计）；
 *  - 例外是**最多 2 次**：某个候选落在归一化相似度 `[0.45, 0.95)` 时需要一次裁决，
 *    而「同一次调用」在事实顺序上不可能实现（要先抽取才知道有哪些候选、要检索才知道
 *    该带哪几条旧条目进 prompt）。所以这里**认账**：真的发了两次就在 runlog / 返回值
 *    的 `calls` 里写 2，绝不假装一次（M3 再考虑把「抽取 + 裁决」合并成真正的单趟）。
 *
 * 数据纪律：
 *  - 所有文件系统写入都在 `$DSH_HOME/memory/consolidate/` 下（pending / backups / runlog）；
 *    FACT.md / JOURNAL.jsonl / MEMORY.md **只经主插件 store** 写，本模块不碰；
 *  - 唯一例外是 `rollbackRun`：它把 `backups/<runId>/` 的快照**恢复**回原路径（含项目
 *    `MEMORY.md`），这是回滚的定义，也是 02 §7.7「项目目录里只可能改 MEMORY.md」的唯一豁免。
 *
 * 失败语义：
 *  - 抽取非法 JSON / 归并失败 / 写入失败 ⇒ **不标记消费、不推进游标**（下次重跑，靠
 *    抽取 prompt 的「已在记忆里的不重复写」+ 模板闸口保幂等），runlog 记 FAIL；
 *  - `dryRun` ⇒ 管线照跑（抽取、归并、校验都真的执行），writer 对每条只记 `DRY`，
 *    行保持未消费、快照也不建。
 *  - `mode: observe`（影子模式）⇒ 管线同样真跑（真调 LLM、真打码、真校验），writer 只把
 *    「本来会写什么」落进 `would-write/<日期>.jsonl`，不写 FACT / MEMORY / JOURNAL。
 *    **内部记账与 auto 完全一致**：暂存行照常 `markConsumed` + 归档、游标照常推进、预算照常扣
 *    —— 只有这样「同一批素材」才不会被反复采样、反复烧 LLM；代价是观察期被消费的素材在切到
 *    auto 后不会补写（这是有意的，见 README「影子模式」）。
 *    唯一不做的副作用是**记忆文件快照**：一个字节都没写，快照只会堆垃圾、也没法回滚。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { PHASE_LAYER1 } from './budget.js';
import { backupsDir, cursorPath, pendingDir as defaultPendingDir, readCursor, setSessionCursor, writeCursor } from './cursor.js';
import { buildConversation, DEFAULT_IMPORTANCE } from './extractor.js';
import { GATE_REASON, gateBatch } from './gate.js';
import { codeOf, detailOfError } from './llm.js';
import { MAX_NEIGHBORS, PRE_SCREEN, mergeCandidates, parseFactEntries, parseMemoryEntries, preScreen, topNeighbors } from './merger.js';
import { MODE, resolveMode } from './mode.js';
import * as pending from './pending.js';
import { STATUS } from './runlog.js';
import { listPendingBuckets } from './sources.js';
import { decideConsume } from './trigger.js';
import { bucketInfo, loadRegistry, resolveRowsWorkspace } from './workspace.js';
import { isRetryableFailure } from './writer.js';

/** 快照文件名：与目标同名，回滚时一眼能对上（02 §9 M4「回滚后 SHA256 一致」）。 */
export const SNAPSHOT_NAMES = { fact: 'FACT.md', journal: 'JOURNAL.jsonl', memory: 'MEMORY.md' };
/** 快照清单：记录「备份里的这份文件原本在哪」，回滚靠它还原。 */
export const MANIFEST_FILE = 'manifest.json';
/** 保留多少份运行快照（02 §9 M4：保留 10 份）。 */
export const DEFAULT_KEEP_BACKUPS = 10;

/**
 * 生效的 `dryRun`：**显式参数 → config.dryRun → 默认干跑**。
 *
 * 为什么「没传就当 config 说了算」：`dryRun` 默认 true 是这条管线的安全网
 * （00 §5.1「附属插件默认 dryRun: true → 只出报告不落盘」）。如果调用方忘了传，
 * 默认值必须是「不写盘」而不是「写盘」——否则一次手误就能改到 FACT.md。
 *
 * @param {boolean | undefined} explicit
 * @param {Record<string, any>} config
 * @returns {boolean}
 */
export function resolveDryRun(explicit, config = {}) {
    if (explicit === true) return true;
    if (explicit === false) return false;
    return config.dryRun !== false;
}

/** 空计数（返回值与 runlog 共用的形状）。 */
function emptyCounts() {
    // `observed`：影子档「本来会写」的算子数（不是真实写入数，别混进 written）。
    return { candidates: 0, ops: 0, written: 0, replaced: 0, deleted: 0, demoted: 0, dropped: 0, noop: 0, dry: 0, failed: 0, observed: 0 };
}

/** 运行 id：`run-<本地时间戳>-<3 位随机>`；runlog 与 `backups/<runId>/` 用它对齐。 */
export function makeRunId(now = Date.now()) {
    const date = new Date(now);
    const pad = (value, width = 2) => String(value).padStart(width, '0');
    const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${pad(date.getMilliseconds(), 3)}`;
    const salt = Math.random().toString(16).slice(2, 5);
    return `run-${stamp}-${salt}`;
}

/** 原子写文本（临时文件 + rename）。 */
function writeTextAtomic(file, text) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, file);
    return true;
}

/** 读文本（不存在 ⇒ null，**不抛**）。 */
function readTextSafe(file) {
    try {
        return readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

/* ────────────────────────────── 快照与回滚 ────────────────────────────── */

/** 项目 `MEMORY.md` 的绝对路径（store 的两种口径都试；拿不到 ⇒ 空串）。 */
function projectMemoryPathOf(store, cwd) {
    if (typeof store?.findProjectMemory === 'function') {
        try {
            const found = store.findProjectMemory(cwd);
            if (found !== null && typeof found?.path === 'string' && found.path !== '') return found.path;
        } catch {
            /* 落到下一种口径 */
        }
    }
    if (typeof store?.watermark === 'function') {
        try {
            const mark = store.watermark('memory', { cwd });
            if (typeof mark?.path === 'string' && mark.path !== '') return mark.path;
        } catch {
            /* 没有水位接口就只备份 FACT / JOURNAL */
        }
    }
    return '';
}

/** 只保留最近 `keep` 份快照（按目录 mtime，`current` 与它自己永不被删）。 */
function pruneBackups(root, keep, current) {
    let entries;
    try {
        entries = readdirSync(root, { withFileTypes: true });
    } catch {
        return [];
    }
    const dirs = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
            const full = join(root, entry.name);
            let at = 0;
            try {
                at = statSync(full).mtimeMs;
            } catch {
                at = 0;
            }
            return { name: entry.name, full, at };
        })
        .sort((left, right) => right.at - left.at);

    const removed = [];
    dirs.forEach((dir, index) => {
        if (index < keep || dir.full === current) return;
        try {
            rmSync(dir.full, { recursive: true, force: true });
            removed.push(dir.full);
        } catch {
            /* 删不掉就算了：观测手段不该把运行弄挂 */
        }
    });
    return removed;
}

/**
 * 跑前快照：把这次可能改到的三个文件复制进 `consolidate/backups/<runId>/`。
 *
 * 为什么要快照（00 §9 审计 P1「回滚按 runId 但没有 per-run 备份」）：主插件 store 自己也备份，
 * 但它的备份是**按文件 + 时间戳**平的，无法回答「这次运行改了哪些文件」；
 * 回滚需要一个以 run 为单位的切片。
 *
 * `dryRun` 一律跳过：干跑不改文件，建快照只会堆垃圾。
 *
 * @param {{
 *   runId: string,
 *   store: any,
 *   cwd?: string,
 *   dir?: string,
 *   dryRun?: boolean,
 *   keep?: number,
 *   now?: number,
 * }} input
 * @returns {{ dir: string, copied: string[], manifest: Record<string, any>, skipped?: string }}
 */
export function snapshotFiles(input = {}) {
    const { runId, store } = input;
    const now = Number.isFinite(input.now) ? input.now : Date.now();
    const empty = { dir: '', copied: [], manifest: {} };

    if (input.dryRun === true) return { ...empty, skipped: 'dry-run' };
    if (typeof runId !== 'string' || runId.trim() === '') return { ...empty, skipped: 'no-run-id' };
    if (store === null || store === undefined || typeof store.readText !== 'function') {
        return { ...empty, skipped: 'no-store' };
    }

    const dir = input.dir ?? join(backupsDir(), runId);
    const candidates = [];
    if (typeof store.factPath === 'function') {
        try {
            candidates.push({ name: SNAPSHOT_NAMES.fact, source: store.factPath() });
        } catch {
            /* 拿不到路径就不备份这一份 */
        }
    }
    if (typeof store.journalPath === 'function') {
        try {
            candidates.push({ name: SNAPSHOT_NAMES.journal, source: store.journalPath() });
        } catch {
            /* 同上 */
        }
    }
    const memoryPath = projectMemoryPathOf(store, input.cwd);
    if (memoryPath !== '') candidates.push({ name: SNAPSHOT_NAMES.memory, source: memoryPath });

    const manifest = {};
    const copied = [];
    for (const candidate of candidates) {
        if (typeof candidate.source !== 'string' || candidate.source === '') continue;
        let text;
        try {
            text = store.readText(candidate.source);
        } catch {
            text = null;
        }
        // 文件不存在（首次运行）⇒ 不写空壳进快照，回滚时也就不会把「不存在」变成「空文件」。
        if (typeof text !== 'string') continue;
        const target = join(dir, candidate.name);
        try {
            writeTextAtomic(target, text);
        } catch {
            continue;
        }
        // `source` = 原本的位置（回滚要写回这里），`backup` = 快照文件本身。
        manifest[candidate.name] = { source: candidate.source, backup: target, bytes: Buffer.byteLength(text, 'utf8') };
        copied.push(target);
    }

    if (copied.length === 0) return { dir: '', copied: [], manifest: {}, skipped: 'nothing-to-copy' };

    writeTextAtomic(join(dir, MANIFEST_FILE), `${JSON.stringify({ runId, createdAt: now, files: manifest }, null, 2)}\n`);
    pruneBackups(backupsDir(), Number.isFinite(input.keep) ? Math.max(1, input.keep) : DEFAULT_KEEP_BACKUPS, dir);
    return { dir, copied, manifest };
}

/** 列出所有快照（最新在前）。 */
export function listBackups(root = backupsDir()) {
    let entries;
    try {
        entries = readdirSync(root, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
            const full = join(root, entry.name);
            let at = 0;
            try {
                at = statSync(full).mtimeMs;
            } catch {
                at = 0;
            }
            return { runId: entry.name, dir: full, at };
        })
        .sort((left, right) => right.at - left.at);
}

/**
 * `last` 的解析：最新的一份快照。
 *
 * @param {{ dir?: string }} [options]
 * @returns {string} runId，没有快照则空串。
 */
export function latestRunId(options = {}) {
    const backups = listBackups(options.dir ?? backupsDir());
    return backups.length === 0 ? '' : backups[0].runId;
}

/**
 * 按 runId 回滚：把快照里的三份文件写回它们原来的位置。
 *
 * **先验父目录存在**：项目可能被移走/删掉，这时宁可不恢复（并报告 skipped），
 * 也不能在 `D:\` 根上凭旧路径造一个新目录出来。
 *
 * @param {{ runId: string, runtime?: any, dir?: string }} input
 * @returns {{ runId: string, restored: string[], skipped: { target: string, reason: string }[] } | { error: string, runId?: string }}
 */
export function rollbackRun(input = {}) {
    const runId = typeof input.runId === 'string' ? input.runId.trim() : '';
    if (runId === '') return { error: 'no-run-id' };

    const root = input.dir ?? input.runtime?.backupsDir ?? backupsDir();
    const dir = join(root, runId);
    const raw = readTextSafe(join(dir, MANIFEST_FILE));
    if (raw === null) return { error: 'no-snapshot', runId };

    let manifest;
    try {
        manifest = JSON.parse(raw);
    } catch {
        return { error: 'bad-manifest', runId };
    }
    const files = manifest?.files;
    if (files === null || typeof files !== 'object') return { error: 'bad-manifest', runId };

    const restored = [];
    const skipped = [];
    for (const [name, meta] of Object.entries(files)) {
        const target = typeof meta?.source === 'string' && meta.source !== ''
            ? meta.source
            : (typeof meta?.target === 'string' ? meta.target : '');
        if (target === '') {
            skipped.push({ target: name, reason: 'no-target' });
            continue;
        }
        if (!existsSync(dirname(target))) {
            skipped.push({ target, reason: 'parent-missing' });
            continue;
        }
        const backupFile = typeof meta?.backup === 'string' && meta.backup !== '' ? meta.backup : join(dir, basename(name));
        const text = readTextSafe(backupFile);
        if (text === null) {
            skipped.push({ target, reason: 'backup-missing' });
            continue;
        }
        try {
            writeTextAtomic(target, text);
            restored.push(target);
        } catch {
            skipped.push({ target, reason: 'write-failed' });
        }
    }

    if (restored.length === 0) return { error: 'nothing-restored', runId, skipped };
    return { runId, restored, skipped };
}

/* ────────────────────────────── runL1 ────────────────────────────── */

/** 从 store 上取路径（拿不到 ⇒ 空串）。 */
function pathOf(store, method) {
    if (typeof store?.[method] !== 'function') return '';
    try {
        const value = store[method]();
        return typeof value === 'string' ? value : '';
    } catch {
        return '';
    }
}

/** 读 store 视角的文本（不存在 ⇒ 空串）。 */
function textOf(store, file) {
    if (file === '' || typeof store?.readText !== 'function') return '';
    try {
        const value = store.readText(file);
        return typeof value === 'string' ? value : '';
    } catch {
        return '';
    }
}

/** 归并池：FACT 条目 + 项目 MEMORY 条目，id 优先用 store 的口径（替换时才认得出）。 */
function buildPool(store, factText, memoryText) {
    const withStoreId = (entry) => ({
        ...entry,
        id: typeof store?.entryId === 'function' ? store.entryId('', entry.text) : entry.id,
    });
    return [...parseFactEntries(factText).map(withStoreId), ...parseMemoryEntries(memoryText).map(withStoreId)];
}

/**
 * 跨池近重复预筛（DESIGN §5）：**只丢 exact / near-duplicate（NOOP），其余一律放行**。
 *
 * 为什么要有这一道：`gate.js` 只管「同批」重复，管不到「上个月已经写进 FACT 的结论，
 * 这次换个说法又交上来」（2026-11-09 实测 6 条里 4 条与既有条目语义重复）。归并层其实
 * 也会判一次 NOOP，但它不计入闸口分类、运行报告里也看不见「为什么没写」；提前到这里，
 * 被跨池判掉的条目才能以 `near-duplicate` 出现在 gate 计数里（绝不静默丢）。
 *
 * 为什么放在**归并之前**而不是 writer 之前：归并里 `[0.45, 0.95)` 的候选会去问模型，
 * 那个区间是「改写 / 补充」而不是重复（本次 happy path 的 0.75 就是 UPDATE）。抢在归并
 * 前面按 NOOP 丢掉它们才是误杀；这里只拦 NOOP，ADJUDICATE 原样交给归并。
 *
 * 池来自调用方（`runL1` 已在本次运行开头读盘一次），本函数**不读盘**；池为空、开关关闭、
 * 或者打分抛错 ⇒ 整批放行。门控是提纯与观测，**不能因为自己坏掉就阻断写入**。
 * 异常时返回 `error`（带触发下标与错误码），调用方负责写进 runlog 的 `detail`——不静默。
 *
 * @param {(string | { content?: string })[]} points
 * @param {{ id?: string, text?: string }[]} pool
 * @param {{ enabled?: boolean, topK?: number }} [options]
 * @returns {{
 *   kept: any[],
 *   dropped: { index: number, reason: string, content: string, decision?: string, preReason?: string, top1?: number }[],
 *   checked: number,
 *   error: null | { index: number, code: string },
 * }}
 */
export function screenCrossPool(points = [], pool = [], options = {}) {
    const items = Array.isArray(points) ? points : [];
    const entries = Array.isArray(pool) ? pool : [];
    const result = { kept: [], dropped: [], checked: 0, error: null };
    if (options.enabled === false || entries.length === 0) {
        result.kept = [...items];
        return result;
    }

    const topK = Number.isFinite(options.topK) ? Math.max(1, Math.trunc(options.topK)) : MAX_NEIGHBORS;
    for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        const content = typeof item === 'string' ? item : String(item?.content ?? '');
        if (content.trim() === '') {
            // 空正文轮不到这一层（闸口已拦）；原样放行，别在这里再造一套判定。
            result.kept.push(item);
            continue;
        }
        let pre;
        try {
            pre = preScreen(content, topNeighbors(content, entries, { topK }));
        } catch (error) {
            // 打分（池 / 分词）层面的系统性故障：本条与后面所有条目一起放行，
            // 逐条重试只会把同一次故障重演 N 遍。错误码交给调用方落 runlog。
            result.error = { index, code: codeOf(error, 'cross-pool-error') };
            result.kept.push(...items.slice(index));
            return result;
        }
        result.checked += 1;
        // `preScreen` 的 NOOP 只有 exact / near-duplicate 两种 reason，这里写全是为了
        // 让「放行的是什么」在代码里一眼可见（将来 preScreen 加 NOOP 原因时不会误拦）。
        if (pre.decision === PRE_SCREEN.NOOP && (pre.reason === 'exact' || pre.reason === 'near-duplicate')) {
            result.dropped.push({
                index,
                reason: GATE_REASON.NEAR_DUPLICATE,
                content,
                decision: pre.decision,
                preReason: pre.reason,
                top1: pre.top1,
            });
            continue;
        }
        result.kept.push(item);
    }
    return result;
}

/**
 * 结论 / 细节分层的**确定性路由**（DESIGN §14.2）：纯函数，零 LLM、零 IO。
 *
 * 规则：`scope ∈ {global, project}` 且（`kind === 'detail'` 或 `importance <= 2`）⇒
 * **改判** `scope='journal'`。三条纪律：
 *
 *  1. **不丢弃**（这是分层，不是闸口）：内容照样写，只是从「每轮全量注入的静态槽」
 *     换成「JOURNAL 事件」——那颗 8 条实现细节的教训就是「粒度过细的条目占了静态槽，
 *     闸口只挡格式噪音、不挡粒度」；
 *  2. 已经判成 `journal` 的原样通过（不重复计数、不改写）；
 *  3. `scope` 不是 global/project 的（例如空串 / 未知值）原样通过：这里只做改判，
 *     合法性由抽取侧 `normalizeMemories()` 与写入侧 `toStoreScope()` 各自负责。
 *
 * 调用位置固定在 `gateBatch()` **之后**、跨池预筛**之前**（契约顺序）：先让闸口把
 * 空壳/过程叙述拦掉（那些根本不该被统计成「改判」），再让跨池去重看剩下的候选。
 *
 * @param {(string | { scope?: string, kind?: string, importance?: number })[]} candidates
 * @returns {{ candidates: any[], rerouted: number }}
 */
export function routeByGranularity(candidates = []) {
    const items = Array.isArray(candidates) ? candidates : [];
    const routed = [];
    let rerouted = 0;
    for (const candidate of items) {
        if (candidate === null || typeof candidate !== 'object') {
            routed.push(candidate);
            continue;
        }
        const scope = String(candidate.scope ?? '').trim().toLowerCase();
        const kind = String(candidate.kind ?? '').trim().toLowerCase();
        const importance = Number(candidate.importance);
        const tooDetailed = kind === 'detail';
        // `importance` 缺失/非法时不算「低重要性」：归一化已经在抽取侧做过，
        // 这里拿不到数字只可能是调用方少给了字段，不该凭猜测改判。
        const tooMinor = Number.isFinite(importance) && importance <= 2;
        if ((scope === 'global' || scope === 'project') && (tooDetailed || tooMinor)) {
            rerouted += 1;
            routed.push({ ...candidate, scope: 'journal' });
            continue;
        }
        routed.push(candidate);
    }
    return { candidates: routed, rerouted };
}

/**
 * **归属兜底**（P0-A）：工作区归因不到（`writeCwd === ''`，即 `_unassigned` 桶 / 注册表
 * 里没有这个桶 / 老版本写入的桶）时，静态槽候选一律改判 `journal`。
 *
 * 为什么必须拦：`scope=global` 的候选在归属未知时**照样能写进 FACT** —— 本机 FACT 里那
 * 15 行英语语法污染就是这条路径进来的（未归属批次的「通用结论」被当成全局事实）；
 * `scope=project` 则会被主插件 `assertEntry` 拒（`details.reason = project 条目缺少工作
 * 目录（cwd）`），拒完还因为 failed>0 挡住消费 ⇒ 同一批重跑十几次。
 *
 * 三条纪律（与 `routeByGranularity` 同款）：
 *  1. **不丢弃**：内容照样写，只是从「每轮全量注入的静态槽」换成 JOURNAL 事件；
 *  2. 已经是 `journal` 的原样通过（不重复计数、不改写）；
 *  3. 未知 scope 原样通过（这里只做改判，合法性交给写入侧的 `toStoreScope`）。
 *
 * @param {(string | { scope?: string })[]} candidates
 * @param {{ owned?: boolean }} [input] `owned: true` 表示工作区已归因（cwd 已知）
 * @returns {{ candidates: any[], reroutedNoOwner: number }}
 */
export function routeByOwnership(candidates = [], input = {}) {
    const items = Array.isArray(candidates) ? candidates : [];
    if (input?.owned === true) return { candidates: items, reroutedNoOwner: 0 };
    const routed = [];
    let reroutedNoOwner = 0;
    for (const candidate of items) {
        if (candidate === null || typeof candidate !== 'object') {
            routed.push(candidate);
            continue;
        }
        const scope = String(candidate.scope ?? '').trim().toLowerCase();
        if (scope === 'global' || scope === 'project') {
            reroutedNoOwner += 1;
            routed.push({ ...candidate, scope: 'journal' });
            continue;
        }
        routed.push(candidate);
    }
    return { candidates: routed, reroutedNoOwner };
}

/**
 * 静态槽条目的正文长度上限（**按字符计**，阈值 160）。
 *
 * 为什么是 160：主插件压缩器对静态槽有两条硬约束——「合并结果 ≤120 字」、
 * 「逐条精简 ≤200 字且合计必须更短、具体值不许丢」；项目 MEMORY.md 本身只有
 * 8000 字符。取这两条之间（120 / 200）的整数 160：
 *  - 给压缩器留出「改写 / 补充后仍 ≤200」的余量，不会一落盘就注定无法精简；
 *  - 又足够放下一句完整结论（中位条目只有 105 字），不误杀正常结论。
 *
 * 超过它的条目不是「更长的结论」，而是**一段编年史**（版本演进 / 实现过程 / 文件清单）：
 * 这类内容每轮全量注入会直接顶到水位上限，应该进 JOURNAL 按需召回。
 *
 * 真实背景（2026-11-12 体检）：项目 MEMORY.md 49 条长编号段落，中位 105 字、
 * 22 条 >120 字、17 条 >200 字、最长 596 字，总 7974/8000 字符 = 99.66%——
 * 压缩器对 596 字那条几乎无从下手，于是水位只涨不降。根因是格式，不是上限太小。
 */
export const MAX_STATIC_ENTRY_CHARS = 160;

/**
 * 正文长度口径：**trim 后按字符（码点）计**，不是 UTF-16 码元数。
 *
 * 为什么不用 `text.length`：那是 UTF-16 码元数，一个 emoji 会算 2 个——
 * 「160 字」是给人看的口径，中英文混排按人眼字符数才一致（`[...text]` 数码点）。
 * 对 CJK / ASCII（本项目的全部真实正文）两者完全相同，只在 emoji 之类代理对上更宽容。
 *
 * @param {unknown} text
 * @returns {number}
 */
function countContentChars(text) {
    return [...String(text ?? '').trim()].length;
}

/**
 * **长度门**（格式约束）：正文超过 {@link MAX_STATIC_ENTRY_CHARS} 字符的
 * `global` / `project` 候选**改判** `scope='journal'`。纯函数、零 LLM、零 IO。
 *
 * 三条纪律（与 `routeByGranularity` / `routeByOwnership` 同款）：
 *  1. **不丢弃、不改写正文**：内容照样写，只是从「每轮全量注入的静态槽」换成
 *     JOURNAL 事件（长条目的正文一个字都不许动，改写是第二实现的事）；
 *  2. 已经是 `journal` 的原样通过（不重复计数）；
 *  3. 未知 scope 原样通过（合法性由抽取侧 `normalizeMemories()` 与写入侧
 *     `toStoreScope()` 各自负责）。
 *
 * 顺序：接在 `routeByOwnership()` **之后**、跨池预筛**之前**。为什么放在归属之后：
 * 归属未知时 `routeByOwnership` 已经把 global/project 全部改判 journal，
 * 这里再数一遍只会让两个观测口径互相重叠（同一条被两级改判到底算谁的），
 * 且归属兜底覆盖的是**整批**、长度门只覆盖个别长条目。放在跨池之前与另外两层同口径：
 * 先改判，再让跨池去重看剩下的候选。
 *
 * @param {(string | { scope?: string, content?: string })[]} candidates
 * @param {{ maxChars?: number }} [options] `maxChars` 只给测试用（默认就是常量 160）
 * @returns {{ candidates: any[], reroutedLong: number }}
 */
export function routeByLength(candidates = [], options = {}) {
    const items = Array.isArray(candidates) ? candidates : [];
    const limit = Number.isFinite(options?.maxChars)
        ? Math.max(1, Math.trunc(Number(options.maxChars)))
        : MAX_STATIC_ENTRY_CHARS;
    const routed = [];
    let reroutedLong = 0;
    for (const candidate of items) {
        if (candidate === null || typeof candidate !== 'object') {
            routed.push(candidate);
            continue;
        }
        const scope = String(candidate.scope ?? '').trim().toLowerCase();
        if (scope !== 'global' && scope !== 'project') {
            routed.push(candidate);
            continue;
        }
        const content = typeof candidate.content === 'string' ? candidate.content : '';
        if (countContentChars(content) > limit) {
            reroutedLong += 1;
            routed.push({ ...candidate, scope: 'journal' });
            continue;
        }
        routed.push(candidate);
    }
    return { candidates: routed, reroutedLong };
}

/**
 * 候选 → 归并算子的 **importance 回填**（DESIGN §14.3）。
 *
 * 为什么要在归并之后按 `content` 回匹配：`mergeCandidates()` 的裁决有可能改写正文
 * （`op.content` 变成模型给出的最终写法），而 `importance` 是**抽取**阶段的判断，
 * 只能按正文找回去。匹配不上（正文被改写 / 空正文）就用缺省 3：写进侧车索引 50 分，
 * 与「老条目没有重要性」同档，不会把一条结论误判成核心红线。
 *
 * @param {any[]} ops
 * @param {{ content?: string, kind?: string, importance?: number }[]} candidates
 * @returns {any[]} 带 `importance` 的新算子数组（不改原对象）
 */
export function attachImportance(ops = [], candidates = []) {
    const byContent = new Map();
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
        const content = typeof candidate?.content === 'string' ? candidate.content : '';
        if (content === '') continue;
        // 同一正文出现多次时**先到先得**（闸口已按同批去重，这里只是别让后面的覆盖前面的）。
        if (!byContent.has(content)) byContent.set(content, candidate);
    }
    const list = Array.isArray(ops) ? ops : [];
    const byIndex = Array.isArray(candidates) ? candidates : [];
    return list.map((op) => {
        if (op === null || typeof op !== 'object') return op;
        /*
         * 优先级 ①：算子自带的**候选下标**（merger.mergeCandidates 在 op 上写 sourceIndex）。
         * 归并裁决会把候选正文整段改写，改写后按正文回匹配必然掉档——本机真实后果是
         * 一条 importance=5 的高优结论被模型换种措辞写进 FACT 后，在侧车索引里只剩缺省 50 分，
         * 淘汰层就按「不重要」处理它（E4 根因）。
         *
         * 优先级 ②：正文精确匹配（老口径）。L2 / 单测直接构造的算子没有下标，
         * 或者调用方给的 candidates 与算子不同源时会走到这里；再匹配不上才缺省 3。
         */
        const index = Number.isInteger(op.sourceIndex) ? op.sourceIndex : -1;
        const byPosition = index >= 0 ? byIndex[index] : undefined;
        let importance = byPosition?.importance;
        if (!Number.isFinite(importance)) {
            const content = typeof op.content === 'string' ? op.content : '';
            const matched = byContent.get(content) ?? byContent.get(content.trim());
            importance = matched?.importance;
        }
        if (Number.isFinite(importance)) return { ...op, importance: Number(importance) };
        return { ...op, importance: DEFAULT_IMPORTANCE };
    });
}

/** 一批暂存行里最近一条的会话 id（没有就空串）。 */
function lastSessionOf(rows) {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
        const session = String(rows[index]?.session ?? '').trim();
        if (session !== '') return session;
    }
    return '';
}

/** 本次消费的行按会话聚合出「最大回合 + 字符数」——游标用。 */
function cursorPatches(rows) {
    const map = new Map();
    for (const row of rows) {
        const session = typeof row.session === 'string' ? row.session : '';
        if (session === '') continue;
        const turn = Number.isFinite(row.turn) ? Math.trunc(row.turn) : 0;
        const chars = Number.isFinite(row.chars) ? Math.trunc(row.chars) : 0;
        const current = map.get(session) ?? { turn: 0, chars: 0 };
        map.set(session, { turn: Math.max(current.turn, turn), chars: current.chars + chars });
    }
    return map;
}

/**
 * 跑一个工作区桶的 L1。
 *
 * @param {{
 *   runtime: Record<string, any>,
 *   bucket: string | { workspaceId: string, title?: string, path?: string },
 *   dryRun?: boolean,
 *   now?: number,
 *   lock?: { token?: string },
 * }} input
 * @returns {Promise<{
 *   runId: string, bucket: string, title: string, turns: number, chars: number,
 *   candidates: number, ops: number, counts: Record<string, number>, calls: number,
 *   status?: string, skipped?: string, reason?: string, snapshot?: string,
 * }>}
 */
export async function runL1(input = {}) {
    const runtime = input.runtime ?? {};
    const config = runtime.config ?? {};
    const now = Number.isFinite(input.now) ? input.now : Date.now();
    // 真实耗时（墙钟）：落进 runlog 的 `durationMs`，下次判断「超时够不够」有据可依。
    const startedAt = Date.now();
    const elapsed = () => Math.max(0, Date.now() - startedAt);
    const dryRun = resolveDryRun(input.dryRun, config);
    // 影子档：`dry` 是一次性显式开关，优先于档位（老行为不变）。
    const observe = dryRun !== true && resolveMode(config) === MODE.OBSERVE;
    const runId = typeof input.runId === 'string' && input.runId !== '' ? input.runId : makeRunId(now);

    const bucket = typeof input.bucket === 'string' ? { workspaceId: input.bucket } : (input.bucket ?? {});
    const workspaceId = String(bucket.workspaceId ?? '');
    let title = typeof bucket.title === 'string' ? bucket.title : '';
    const cwd = typeof bucket.path === 'string' ? bucket.path : '';
    const dir = runtime.pendingDir ?? defaultPendingDir();

    const base = { runId, bucket: workspaceId, title, dryRun, mode: resolveMode(config), observe };
    const skip = (skipped, reason, extra = {}) => ({
        ...base,
        turns: 0,
        chars: 0,
        candidates: 0,
        ops: 0,
        counts: emptyCounts(),
        calls: 0,
        skipped,
        reason,
        ...extra,
    });

    /* ① 读未消费行（纯本地，读不到就跳过） */
    const rows = pending.readUnconsumed({ pendingDir: dir, bucket: workspaceId });
    const stats = pending.summarize(rows);
    if (rows.length === 0) return skip('empty', 'no-unconsumed-rows');

    /*
     * 项目归属（0.1.2）：桶本身没带 cwd（`_unassigned`、注册表被删、老版本写入的桶）
     * 时，从暂存行的 cwd 反查工作区。**只有整批行指向同一个工作区才认**——
     * 未分组桶里可能混着多个项目，硬写一份项目记忆就是造假。
     * 用 `writeCwd` 去定位 MEMORY.md；桶身份（读行/标记消费/游标）仍用 `workspaceId`。
     */
    let writeCwd = cwd;
    let writeWorkspaceId = workspaceId;
    let writeTitle = title;
    if (writeCwd === '') {
        const registry = runtime.registry ?? loadRegistry(runtime.registryFile);
        const resolved = resolveRowsWorkspace(registry, rows);
        if (resolved !== null) {
            writeCwd = resolved.path;
            writeWorkspaceId = resolved.workspaceId;
            writeTitle = resolved.title || title;
        }
    }
    if (writeTitle !== title) {
        title = writeTitle;
        base.title = writeTitle;
    }

    /* ② 消费门槛（先到先算：≥minTurns 或 ≥minChars） */
    const verdict = decideConsume({
        pendingTurns: stats.turns,
        pendingChars: stats.chars,
        cooldownUntil: typeof runtime.budget?.cooldownUntil === 'function' ? runtime.budget.cooldownUntil() : 0,
        now,
        config,
    });
    if (verdict.consume !== true) {
        return skip('below-threshold', verdict.reason, { turns: stats.turns, chars: stats.chars });
    }

    /* 模型没接线时提前退出：不占预算、不写快照（M1 由命令触发时才会接线） */
    if (typeof runtime.extractor?.extract !== 'function') {
        const summary = skip('no-model', 'model-not-wired', { turns: stats.turns, chars: stats.chars });
        runtime.runLog?.append({
            runId, phase: 'layer1', status: STATUS.FAIL, reason: 'model-not-wired',
            detail: 'runtime.extractor 为空：prepare() 还没接线（命令执行时才会接）',
            durationMs: elapsed(), workspaceId, turns: 0, chars: 0,
        }, now);
        return { ...summary, status: STATUS.FAIL };
    }

    /* ③ 全局单飞 + 第一层预算（runAllBuckets 已持锁时直接复用） */
    const inheritedToken = typeof input.lock?.token === 'string' ? input.lock.token : '';
    const ownsLock = inheritedToken === '';
    let token = inheritedToken;
    if (ownsLock) {
        const started = typeof runtime.budget?.tryStart === 'function' ? runtime.budget.tryStart(PHASE_LAYER1) : { ok: true, token: '' };
        if (started.ok !== true) return skip('budget', started.reason ?? 'budget-unavailable');
        token = started.token;
    }

    let ok = false;
    try {
        const result = await execute();
        ok = result.status !== STATUS.FAIL;
        return result;
    } catch (error) {
        // 管线自己出错也绝不吞成「成功」：写 runlog 记 FAIL，行保持未消费。
        const reason = codeOf(error, 'pipeline-error');
        runtime.runLog?.append({
            runId, phase: 'layer1', status: STATUS.FAIL, reason,
            detail: detailOfError(error) || reason,
            durationMs: elapsed(), workspaceId, turns: 0, chars: 0,
        }, now);
        return { ...skip('error', reason), status: STATUS.FAIL, turns: stats.turns, chars: stats.chars };
    } finally {
        if (ownsLock && token !== '') runtime.budget?.settle?.(token, { ok, now });
    }

    /** 真正干活的那一段（放在 try/finally 里，保证预算一定被 settle）。 */
    async function execute() {
        /* ④ 取最后 maxTurnsPerCall 行（最新结论才是这轮沉淀的目标） */
        const maxTurns = Number.isFinite(config.maxTurnsPerCall) ? Math.max(1, Math.trunc(config.maxTurnsPerCall)) : 6;
        const picked = rows.slice(-maxTurns);
        const conversation = buildConversation(picked);

        /* ⑤ 解析 store + 读现有池（项目 MEMORY.md 走 cwd 定位） */
        let store = null;
        try {
            store = typeof runtime.resolveStore === 'function' ? await runtime.resolveStore() : (runtime.store ?? null);
        } catch {
            store = null;
        }
        if (store === null || store === undefined) {
            runtime.runLog?.append({
                runId, phase: 'layer1', status: STATUS.FAIL, reason: 'store-unavailable',
                detail: 'runtime.resolveStore() 返回空：主插件 store 没装上或解析失败',
                durationMs: elapsed(), workspaceId, turns: 0, chars: 0,
            }, now);
            return { ...skip('store-unavailable', 'store-unavailable'), status: STATUS.FAIL };
        }

        // 抽取提示词里的「目标格式」来自主插件 —— 不在这里硬编码条目模板（00 §4.1 拍板）。
        if (typeof store.templates === 'function') {
            try {
                runtime.templatesCache = store.templates();
            } catch {
                runtime.templatesCache = null;
            }
        }
        /*
         * 归并池：本次运行**只读一次**（跨池去重与归并裁决共用同一份池，别每条候选再读盘）。
         * 池构建本身炸了（例如 store.entryId 抛错）不能让整次沉淀失败：按空池继续，
         * 归并使不出 UPDATE、跨池闸口不生效，但**写入照常**——门控是提纯，不是写入门槛。
         * 降级原因进 runlog 的 `detail`，不静默。
         */
        let pool = [];
        let poolError = '';
        try {
            pool = buildPool(store, textOf(store, pathOf(store, 'factPath')), textOf(store, projectMemoryPathOf(store, writeCwd)));
        } catch (error) {
            poolError = codeOf(error, 'pool-build-error');
        }

        /* ⑥ 抽取：一次调用；非法 JSON 整次放弃（不重试、行保留） */
        let extraction;
        try {
            extraction = await runtime.extractor.extract({
                conversation,
                scope: config.scope,
                // 会话归因：取本次素材里最近一行的 session（宿主拿它做日志/计量归属）。
                sessionId: lastSessionOf(picked),
                // 归属兜底（P0-A）：把**真实**工作目录写进提示词。空串 = 未归属，
                // 抽取侧会把这种批次一律收窄成 scope=journal（不再产出 global / project）。
                cwd: writeCwd,
            });
        } catch (error) {
            extraction = {
                ok: false,
                reason: 'model-error',
                code: codeOf(error, 'model-error'),
                detail: detailOfError(error),
                memories: [],
                ops: [],
                rejects: [],
            };
        }
        /*
         * 真实调用次数：抽取器现在自己记账（正常 1、截断重试 2、没接线 0）。
         * **不能再写死 1**：截断重试是真花了一次钱，预算与 runlog 都必须认账（DESIGN §13）。
         */
        const modelCalls = Number.isFinite(extraction.calls)
            ? Math.max(0, Math.trunc(extraction.calls))
            : (extraction.reason === 'no-model' ? 0 : 1);
        /**
         * 补扣预算：`tryStart` 已经按「一次调用」扣过 1 次，多出来的（抽取重试 / 裁决）
         * 在这里补扣。补扣**不占锁、不看上限**（那是已经花掉的钱）。
         */
        const chargeExtra = (totalCalls) => {
            const extra = totalCalls - 1;
            if (extra > 0 && typeof runtime.budget?.charge === 'function') runtime.budget.charge(PHASE_LAYER1, extra);
        };
        if (extraction.ok !== true) {
            chargeExtra(modelCalls);
            // 错误码**非空**才拼进 reason（空串一律当缺失，见 `llm.codeOf`）——本机 35/35
            // 只看到裸 `extract-model-error` 就是这里被空 code 吞掉的。
            const code = codeOf(extraction, '');
            const reason = `extract-${extraction.reason}${code === '' ? '' : `:${code}`}`;
            // `detail` 是「为什么失败」的唯一可读证据（错误消息 + finish 形状，已脱敏截断）。
            const detail = String(extraction.detail ?? '') !== ''
                ? String(extraction.detail)
                : `reason=${String(extraction.reason ?? 'unknown')}`;
            runtime.runLog?.append({
                runId, phase: 'layer1', status: STATUS.FAIL, reason, detail,
                durationMs: elapsed(), workspaceId, turns: picked.length, chars: stats.chars, calls: modelCalls,
            }, now);
            return {
                ...skip('extract-failed', extraction.reason),
                turns: picked.length,
                chars: stats.chars,
                calls: modelCalls,
                status: STATUS.FAIL,
            };
        }

        /*
         * ⑥b 确定性写入闸口（零 LLM、纯函数）：抽取结果落盘前先过滤
         *    空壳/占位（「暂无」「见上」）、过程叙述（「我先」「然后」）、长度 < 8、
         *    同批精确重复、状态断言缺时点。被丢的**不静默**：`gate.dropped` 与
         *    按原因的分类计数进 runlog 的 `gate` 字段、命令报告与返回值（A-npm-leaders 第 6、7 条）。
         *
         *    `config.gateEnabled === false` ⇒ **整批放行**，并且 runlog **不写** `gate` 字段：
         *    「闸口没启用」与「启用了但一条都没拦」是两件事，靠 `dropped:0` 分不开。
         *    这是线上误杀时的一键开关（改设置，不必改代码）。
         */
        const gated = gateBatch(extraction.memories, { enabled: config.gateEnabled !== false });
        const gate = gated.disabled === true ? undefined : gated.counts;

        /*
         * ⑥b2 结论 / 细节分层（DESIGN §14.2，硬要求）：纯函数、零 LLM、零 IO。
         *
         * `kind=detail` 或 `importance<=2` 的候选**改判** `scope='journal'`：
         * 不丢弃、不计闸口丢弃。为什么要单独一层：静态槽（FACT / 项目 MEMORY 每轮全量
         * 注入）只该放「换个话题仍然成立」的结论；毫秒数、函数名这类实现细节读一次代码
         * 就知道，占着静态槽是纯噪音，而闸口只挡格式噪音、挡不住「粒度过细」。
         *
         * 顺序固定为 gateBatch → 本层 → 跨池预筛（契约写的顺序，别调换）：
         * 先让闸口丢掉空壳（那些不该被统计成「改判」），再让跨池去重看剩下的候选。
         */
        const routed = routeByGranularity(gated.kept);
        const rerouted = routed.rerouted;

        /*
         * ⑥b3 归属兜底（P0-A）：`writeCwd === ''` 说明这批素材没归到任何工作区
         * （`_unassigned` 桶 / 注册表里查不到 / 老版本写入）。此时 `global` 候选**不能**
         * 写进全局 FACT（未归属批次的「通用结论」正是 FACT 污染的来源），`project` 候选
         * 会被主插件拒。两者一律改判 JOURNAL：不丢弃、不占静态槽、不触发拒绝。
         *
         * 顺序仍在跨池预筛**之前**（与分层同口径）：先改判，再让跨池去重看剩下的候选。
         */
        const ownership = routeByOwnership(routed.candidates, { owned: writeCwd !== '' });
        const reroutedNoOwner = ownership.reroutedNoOwner;

        /*
         * ⑥b4 长度门（格式约束，纯函数）：正文 >160 字符的 global / project 候选改判
         * JOURNAL（不丢弃、不改写正文）。为什么要有这一层：压缩器要求「合并 ≤120 字 /
         * 逐条 ≤200 字且合计更短」，而 596 字那种「一段版本演进史」根本没法通过——
         * 水位只涨不降、最后必然超限。根因是格式，所以拦在写侧。
         *
         * 顺序：在归属兜底**之后**（未归属批次已经被整体改判，别让两级计数重叠）、
         * 跨池预筛**之前**（先改判，再让去重看剩下的候选）。
         */
        const lengthGate = routeByLength(ownership.candidates);
        const reroutedLong = lengthGate.reroutedLong;

        /*
         * ⑥c 跨池近重复预筛（DESIGN §5）：拿本次运行开头读到的池（`pool`，只读一次），
         *    把「与已有条目完全相同 / 相似度 ≥ 0.95」的候选在**归并之前**丢掉，
         *    并计入 gate 的 `near-duplicate`。`[0.45, 0.95)` 的 ADJUDICATE 一律放行
         *    （宁可漏杀不可误杀：那个区间是「改写 / 补充」，交归并去问模型）。
         *
         *    降级纪律：
         *      - 池为空 / 打分抛错 ⇒ 放行（门控坏掉不能阻断写入）；
         *      - `gateEnabled === false` ⇒ 整层确定性过滤关掉（`near-duplicate` 也是 gate
         *        的分类计数；关了闸口却还偷偷丢条目，就违背了「一键整批放行」）；
         *      - 只想单独关跨池用 `crossPoolDedup: false`（同批去重 / 空壳过滤照旧）。
         */
        let keptBeforeMerge = lengthGate.candidates;
        let screeningError = poolError;
        if (gate !== undefined && config.crossPoolDedup !== false) {
            const screened = screenCrossPool(lengthGate.candidates, pool);
            keptBeforeMerge = screened.kept;
            if (screened.error !== null) screeningError = screened.error.code;
            if (screened.dropped.length > 0) {
                // 账要平：`kept + dropped === total`，否则运行报告里的数字自相矛盾。
                const count = screened.dropped.length;
                gate[GATE_REASON.NEAR_DUPLICATE] += count;
                gate.dropped += count;
                gate.kept = Math.max(0, gate.kept - count);
            }
        }

        const scope = config.scope === 'journal' ? 'journal' : '';
        // `kind` / `importance` 必须一路带下去：前者只用于 `layers` 观测，
        // 后者要经归并回填进算子、最终由 writer 交给主插件写进侧车索引（DESIGN §14.3）。
        const candidates = keptBeforeMerge.map((memory) => ({
            content: memory.content,
            scope: scope === '' ? memory.scope : scope,
            confidence: memory.confidence ?? 'medium',
            kind: memory.kind === 'detail' ? 'detail' : 'conclusion',
            importance: Number.isFinite(memory.importance) ? Number(memory.importance) : DEFAULT_IMPORTANCE,
            ts: now,
        }));

        /*
         * `layers`（DESIGN §14.2，只做观测）：`conclusion` / `detail` 按**候选最终 kind**
         * 计数，`rerouted` 是分层那一步改判进 JOURNAL 的条数。
         *
         * 注意 `rerouted` / `reroutedNoOwner` 可能大于「最终仍以 journal 写入的条数」：
         * 改判之后还有跨池预筛，被判成近重复的会被拦掉。这是不同阶段的计数，
         * **不要求相加平账**（闸口的 `kept + dropped = total` 才要求平账）。
         *
         * `reroutedNoOwner`（P0-A）是**归属兜底**改判的条数；`reroutedLong` 是**长度门**
         * 改判的条数。两者都只在真的发生（>0）时落盘，老口径的三键记录形状保持不变
         * （`runlog` 白名单见 `LAYER_FIELDS`）。
         */
        const layers = { conclusion: 0, detail: 0, rerouted };
        if (reroutedNoOwner > 0) layers.reroutedNoOwner = reroutedNoOwner;
        if (reroutedLong > 0) layers.reroutedLong = reroutedLong;
        for (const candidate of candidates) {
            if (candidate.kind === 'detail') layers.detail += 1;
            else layers.conclusion += 1;
        }

        if (candidates.length === 0) {
            // 抽取成功但没结论：**不标记消费**（回合还有价值，下次门槛达标会再抽一次），
            // 也不写盘。闸口丢光时也一样，但必须让「为什么没写」在 runlog 里看得见。
            chargeExtra(modelCalls);
            const reason = gate !== undefined && gate.dropped > 0 ? 'gate-dropped' : 'nothing-worth-remembering';
            runtime.runLog?.append({
                runId, phase: 'layer1', status: STATUS.NOOP, reason,
                workspaceId, turns: picked.length, chars: stats.chars, calls: modelCalls, gate, layers,
            }, now);
            return {
                ...skip('no-candidates', reason),
                turns: picked.length,
                chars: stats.chars,
                calls: modelCalls,
                status: STATUS.NOOP,
                gate,
                layers,
            };
        }

        /* ⑦ 归并：预筛（纯 BM25）→ 只有落在 [0.45,0.95) 的才追加一次裁决调用 */
        let extraCalls = 0;
        const countingModel = typeof runtime.callModel === 'function'
            ? async (request) => {
                extraCalls += 1;
                return runtime.callModel(request);
            }
            : undefined;

        const merged = await mergeCandidates({
            candidates,
            pool,
            layer: 1,
            callModel: countingModel,
            provider: config.provider,
            model: config.model,
            maxOps: 8,
        });
        const calls = modelCalls + extraCalls;
        // 预算按**真实发出的调用数**记账：占锁时已经扣了 1 次（= 抽取那一次），
        // 多出来的裁决调用 / 截断重试在这里补扣 —— 日配额 60 说的是「调用次数」，
        // 不是「运行次数」。
        chargeExtra(calls);

        if (merged.ok !== true) {
            runtime.runLog?.append({
                runId, phase: 'layer1', status: STATUS.FAIL, reason: `merge-${merged.reason}`,
                detail: `merge=${String(merged.reason ?? 'unknown')}`,
                durationMs: elapsed(), workspaceId, turns: picked.length, chars: stats.chars, calls, gate, layers,
            }, now);
            return {
                ...skip('merge-failed', merged.reason),
                turns: picked.length,
                chars: stats.chars,
                candidates: candidates.length,
                calls,
                status: STATUS.FAIL,
                gate,
                layers,
            };
        }

        /* ⑧ 写前快照（dryRun / observe 不建：这两档都不改记忆文件，快照只会堆垃圾）
           → 执行算子（撞限由 writer 降级 JOURNAL） */
        const snapshot = snapshotFiles({ runId, store, cwd: writeCwd, dryRun: dryRun === true || observe, now });
        // UPDATE 要把被覆盖的旧值交给 writer 写进 superseded.jsonl（只审计，不进
        // JOURNAL / 不进第二层）。旧值只存在于 pool 里，所以在这里按 target 取回来。
        const poolById = new Map(pool.map((entry) => [entry.id, entry]));
        // `importance` 按 `content` 回填（归并裁决可能改写正文；匹配不上用缺省 3）。
        const writeOps = attachImportance(merged.ops, candidates).map((op) => {
            if (op?.op !== 'UPDATE' || typeof op.target !== 'string' || op.target === '') return op;
            const old = poolById.get(op.target);
            return old === undefined ? op : { ...op, superseded: { id: old.id, text: old.text } };
        });
        const write = await runtime.writer.apply(writeOps, { cwd: writeCwd, workspaceId: writeWorkspaceId, dryRun, mode: observe ? MODE.OBSERVE : undefined, layer: 1, runId, now });

        const counts = { ...emptyCounts(), ...write.counts };
        counts.candidates = candidates.length;
        counts.ops = merged.ops.length;

        /*
         * ⑨ 消费判定（P0-B）：只看**可重试失败**，不再用 `failed > 0`。
         *
         * 主插件的永久拒绝（`demote:'drop'`）重试一万次还是同一个结果：拿它挡消费等于把
         * 同一批素材永久钉在暂存区（本机 9 行 / 5323 字符重跑 13 次、25 次调用）。
         * 临时失败（LLM 错误 / 超时 / 写盘 IO）相反——必须挡住，下一轮重试才有意义。
         */
        let marked = { marked: 0, archived: 0, files: 0 };
        const retryableFailures = (write.results ?? []).filter((item) => isRetryableFailure(item)).length;
        const succeeded = retryableFailures === 0;
        if (dryRun !== true && succeeded && picked.length > 0) {
            marked = pending.markConsumed({
                pendingDir: dir,
                bucket: workspaceId,
                turns: picked.map((row) => ({ session: row.session, turn: row.turn })),
                now,
            });
            const cursorFile = runtime.cursorFile ?? cursorPath();
            const cursor = readCursor(cursorFile);
            for (const [session, patch] of cursorPatches(picked)) {
                setSessionCursor(cursor, workspaceId, session, { turn: patch.turn, chars: patch.chars, at: now });
            }
            writeCursor(cursor, cursorFile, now);
        }

        // 影子档：没写盘，但也不能算成功（`OK` 会被统计成「真实写入成功」）。
        // 永久拒绝仍记 FAIL：内容确实少写了一条，**不许假装成功**——但它不挡消费
        //（消费口径是 `succeeded`，只看可重试失败；两者刻意分开）。
        const status = dryRun === true
            ? STATUS.DRY
            : (counts.failed > 0 ? STATUS.FAIL : (observe === true ? STATUS.OBSERVED : STATUS.OK));
        // 写入失败时把**原因**带出来（writer 已经在 result.reason 里给了，别在 runlog 里只剩 FAIL）。
        const failedReasons = (write.results ?? [])
            .filter((item) => String(item?.status ?? '') === 'failed')
            .map((item) => String(item?.reason ?? 'failed'))
            .slice(0, 3);
        // 主插件闸口把条目降级进 JOURNAL 的原因（P0-B）：内容没进静态槽但也没丢，
        // 必须留痕，否则「为什么这条在 JOURNAL 里」只能靠猜。
        const demotedReasons = (write.results ?? [])
            .filter((item) => String(item?.status ?? '') === 'demoted' && String(item?.reason ?? '').startsWith('store-rejected:'))
            .map((item) => String(item?.reason ?? ''))
            .slice(0, 3);
        // `detail` 是「为什么这次结果不完美」的唯一可读证据：写失败的 store 原因之外，
        // 跨池预筛坏掉（放行但没检查）也要留痕——门控降级不能是隐形的。
        const detailBits = [];
        // 这轮是「截断后救回来的」：不写进 detail 的话，状态是 OK、人完全看不出
        // 输出上限已经不够用了（下一次可能就救不回来）。两种补救必须能分辨：
        // `salvage:` = 拿已收到的正文补括号救回来；`retry:` = 降推理等级重跑一次成功。
        if (extraction.truncated === true) {
            detailBits.push(extraction.retry === 'max-tokens' ? 'retry:max-tokens' : 'salvage:max-tokens');
        }
        if (screeningError !== '') detailBits.push(`gate:${screeningError}`);
        if (demotedReasons.length > 0) detailBits.push(`demoted:${demotedReasons.join(' | ')}`);
        if (failedReasons.length > 0) detailBits.push(`writer:${failedReasons.join(' | ')}`);
        /* ⑩ runlog：只写结构化摘要（正文一个字都不进） */
        runtime.runLog?.append({
            runId,
            phase: 'layer1',
            status,
            reason: merged.reason === 'ok' ? (dryRun === true ? 'dry-run' : (observe === true ? 'observe' : 'ok')) : merged.reason,
            detail: detailBits.length > 0 ? detailBits.join(' | ') : undefined,
            durationMs: elapsed(),
            workspaceId,
            // 项目归属被路径解析重定向时的真实工作区（排查「写到哪个 MEMORY.md」用）。
            projectWorkspaceId: writeWorkspaceId === workspaceId ? undefined : writeWorkspaceId,
            bucket: title === '' ? workspaceId : title,
            turns: picked.length,
            chars: stats.chars,
            calls,
            counts,
            gate,
            layers,
            watermarks: write.watermarks,
        }, now);

        return {
            ...base,
            projectWorkspaceId: writeWorkspaceId,
            turns: picked.length,
            chars: stats.chars,
            candidates: candidates.length,
            ops: merged.ops.length,
            counts,
            gate,
            layers,
            calls,
            marked,
            snapshot: snapshot.dir,
            status,
            watermarks: write.watermarks,
            wouldWrite: write.wouldWrite ?? null,
        };
    }
}

/**
 * 逐桶跑一遍 L1（02 §7.6「L2 逐桶」同款口径：桶之间**绝不聚合**）。
 *
 * 为什么全局只占一次锁：`maxConcurrent` 默认 1，若每个桶各 `tryStart` 一次，
 * 第二个桶一定拿到 `concurrency-limit` ⇒ 一次命令只能沉淀一个桶。
 *
 * @param {{ runtime: Record<string, any>, dryRun?: boolean, now?: number, runId?: string }} input
 * @returns {Promise<{
 *   runId: string, dryRun: boolean, runs: any[], skipped?: string, reason?: string,
 * }>}
 */
export async function runAllBuckets(input = {}) {
    const runtime = input.runtime ?? {};
    const now = Number.isFinite(input.now) ? input.now : Date.now();
    const config = runtime.config ?? {};
    const dryRun = resolveDryRun(input.dryRun, config);
    const mode = resolveMode(config);
    const observe = dryRun !== true && mode === MODE.OBSERVE;
    const runId = typeof input.runId === 'string' && input.runId !== '' ? input.runId : makeRunId(now);
    const dir = runtime.pendingDir ?? defaultPendingDir();

    const registry = runtime.registry ?? loadRegistry(runtime.registryFile);
    const buckets = [];
    for (const entry of listPendingBuckets(dir)) {
        const rows = pending.readUnconsumed({ pendingDir: dir, bucket: entry.workspaceId });
        if (rows.length === 0) continue; // 空桶直接跳过，不占预算
        buckets.push(bucketInfo(registry, entry.workspaceId, { unassigned: config.unassignedBucket }));
    }
    if (buckets.length === 0) return { runId, dryRun, mode, observe, runs: [], skipped: 'empty', reason: 'no-pending-rows' };

    const started = typeof runtime.budget?.tryStart === 'function' ? runtime.budget.tryStart(PHASE_LAYER1) : { ok: true, token: '' };
    if (started.ok !== true) return { runId, dryRun, mode, observe, runs: [], skipped: 'budget', reason: started.reason };

    const runs = [];
    let ok = false;
    try {
        for (const bucket of buckets) {
            runs.push(await runL1({ runtime, bucket, dryRun, now, runId, lock: started }));
        }
        // 影子运行没写盘，「成功」口径按「没出 FAIL」；OBSERVED 不算 FAIL。
        ok = runs.every((run) => run.status !== STATUS.FAIL);
        return { runId, dryRun, mode, observe, runs };
    } finally {
        if (started.token !== '') runtime.budget?.settle?.(started.token, { ok, now });
    }
}
