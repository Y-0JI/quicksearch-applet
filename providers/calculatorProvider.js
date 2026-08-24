// Safe calculator: strict whitelist + recursive-descent parser. No eval.
// Pure module: works under Cinnamon CJS loader AND node --test.

const FUNCS = {
    sqrt: Math.sqrt,
    abs: Math.abs,
    round: Math.round,
    floor: Math.floor,
    ceil: Math.ceil
};

function tryCalculate(rawQuery) {
    const query = String(rawQuery).trim();
    // lowercase letters only (blocks Function/eval tricks via case), plus ^ for exponent
    if (!query || !/^[0-9a-z+\-*/%^().\s]+$/.test(query)) return null;

    try {
        const tokens = _tokenize(query);
        const parser = { tokens, pos: 0 };
        const value = _expr(parser);
        if (parser.pos !== parser.tokens.length) return null;
        if (!isFinite(value)) return null;
        return { expression: query.replace(/\s+/g, ''), value: _format(value) };
    } catch (e) {
        return null;
    }
}

function _tokenize(query) {
    // strip all whitespace, then scan
    const src = query.replace(/\s+/g, '');
    if (!src) throw new Error('empty');
    const tokens = [];
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (/[0-9.]/.test(c)) {
            let num = '';
            while (i < src.length && /[0-9.]/.test(src[i])) num += src[i++];
            if ((num.match(/\./g) || []).length > 1 || num === '.') throw new Error('bad number');
            tokens.push({ type: 'num', value: parseFloat(num) });
        } else if (/[a-z]/.test(c)) {
            let name = '';
            while (i < src.length && /[a-z]/.test(src[i])) name += src[i++];
            tokens.push({ type: 'func', name: name });
        } else if ('+-*/%^()'.indexOf(c) !== -1) {
            tokens.push({ type: c });
            i++;
        } else {
            throw new Error('bad char');
        }
    }
    return tokens;
}

function _peek(p) { return p.tokens[p.pos]; }
function _next(p) { return p.tokens[p.pos++]; }

// expr := term (('+'|'-') term)*
function _expr(p) {
    let v = _term(p);
    while (_peek(p) && (_peek(p).type === '+' || _peek(p).type === '-')) {
        const op = _next(p).type;
        v = op === '+' ? v + _term(p) : v - _term(p);
    }
    return v;
}

// term := unary (('*'|'/'|'%') unary)*
function _term(p) {
    let v = _unary(p);
    while (_peek(p) && (_peek(p).type === '*' || _peek(p).type === '/' || _peek(p).type === '%')) {
        const op = _next(p).type;
        const rhs = _unary(p);
        if ((op === '/' || op === '%') && rhs === 0) throw new Error('div0');
        v = op === '*' ? v * rhs : op === '/' ? v / rhs : v % rhs;
    }
    return v;
}

// unary := ('-'|'+') unary | power
function _unary(p) {
    if (_peek(p) && (_peek(p).type === '-' || _peek(p).type === '+')) {
        const op = _next(p).type;
        const v = _unary(p);
        return op === '-' ? -v : v;
    }
    return _power(p);
}

// power := primary ('^' unary)?   (right-assoc via recursion; -2^2 = -(2^2))
function _power(p) {
    const base = _primary(p);
    if (_peek(p) && _peek(p).type === '^') {
        _next(p);
        const exp = _unary(p);
        return Math.pow(base, exp);
    }
    return base;
}

// primary := number | func '(' expr ')' | '(' expr ')'
function _primary(p) {
    const t = _next(p);
    if (!t) throw new Error('unexpected end');
    if (t.type === 'num') return t.value;
    if (t.type === 'func') {
        if (!FUNCS[t.name]) throw new Error('unknown function');
        const open = _next(p);
        if (!open || open.type !== '(') throw new Error('missing ( after function');
        const v = _expr(p);
        const close = _next(p);
        if (!close || close.type !== ')') throw new Error('missing )');
        return FUNCS[t.name](v);
    }
    if (t.type === '(') {
        const v = _expr(p);
        const close = _next(p);
        if (!close || close.type !== ')') throw new Error('missing )');
        return v;
    }
    throw new Error('unexpected token');
}

function _format(v) {
    if (Number.isInteger(v)) return String(v);
    return String(Math.round(v * 1e10) / 1e10);
}

module.exports = { tryCalculate };
