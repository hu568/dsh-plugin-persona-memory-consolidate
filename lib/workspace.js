/**
 * 工作区归属：把会话落进哪个桶（02 §7.0 拍板 #13）。
 *
 * 键是 **DSH 工作区 ID（UUID），不按 .git / cwd 推断**：
 *  - 没有 `.git` 的目录会被拆成互不相干的桶；
 *  - 用户在侧栏**手动改过的工作区边界**（一个工作区可含多个目录，也可能只是某个子目录）
 *    用路径推不出来；
 *  - 工作区有稳定 UUID 和可改标题，天然是「记忆归属」的正确身份。
 *
 * 注册表是宿主**私有 v2 存储格式**（`$DSH_HOME/storages/workspace.json`）：
 *
 *   { tables: { workspaces: { "<workspaceId>": { path, title, sessionIds[], ... } } } }
 *
 * 解析失败一律整体降级 `_unassigned`，**绝不抛错、绝不阻塞主流程**（02 §11 风险表）。
 *
 * 为什么必须能在没注册表的情况下工作：实测本机 9 个工作区只登记了 216 个 sessionId，
 * 而磁盘上有 463 个会话文件 ⇒ 大量会话本来就没有归属，「未分组」不是异常而是常态。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dshHome } from './cursor.js';
import { checkBucketScope } from './validate.js';

/** 未分组桶名（与 `config.unassignedBucket` 默认值一致）。 */
export const UNASSIGNED_BUCKET = '_unassigned';
/** 未分组桶的显示标题。 */
export const UNASSIGNED_TITLE = '未分组';

/** 宿主注册表的默认路径。 */
export function defaultRegistryPath(home = dshHome()) {
    return join(home, 'storages', 'workspace.json');
}

/** `sessionIds` 归一成去重后的字符串数组（宿主的数组里不会有意外的值，但手改过就会）。 */
function normalizeSessionIds(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const item of raw) {
        if (typeof item !== 'string') continue;
        const id = item.trim();
        if (id === '' || out.includes(id)) continue;
        out.push(id);
    }
    return out;
}

/**
 * 读工作区注册表。**永不抛**：文件缺失、坏 JSON、结构不对、单个工作区坏掉，
 * 都退化成「没有这个工作区」。
 *
 * @param {string} [file] 默认 `$DSH_HOME/storages/workspace.json`。
 * @returns {{ workspaces: Record<string, { path: string, title: string, sessionIds: string[] }> }}
 */
export function loadRegistry(file = defaultRegistryPath()) {
    let raw;
    try {
        raw = readFileSync(file, 'utf8');
    } catch {
        return { workspaces: {} };
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { workspaces: {} };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { workspaces: {} };

    // 宿主形状 `tables.workspaces`；同时容忍已经拍平的 `{workspaces}`（单测/未来版本）。
    const table = parsed?.tables?.workspaces ?? parsed.workspaces;
    if (table === null || typeof table !== 'object' || Array.isArray(table)) return { workspaces: {} };

    const workspaces = {};
    for (const [workspaceId, entry] of Object.entries(table)) {
        if (typeof workspaceId !== 'string' || workspaceId === '') continue;
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
        workspaces[workspaceId] = {
            path: typeof entry.path === 'string' ? entry.path : '',
            title: typeof entry.title === 'string' ? entry.title : '',
            sessionIds: normalizeSessionIds(entry.sessionIds),
        };
    }
    return { workspaces };
}

/**
 * 反查某会话所属的工作区。
 *
 * 为什么是线性扫（O(工作区数 × sessionIds)）：本机只有 9 个工作区 / 216 个 sessionId，
 * 一次反查是微秒级；给它建反向索引反而多一份会跟注册表不一致的缓存。
 *
 * @param {ReturnType<typeof loadRegistry>} registry
 * @param {string} sessionId
 * @returns {{ workspaceId: string, title: string, path: string } | null}
 */
export function workspaceForSession(registry, sessionId) {
    const wanted = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (wanted === '') return null;
    const workspaces = registry?.workspaces;
    if (workspaces === null || typeof workspaces !== 'object') return null;

    for (const [workspaceId, entry] of Object.entries(workspaces)) {
        if (!Array.isArray(entry?.sessionIds) || !entry.sessionIds.includes(wanted)) continue;
        return {
            workspaceId,
            title: typeof entry.title === 'string' ? entry.title : '',
            path: typeof entry.path === 'string' ? entry.path : '',
        };
    }
    return null;
}

/**
 * 会话 → 桶（查不到就 `_unassigned`）。
 *
 * @param {ReturnType<typeof loadRegistry>} registry
 * @param {string} sessionId
 * @param {{ unassigned?: string }} [options] 未分组桶名（默认 `_unassigned`）。
 * @returns {{ workspaceId: string, title: string, path: string }}
 */
export function bucketForSession(registry, sessionId, options = {}) {
    const unassigned = typeof options.unassigned === 'string' && options.unassigned.trim() !== ''
        ? options.unassigned.trim()
        : UNASSIGNED_BUCKET;

    const found = workspaceForSession(registry, sessionId);
    if (found !== null) return found;
    return { workspaceId: unassigned, title: UNASSIGNED_TITLE, path: '' };
}

/**
 * 取某个桶的元信息（`runAllBuckets` 用：它手里只有桶名，需要标题与 cwd）。
 *
 * 与 `bucketForSession` 的区别：这里**不查会话**，直接按 workspaceId 找；
 * 找不到（注册表里被删了 / `_unassigned`）就给空 path —— 空 path 的后果是
 * `scope=project` 的条目会被 `checkBucketScope` / store 闸口拦下，绝对不会写错目录。
 *
 * @param {ReturnType<typeof loadRegistry>} registry
 * @param {string} workspaceId
 * @param {{ unassigned?: string }} [options]
 * @returns {{ workspaceId: string, title: string, path: string }}
 */
export function bucketInfo(registry, workspaceId, options = {}) {
    const id = typeof workspaceId === 'string' ? workspaceId.trim() : '';
    const unassigned = typeof options.unassigned === 'string' && options.unassigned.trim() !== ''
        ? options.unassigned.trim()
        : UNASSIGNED_BUCKET;
    if (id === '' || id === unassigned) return { workspaceId: unassigned, title: UNASSIGNED_TITLE, path: '' };

    const entry = registry?.workspaces?.[id];
    if (entry === undefined || entry === null) return { workspaceId: id, title: '', path: '' };
    return {
        workspaceId: id,
        title: typeof entry.title === 'string' ? entry.title : '',
        path: typeof entry.path === 'string' ? entry.path : '',
    };
}

/**
 * `scope=project` 的写入断言（02 §7.0 表最后一行）。
 *
 * 单独包一层是为了让调用方不必知道 `validate.checkBucketScope` 的参数形状：
 * `project` 必须有真实 workspaceId，且**不能**是 `_unassigned`
 * （未分组会话很多，把它们混成一个「项目」等于造假记忆）。
 *
 * @param {string} scope `global` | `project` | `journal`
 * @param {string | { workspaceId?: string }} bucket 桶名或桶对象
 * @param {{ unassigned?: string }} [options]
 * @returns {{ ok: boolean, reason: string }}
 */
export function assertProjectScope(scope, bucket, options = {}) {
    const workspaceId = typeof bucket === 'string' ? bucket : String(bucket?.workspaceId ?? '');
    const unassigned = typeof options.unassigned === 'string' && options.unassigned.trim() !== ''
        ? options.unassigned.trim()
        : UNASSIGNED_BUCKET;
    return checkBucketScope(scope, { bucket: workspaceId, unassignedBucket: unassigned });
}
