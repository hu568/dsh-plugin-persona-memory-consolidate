/**
 * 极简 BM25（Okapi），零依赖。
 *
 * ⚠️ **本文件是 `@dsh-external/dsh-persona-memory-recall` 的 `lib/bm25.js` 的逐字副本。**
 * 00 §5.1 拍板：BM25 复制一份到附属插件，不做共享包、不改 recall 的 exports
 * （代码仅 70 行、算法稳定；共享包维护成本更高）。配套的 `test/bm25-parity.test.mjs`
 * 用 file:// 直接 import 兄弟仓库里**真实的那份**，对同一语料断言打分逐位相同——
 * 任何一边改了分词口径或公式，对照测试立刻红。
 *
 * 只有两个可调参数：k1 控制词频饱和，b 控制长度归一化。
 * 语料是日志/记忆条目（长度差异大），b 用常见的 0.75。
 */

const K1 = 1.2;
const B = 0.75;

/**
 * 建倒排。
 *
 * @param {string[][]} tokenLists 每个片段一份 token 列表（保留重复）。
 * @returns {{ docs: { tf: Map<string, number>, len: number }[], df: Map<string, number>, N: number, avgdl: number }}
 */
export function buildIndex(tokenLists) {
    const docs = [];
    const df = new Map();
    let totalLength = 0;

    for (const tokens of tokenLists) {
        const tf = new Map();
        for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
        for (const token of tf.keys()) df.set(token, (df.get(token) ?? 0) + 1);
        docs.push({ tf, len: tokens.length });
        totalLength += tokens.length;
    }

    const N = docs.length;
    return {
        docs,
        df,
        N,
        avgdl: N === 0 ? 0 : totalLength / N,
    };
}

/**
 * 给全部片段打分，返回按分数降序的 `{ index, score }`（只含 score > 0）。
 *
 * @param {{ docs: { tf: Map<string, number>, len: number }[], df: Map<string, number>, N: number, avgdl: number }} index
 * @param {string[]} queryTokens
 * @returns {{ index: number, score: number }[]}
 */
export function scoreIndex(index, queryTokens) {
    const { docs, df, N, avgdl } = index;
    if (N === 0 || avgdl === 0) return [];

    // 查询词去重 → 每个词只加一次分（BM25 的标准做法）。
    const unique = [...new Set(queryTokens)];
    const idf = new Map();
    for (const token of unique) {
        const frequency = df.get(token) ?? 0;
        if (frequency === 0) continue;
        idf.set(token, Math.log(1 + (N - frequency + 0.5) / (frequency + 0.5)));
    }
    if (idf.size === 0) return [];

    const scored = [];
    for (let position = 0; position < docs.length; position += 1) {
        const doc = docs[position];
        let score = 0;
        for (const [token, weight] of idf) {
            const tf = doc.tf.get(token);
            if (tf === undefined) continue;
            score += (weight * (tf * (K1 + 1))) / (tf + K1 * (1 - B + (B * doc.len) / avgdl));
        }
        if (score > 0) scored.push({ index: position, score });
    }
    return scored.sort((left, right) => right.score - left.score);
}
