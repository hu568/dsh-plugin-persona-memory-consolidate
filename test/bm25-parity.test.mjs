/**
 * BM25 对照测试（00 §5.1 第 3 条：复制必须配对照）。
 *
 * 直接用 `file://` import 兄弟仓库里**真实的** `dsh-plugin-persona-memory-recall/lib/`
 * 那份 `bm25.js` 与 `tokenize.js`（绕过它的 exports 限制），对同一批文本断言
 * 分词结果与打分逐位相同 —— 任何一边改了公式或分词口径，本测试立刻红。
 *
 * ⚠️ 限制（00 §5.1 脚注）：装进 profile 之后没有兄弟仓库可读，**本测试只在开发机执行**；
 * 找不到兄弟仓库时打印 SKIP 并正常退出（不算失败）。
 *
 * 跑法：node test/bm25-parity.test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildIndex as localBuild, scoreIndex as localScore } from '../lib/bm25.js';
import { tokenize as localTokenize } from '../lib/tokenize.js';

const sibling = new URL('../../dsh-plugin-persona-memory-recall/lib/', import.meta.url);
const siblingBm25 = new URL('bm25.js', sibling);
const siblingTokenize = new URL('tokenize.js', sibling);

if (!existsSync(fileURLToPath(siblingBm25)) || !existsSync(fileURLToPath(siblingTokenize))) {
    console.log('SKIP bm25-parity.test.mjs：找不到兄弟仓库 dsh-plugin-persona-memory-recall（本测试只在开发机执行）');
    process.exit(0);
}

const remoteBm25 = await import(siblingBm25.href);
const remoteTokenize = await import(siblingTokenize.href);

/** 共享语料：覆盖 CJK 2-gram、拉丁整词、中英混排、停用词、重复词、超长句。 */
const CORPUS = [
    '薄壳模式 在宿主层 短路 llm/stream，每轮调用一次 cmd resume',
    'FACT.md 有 100 行和 8000 字节 双上限，超限拒绝写入',
    '右侧栏 面板 改用 注入 样式表，主题色用 color-mix 推导',
    '依赖用 tarball 装，不用 pnpm install；改完 lib/*.js 要重启 DSH',
    'MEMORY.md 上半部结论、下半部速查，正文禁行内代码',
    '会话日志是多帧 zstd，直接 zstdDecompressSync 只解第一帧',
    '我们去看看这个因为所以的停用词会不会被丢掉',
    'aa bb cc d1 _x node v22.23.3 混合 1234',
    '',
    '   ',
    '重复重复重复重复重复，重复出现应当提高 tf',
];

/** 1. 分词逐位相同（这是最容易分叉的地方） */
for (const text of CORPUS) {
    assert.deepEqual(localTokenize(text), remoteTokenize.tokenize(text), `分词不一致：「${text}」`);
}
assert.deepEqual(
    localTokenize('NFKC 全角ＡＢＣ１２３'),
    remoteTokenize.tokenize('NFKC 全角ＡＢＣ１２３'),
    '全角归一化口径必须一致',
);

/** 2. 建索引结构相同（docs.len / df / N / avgdl） */
const localDocs = CORPUS.map((text) => localTokenize(text));
const remoteDocs = CORPUS.map((text) => remoteTokenize.tokenize(text));
const localIndex = localBuild(localDocs);
const remoteIndex = remoteBm25.buildIndex(remoteDocs);

assert.equal(localIndex.N, remoteIndex.N);
assert.equal(localIndex.avgdl, remoteIndex.avgdl);
assert.deepEqual(localIndex.docs.map((doc) => doc.len), remoteIndex.docs.map((doc) => doc.len));
assert.deepEqual([...localIndex.df.entries()].sort(), [...remoteIndex.df.entries()].sort());

/** 3. 打分逐位相同（含排序） */
const QUERIES = [
    '上限 拒绝写入',
    '薄壳模式 短路',
    'tarball 装 pnpm',
    'zstd 多帧',
    '右侧栏 样式表',
    '量子纠缠 不存在',
    '',
    '重复 重复',
];
for (const query of QUERIES) {
    const localHits = localScore(localIndex, localTokenize(query));
    const remoteHits = remoteBm25.scoreIndex(remoteIndex, remoteTokenize.tokenize(query));
    assert.equal(localHits.length, remoteHits.length, `命中数不一致：「${query}」`);
    for (let position = 0; position < localHits.length; position += 1) {
        assert.equal(localHits[position].index, remoteHits[position].index, `排序不一致：「${query}」`);
        assert.equal(localHits[position].score, remoteHits[position].score, `分数不一致：「${query}」位置 ${position}`);
    }
}

/** 4. 空语料 / 空查询的边界行为一致 */
assert.deepEqual(localScore(localBuild([]), localTokenize('任何')), remoteBm25.scoreIndex(remoteBm25.buildIndex([]), remoteTokenize.tokenize('任何')));
assert.deepEqual(localScore(localIndex, []), remoteBm25.scoreIndex(remoteIndex, []));

console.log(`✓ bm25-parity.test.mjs 全部通过（${CORPUS.length} 条语料 / ${QUERIES.length} 条查询，与 recall 真实实现逐位一致）`);
