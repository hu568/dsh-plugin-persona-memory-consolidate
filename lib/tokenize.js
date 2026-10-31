/**
 * 轻量分词：拉丁/数字按整词，CJK 按 2-gram。
 *
 * ⚠️ **本文件是 `@dsh-external/dsh-persona-memory-recall` 的 `lib/tokenize.js` 的逐字副本。**
 * 见 `bm25.js` 顶部的说明：00 §5.1 拍板「复制 + 对照测试」，`test/bm25-parity.test.mjs`
 * 直接 import 兄弟仓库里真实的那份，任何口径分叉都会红。
 *
 * 为什么不用词典分词或 embedding：
 *  - 语料是记忆条目与 JOURNAL 片段（中英混排、技术名词多、自造词多），
 *    词典分词会把自造词切碎；2-gram 不需要词表，召回率稳。
 *  - BM25 只需要「词 → 片段」的倒排，2-gram 已经够用，且零依赖、零构建。
 *
 * 归一化：NFKC（全角→半角）+ 小写。输出**保留重复**（BM25 需要词频）。
 */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const LATIN = /[a-z0-9_]/;
const LATIN_INNER = /[a-z0-9_]/;
/** 单字停用词：只去掉纯虚词，保留「在线」「和值」这类有实义的组合。 */
const CJK_STOP_UNIGRAM = new Set('的了是在和也就都而及与或我你他她它这那不有会要把被给从到对为以于之其上下中个些吗呢吧啊嗯哦嘛呀们着过之'.split(''));
/** 双字停用词。 */
const CJK_STOP_BIGRAM = new Set([
    '我们', '你们', '他们', '她们', '它们', '这个', '那个', '这些', '那些',
    '什么', '怎么', '为什么', '没有', '可以', '就是', '还是', '因为', '所以',
    '但是', '如果', '现在', '已经', '自己', '知道', '不是', '需要', '应该',
    '时候', '问题', '一个', '一下', '一些', '这样', '那样', '如何', '是否',
]);
/** 助词：出现在 2-gram 里就丢掉（「的方」「了塞」这类纯噪声）。 */
const CJK_PARTICLE = new Set('的了着过吗呢吧啊嗯哦嘛呀'.split(''));

/** NFKC + 小写，与 tokenize 内部口径一致（外部比较用）。 */
export function normalize(text) {
    return String(text ?? '').normalize('NFKC').toLowerCase();
}

/**
 * 分词。
 *
 * @param {string} text 任意文本。
 * @returns {string[]} token 列表（保留重复）。
 */
export function tokenize(text) {
    const source = normalize(text);
    const tokens = [];
    let index = 0;
    while (index < source.length) {
        const char = source[index];
        if (CJK.test(char)) {
            let end = index;
            while (end < source.length && CJK.test(source[end])) end += 1;
            const run = source.slice(index, end);
            if (run.length === 1) {
                if (!CJK_STOP_UNIGRAM.has(run)) tokens.push(run);
            } else {
                for (let offset = 0; offset + 1 < run.length; offset += 1) {
                    const gram = run.slice(offset, offset + 2);
                    if (CJK_STOP_BIGRAM.has(gram)) continue;
                    if (CJK_PARTICLE.has(gram[0]) || CJK_PARTICLE.has(gram[1])) continue;
                    tokens.push(gram);
                }
            }
            index = end;
            continue;
        }
        if (LATIN.test(char)) {
            let end = index;
            while (end < source.length && LATIN_INNER.test(source[end])) end += 1;
            const word = source.slice(index, end);
            index = end;
            if (word.length >= 2) tokens.push(word);
            continue;
        }
        index += 1;
    }
    return tokens;
}
