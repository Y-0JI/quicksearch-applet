// ai/markdownRenderer.js — lightweight, SAFE markdown -> presentation for AI answers.
//
// Pure module (no DOM / St / GJS / I/O) so it runs in node tests AND Cinnamon/GJS.
// Pipeline: raw AI text -> parseMarkdownBlocks() -> plain-data blocks -> blockToMarkup()
// (Pango markup) which the applet hands to St.Label clutter_text.set_markup().
//
// SECURITY: AI output is UNTRUSTED. blockToMarkup() never emits raw text — every span is
// escaped (& < >) and only our own <b>/</b>/<i>/</i> tags are produced, so raw HTML,
// <script> or event attributes cannot be injected or executed. blockToPlainText() is the
// zero-markup fallback (escaped by construction — plain text, no markup at all).
//
// Supported (minimum set): **bold**, *italic*, unordered "- "/"* "/"+ " lists, ordered
// "1. " lists, plain paragraphs, and verbatim ```fenced code```. Citation tokens like
// [1] are NOT special-cased and therefore pass through untouched (source mapping intact).

const BULLET = '\u2022'; // "•"

// Emphasis delimiters. Bold first, non-greedy, no '*' inside. Italic requires a
// non-space after the opening '*' and refuses delimiters adjacent to '*' so that
// '**bold**' leftovers or '2 * 3' multiplication are never swallowed.
const _BOLD_RE = /\*\*([^*\n]+)\*\*/g;
const _ITALIC_RE = /\*(?!\*)([^*\n\s][^*\n]*?)\*(?!\*)/g;

// --- inline emphasis ---------------------------------------------------------

// parseInline('a **b** c') -> [{style:'plain',text:'a '},{style:'bold',text:'b'},{style:'plain',text:'c'}]
function parseInline(line) {
    const s = String(line == null ? '' : line);
    if (s.indexOf('*') === -1) return [{ style: 'plain', text: s }];
    const bold = [];
    const italic = [];
    let tmp = s.replace(_BOLD_RE, (m, inner) => {
        bold.push(inner);
        return '\u0001' + (bold.length - 1) + '\u0002';
    });
    tmp = tmp.replace(_ITALIC_RE, (m, inner) => {
        italic.push(inner);
        return '\u0003' + (italic.length - 1) + '\u0004';
    });
    const spans = [];
    let buf = '';
    function flush() {
        if (buf !== '') { spans.push({ style: 'plain', text: buf }); buf = ''; }
    }
    let k = 0;
    while (k < tmp.length) {
        const ch = tmp[k];
        const isBold = ch === '\u0001';
        const isItalic = ch === '\u0003';
        if (isBold || isItalic) {
            const close = isBold ? '\u0002' : '\u0004';
            const end = tmp.indexOf(close, k);
            if (end === -1) { buf += ch; k++; continue; }
            const idx = parseInt(tmp.slice(k + 1, end), 10);
            const arr = isBold ? bold : italic;
            const inner = arr[idx] != null ? arr[idx] : '';
            flush();
            spans.push({ style: isBold ? 'bold' : 'italic', text: inner });
            k = end + 1;
            continue;
        }
        buf += ch;
        k++;
    }
    flush();
    // merge adjacent spans with the same style (keeps expected shapes like one bold span)
    const merged = [];
    for (const sp of spans) {
        const last = merged.length ? merged[merged.length - 1] : null;
        if (last && last.style === sp.style) last.text += sp.text;
        else merged.push({ style: sp.style, text: sp.text });
    }
    return merged;
}

// --- block parsing -----------------------------------------------------------

// Blocks:
//   { kind:'paragraph', lines:[ {spans:[...]}, ... ] }
//   { kind:'list', ordered:bool, items:[ {num:null|'1.', spans:[...]}, ... ] }
//   { kind:'code', lines:[rawString, ...] }   (verbatim, no inline parsing)
function parseMarkdownBlocks(text) {
    const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    const lines = src.split('\n');
    const n = lines.length;
    const blocks = [];
    let i = 0;
    while (i < n) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed) { i++; continue; }
        // fenced code block: keep verbatim until the closing fence
        if (/^```/.test(trimmed)) {
            const code = { kind: 'code', lines: [] };
            i++;
            while (i < n && !/^```/.test(lines[i].trim())) {
                code.lines.push(lines[i]);
                i++;
            }
            if (i < n) i++; // closing fence
            blocks.push(code);
            continue;
        }
        const ulMatch = /^\s*[-*+]\s+(.*)$/.exec(line);
        const olMatch = /^\s*(\d+)([.)])\s+(.*)$/.exec(line);
        if (ulMatch || olMatch) {
            const ordered = !!olMatch;
            const items = [];
            while (i < n) {
                const l = lines[i];
                const lt = l.trim();
                if (!lt || /^```/.test(lt)) break;
                const mu = /^\s*[-*+]\s+(.*)$/.exec(l);
                const mo = /^\s*(\d+)([.)])\s+(.*)$/.exec(l);
                if (ordered) {
                    if (!mo) break;
                    items.push({ num: mo[1] + mo[2], spans: parseInline(mo[3].trim()) });
                } else {
                    if (!mu) break;
                    items.push({ num: null, spans: parseInline(mu[1].trim()) });
                }
                i++;
            }
            blocks.push({ kind: 'list', ordered, items });
            continue;
        }
        // paragraph: consecutive lines until blank line, fence or list start
        const para = [];
        while (i < n) {
            const l = lines[i];
            const lt = l.trim();
            if (!lt || /^```/.test(lt)) break;
            if (/^\s*[-*+]\s/.test(l) || /^\s*\d+[.)]\s/.test(l)) break;
            para.push({ spans: parseInline(l.replace(/\s+$/, '')) });
            i++;
        }
        blocks.push({ kind: 'paragraph', lines: para });
    }
    return blocks;
}

// --- markup output -----------------------------------------------------------

function escapeMarkupText(t) {
    return String(t)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function spansToMarkup(spans) {
    let out = '';
    for (const sp of spans || []) {
        const esc = escapeMarkupText(sp.text);
        if (sp.style === 'bold') out += '<b>' + esc + '</b>';
        else if (sp.style === 'italic') out += '<i>' + esc + '</i>';
        else out += esc;
    }
    return out;
}

// blockToMarkup(block) -> Pango markup for one block (safe: escaped spans, own tags only)
function blockToMarkup(block) {
    if (!block) return '';
    if (block.kind === 'code') {
        return (block.lines || []).map(escapeMarkupText).join('\n');
    }
    if (block.kind === 'list') {
        return (block.items || []).map(function (it) {
            const prefix = it.num != null ? escapeMarkupText(it.num + ' ') : BULLET + '  ';
            return prefix + spansToMarkup(it.spans);
        }).join('\n');
    }
    return (block.lines || []).map(function (l) { return spansToMarkup(l.spans); }).join('\n');
}

// markdownToMarkup(text) -> whole-document Pango markup (blocks joined with '\n')
function markdownToMarkup(text) {
    return parseMarkdownBlocks(text).map(blockToMarkup).join('\n');
}

// --- plain fallback (no markup support / last resort) --------------------------

function blockToPlainText(block) {
    if (!block) return '';
    if (block.kind === 'code') return (block.lines || []).join('\n');
    if (block.kind === 'list') {
        return (block.items || []).map(function (it) {
            const prefix = it.num != null ? it.num + ' ' : BULLET + ' ';
            return prefix + (it.spans || []).map(function (sp) { return sp.text; }).join('');
        }).join('\n');
    }
    return (block.lines || []).map(function (l) {
        return (l.spans || []).map(function (sp) { return sp.text; }).join('');
    }).join('\n');
}

function blocksToPlainText(blocks) {
    return (blocks || []).map(blockToPlainText).join('\n');
}

module.exports = {
    parseInline,
    parseMarkdownBlocks,
    blockToMarkup,
    markdownToMarkup,
    blockToPlainText,
    blocksToPlainText,
    escapeMarkupText,
    BULLET
};
