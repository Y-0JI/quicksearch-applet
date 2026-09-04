// ai/citationCleaner.js — pure visible-answer cleanup for grounded AI answers.
// Removes pipeline citation markers ("[1]", "[1][2]", "[1, 2]", "[1,2,3]") from the
// displayed answer TEXT only. Source metadata is separate and never touched: the
// Sources · N button, source popup, per-message source arrays and grounded tracking
// all keep working off the untouched payload.sources.
//
// Safety rules (never damage real content):
//  - Only grounded evidence legs number their reference context [1..N], and the engine
//    caps that list at MAX_CITATION_INDEX per leg — markers beyond it are not citations.
//  - Only exact marker shapes are removed: bracketed, comma/space separated integers
//    within 1..MAX_CITATION_INDEX. Prices ("Rp4.450"), percents ("4%"), years ("2026")
//    and dates ("4 September 2026") are not bracketed integers -> untouched.
//  - Content inside ``` fenced code blocks and `inline code` is preserved verbatim.
//  - "[n](url)" markdown links are preserved (bracket immediately followed by "(").
//  - Escaped "\[n\]" is preserved.
//  - Ungrounded answers are never passed through this function by the engine.

const MAX_CITATION_INDEX = 5;

function _isCitationToken(inner, maxIndex) {
    const t = String(inner).trim();
    if (!t) return false;
    if (!/^[0-9]+(?:\s*,\s*[0-9]+)*$/.test(t)) return false;
    const parts = t.split(',');
    for (let k = 0; k < parts.length; k++) {
        const n = parseInt(parts[k].trim(), 10);
        if (!(n >= 1 && n <= maxIndex)) return false;
    }
    return true;
}

// opts: { maxIndex?: number } — highest citation index the evidence leg actually used
// (defaults to MAX_CITATION_INDEX, the engine's per-leg evidence cap).
function cleanAnswerCitations(text, opts) {
    const s = text == null ? '' : String(text);
    if (!s) return s;
    const maxIndex = (opts && typeof opts.maxIndex === 'number' && opts.maxIndex >= 1)
        ? Math.floor(opts.maxIndex)
        : MAX_CITATION_INDEX;
    let out = '';
    let fence = false;   // inside ``` fenced code block
    let inline = false;  // inside ` inline code span
    let i = 0;
    const n = s.length;
    while (i < n) {
        const ch = s[i];
        if (ch === '`') {
            let run = 0;
            while (i + run < n && s[i + run] === '`') run++;
            if (run >= 3) {
                if (!inline) fence = !fence;
                out += s.slice(i, i + run);
                i += run;
                continue;
            }
            if (!fence) {
                if (inline) inline = false;
                else if (s.indexOf('`', i + 1) !== -1) inline = true;
            }
            out += ch;
            i++;
            continue;
        }
        if (fence || inline) {
            out += ch;
            i++;
            continue;
        }
        if (ch === '[') {
            const prev = i > 0 ? s[i - 1] : '';
            const close = s.indexOf(']', i + 1);
            if (prev !== '\\' && close !== -1) {
                const inner = s.slice(i + 1, close);
                const after = (close + 1 < n) ? s[close + 1] : '';
                if (after !== '(' && _isCitationToken(inner, maxIndex)) {
                    // collapse the single space the marker followed, if any
                    if (out.length > 0 && out[out.length - 1] === ' ') out = out.slice(0, -1);
                    i = close + 1;
                    continue;
                }
            }
        }
        out += ch;
        i++;
    }
    return out;
}

module.exports = { cleanAnswerCitations, MAX_CITATION_INDEX };
