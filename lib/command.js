/**
 * `/memory-consolidate <子命令>` 的**纯解析**（不读盘、不碰 ctx）。
 *
 * 子命令表来自 02 §6.0：`run｜dry｜cross｜rollback`。
 * 另外加了 `status`（只读，默认）：用户敲 `/memory-consolidate` 不带参数时，
 * 最有用的是「现在攒了多少、下次什么时候跑」，而不是一段用法报错。
 */

/** 已知子命令。 */
export const SUBCOMMANDS = ['status', 'dry', 'run', 'cross', 'rollback'];
/** 不带参数时的默认子命令。 */
export const DEFAULT_SUBCOMMAND = 'status';

/**
 * 解析命令输入。
 *
 * @param {string} [rawInput] 斜杠命令后面的原文。
 * @returns {{ subcommand: string, args: string[], known: boolean, raw: string }}
 */
export function decodeCommand(rawInput) {
    const raw = typeof rawInput === 'string' ? rawInput.trim() : '';
    if (raw === '') return { subcommand: DEFAULT_SUBCOMMAND, args: [], known: true, raw };
    const parts = raw.split(/\s+/u).filter((part) => part !== '');
    const subcommand = (parts[0] ?? '').toLowerCase();
    return {
        subcommand,
        args: parts.slice(1),
        known: SUBCOMMANDS.includes(subcommand),
        raw,
    };
}

/** 用法提示（解析失败时给用户看）。 */
export const USAGE = '用法：/memory-consolidate [status|dry|run|cross [dry]|rollback <runId|last>]';
