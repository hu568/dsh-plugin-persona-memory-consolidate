/**
 * Windows 上 `renameSync` 会偶发 EPERM/EBUSY（杀毒、索引器或另一个句柄短暂占着
 * 目标文件）。原子写的正确性依赖 rename，所以这里做有限次同步重试：
 * 只在**可恢复的**错误码上重试，其它错误立即上抛，绝不吞掉真实失败。
 *
 * 为什么用 `Atomics.wait` 而不是 `setTimeout`：写入路径是同步 API（pending /
 * cursor / store 都在同步事务里），不能为了等 5ms 把调用方改成异步。最坏总等待
 * 约 87ms，且只在这类偶发错误上发生。
 */

import { renameSync } from 'node:fs';

const DELAYS_MS = [2, 5, 10, 20, 50];
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);

function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {void}
 */
export function renameWithRetry(from, to) {
    for (let attempt = 0; ; attempt += 1) {
        try {
            renameSync(from, to);
            return;
        } catch (error) {
            const transient = TRANSIENT.has(error?.code);
            if (!transient || attempt >= DELAYS_MS.length) throw error;
            sleepSync(DELAYS_MS[attempt]);
        }
    }
}
