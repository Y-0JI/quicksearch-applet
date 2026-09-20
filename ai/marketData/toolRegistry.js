// ai/marketData/toolRegistry.js — dynamic tools/list registry + read-only policy.
// Pure, no I/O. Validators built from server inputSchema at runtime.
// ponytail: minimal JSON-schema subset (required/type/enum). Extend when server needs more.
const READ_ONLY_ALLOWLIST = [
    'search_symbols', 'get_ohlcv', 'get_technicals_rating', 'get_symbol_data',
    'get_symbol_data_batch', 'get_financials', 'get_forecasts', 'get_news',
    'get_news_story', 'run_screener', 'get_screener_columns', 'get_economic_data',
    'get_economic_symbols', 'get_financial_history', 'get_documents',
    'get_document_view', 'get_earnings_calendar', 'get_economic_calendar',
    'get_dividends_calendar'
];

function _isWriteName(name) {
    return /^(create_|update_|delete_|stop_|restart_|add_to_|remove_from_)/i.test(String(name || ''));
}
function _destructiveAnnotations(entry) {
    try {
        const a = entry && (entry.annotations || entry.metadata) || null;
        if (!a || typeof a !== 'object') return false;
        if (a.destructiveHint === true || a.destructive === true) return true;
        if (a.readOnlyHint === false) return true;
        return false;
    } catch (e) { return false; }
}
function _validSchema(s) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return false;
    if (s.type && s.type !== 'object') return false;
    if (s.properties && (typeof s.properties !== 'object' || Array.isArray(s.properties))) return false;
    return true;
}

function createToolRegistry(opts) {
    opts = opts || {};
    const allowlist = Array.isArray(opts.allowlist) && opts.allowlist.length ? opts.allowlist.slice() : READ_ONLY_ALLOWLIST.slice();
    let tools = {};
    let screenerCols = null;

    function update(list) {
        tools = {};
        if (!Array.isArray(list)) return;
        for (const e of list) {
            if (!e || typeof e !== 'object') continue;
            const name = String(e.name || '').trim();
            if (!name) continue;
            if (allowlist.indexOf(name) < 0) continue;
            if (_isWriteName(name)) continue;
            if (_destructiveAnnotations(e)) continue;
            if (!_validSchema(e.inputSchema)) continue;
            tools[name] = { name, description: String(e.description || ''), inputSchema: e.inputSchema, annotations: e.annotations || null };
        }
    }
    function isCallable(name) { return !!(name && tools[String(name)]); }
    function get(name) { return (name && tools[String(name)]) || null; }
    function names() { return Object.keys(tools); }

    function validate(name, args) {
        const t = get(name);
        if (!t) return { ok: false, code: 'unsupported_tool', error: 'Tool unavailable: ' + String(name) };
        const schema = t.inputSchema || {};
        const a = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
        const required = Array.isArray(schema.required) ? schema.required : [];
        for (const k of required) {
            if (a[k] == null || (typeof a[k] === 'string' && !a[k].trim())) {
                return { ok: false, code: 'invalid_response', error: 'Missing required param: ' + k };
            }
        }
        const props = (schema.properties && typeof schema.properties === 'object') ? schema.properties : {};
        for (const k of Object.keys(props)) {
            const spec = props[k] || {};
            const v = a[k];
            if (v == null) continue;
            const vt = _checkType(k, v, spec);
            if (!vt.ok) return vt;
            if (Array.isArray(spec.enum) && spec.enum.length && spec.enum.indexOf(v) < 0) {
                return { ok: false, code: 'unsupported_timeframe', error: 'Unsupported value for ' + k + ': ' + String(v) + '. Accepted: ' + spec.enum.join(', ') };
            }
        }
        return { ok: true };
    }

    function _checkType(k, v, spec) {
        const type = spec.type;
        if (!type) return { ok: true };
        if (type === 'string' && typeof v !== 'string') return { ok: false, code: 'invalid_response', error: 'Param ' + k + ' must be string' };
        if (type === 'integer' && !Number.isInteger(v)) return { ok: false, code: 'invalid_response', error: 'Param ' + k + ' must be integer' };
        if (type === 'number' && typeof v !== 'number') return { ok: false, code: 'invalid_response', error: 'Param ' + k + ' must be number' };
        if (type === 'boolean' && typeof v !== 'boolean') return { ok: false, code: 'invalid_response', error: 'Param ' + k + ' must be boolean' };
        if (type === 'object' && (typeof v !== 'object' || v === null || Array.isArray(v))) {
            return { ok: false, code: 'invalid_response', error: 'Param ' + k + ' must be object' };
        }
        if (type === 'object' && spec.properties && typeof spec.properties === 'object') {
            const sub = _checkObjectProps(k, v, spec);
            if (!sub.ok) return sub;
        }
        if (type === 'array') {
            if (!Array.isArray(v)) return { ok: false, code: 'invalid_response', error: 'Param ' + k + ' must be array' };
            if (spec.minItems != null && v.length < spec.minItems) {
                return { ok: false, code: 'invalid_response', error: 'Param ' + k + ' needs at least ' + spec.minItems + ' items' };
            }
            if (spec.maxItems != null && v.length > spec.maxItems) {
                return { ok: false, code: 'invalid_response', error: 'Param ' + k + ' allows at most ' + spec.maxItems + ' items' };
            }
            const itemType = spec.items && spec.items.type;
            if (itemType) {
                for (const item of v) {
                    if (itemType === 'string' && typeof item !== 'string') return { ok: false, code: 'invalid_response', error: 'Param ' + k + ' items must be string' };
                    if (itemType === 'integer' && !Number.isInteger(item)) return { ok: false, code: 'invalid_response', error: 'Param ' + k + ' items must be integer' };
                    if (itemType === 'number' && typeof item !== 'number') return { ok: false, code: 'invalid_response', error: 'Param ' + k + ' items must be number' };
                    if (itemType === 'boolean' && typeof item !== 'boolean') return { ok: false, code: 'invalid_response', error: 'Param ' + k + ' items must be boolean' };
                }
            }
        }
        return { ok: true };
    }

    // Nested object validation: required sub-fields + per-property type/enum.
    function _checkObjectProps(k, v, spec) {
        const subReq = Array.isArray(spec.required) ? spec.required : [];
        for (const sk of subReq) {
            if (v[sk] == null || (typeof v[sk] === 'string' && !v[sk].trim())) {
                return { ok: false, code: 'invalid_response', error: 'Param ' + k + '.' + sk + ' is required' };
            }
        }
        const subProps = (spec.properties && typeof spec.properties === 'object') ? spec.properties : {};
        for (const sk of Object.keys(subProps)) {
            const sspec = subProps[sk] || {};
            const sv = v[sk];
            if (sv == null) continue;
            const r = _checkType(k + '.' + sk, sv, sspec);
            if (!r.ok) return r;
            if (Array.isArray(sspec.enum) && sspec.enum.length && sspec.enum.indexOf(sv) < 0) {
                return { ok: false, code: 'unsupported_timeframe', error: 'Unsupported value for ' + k + '.' + sk + ': ' + String(sv) };
            }
        }
        return { ok: true };
    }

    function setScreenerColumns(cols) { screenerCols = Array.isArray(cols) ? cols.slice() : null; }
    function screenerColumnsCached() { return Array.isArray(screenerCols) && screenerCols.length > 0; }
    function screenerColumnsCover(needed) {
        if (!screenerColumnsCached()) return false;
        if (!Array.isArray(needed) || !needed.length) return true;
        return needed.every((c) => screenerCols.indexOf(c) >= 0);
    }

    return { update, isCallable, get, names, validate, setScreenerColumns, screenerColumnsCached, screenerColumnsCover, READ_ONLY_ALLOWLIST: allowlist };
}

module.exports = { createToolRegistry, READ_ONLY_ALLOWLIST };
