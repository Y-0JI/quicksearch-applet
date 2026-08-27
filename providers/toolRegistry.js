// ToolRegistry (Phase 8): abstraction + validation + execution layer ONLY.
// No AI logic lives here (AgentManager comes in Phase 9). Pure CJS module:
// runs under Cinnamon GJS AND node --test. All platform effects are owned by
// the TOOLS (injected deps), never by the registry.
//
// Security stance: strict flat schema (unknown keys rejected), whitelisted
// tool ids only, normalized errors, no shell anywhere.

const LIMITS = {
    maxAgentSteps: 8,     // consumed by AgentManager (Phase 9), declared now
    maxListItems: 10,     // per-array truncation in normalized results
    maxValueChars: 500,   // per-string truncation
    maxResultChars: 4000, // total serialized result cap
    webGraceMs: 2500,     // wait window for webProvider upgrade delivery (SEARCH mode)
    agentWebGraceMs: 400,  // Phase 14: agent wait window for real web results (reduced from 1200ms)
    // Phase 10: transient vision payloads (data URLs) need their own ceiling;
    // ~6M chars ~= 4.5MB binary PNG. Applies ONLY to data:image/* strings.
    maxImageDataUrlChars: 6000000
};

const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH'];

function _checkShape(t, toolsById) {
    if (!t || typeof t !== 'object') return 'tool-must-be-object';
    if (typeof t.id !== 'string' || !/^[a-z][a-z0-9_]*$/.test(t.id)) return 'invalid-id';
    if (typeof t.name !== 'string' || !t.name) return 'missing-name';
    if (typeof t.description !== 'string' || !t.description) return 'missing-description';
    if (RISK_LEVELS.indexOf(t.riskLevel) === -1) return 'invalid-risk-level';
    if (typeof t.execute !== 'function') return 'execute-must-be-function';
    const s = t.inputSchema;
    if (!s || s.type !== 'object' || !s.properties ||
        typeof s.properties !== 'object') return 'invalid-input-schema';
    for (const k in s.properties) {
        const ty = s.properties[k].type;
        if (['string', 'number', 'boolean', 'array'].indexOf(ty) === -1) return 'invalid-schema-type:' + k;
    }
    if (toolsById[t.id]) return 'duplicate-id';
    return null;
}

function _typeOk(expected, v) {
    if (expected === 'string') return typeof v === 'string';
    if (expected === 'number') return typeof v === 'number' && isFinite(v);
    if (expected === 'boolean') return typeof v === 'boolean';
    if (expected === 'array') return Array.isArray(v);
    return false;
}

function createToolRegistry(opts) {
    opts = opts || {};
    const toolsById = {};

    function register(tool) {
        const err = _checkShape(tool, toolsById);
        if (err) return err;
        toolsById[tool.id] = tool;
        return null;
    }

    function get(id) { return toolsById[id] || null; }

    function list() {
        return Object.keys(toolsById).sort().map(id => {
            const t = toolsById[id];
            return { id: t.id, name: t.name, description: t.description,
                     riskLevel: t.riskLevel, inputSchema: t.inputSchema };
        });
    }

    // validate(id, args) -> null when OK, else normalized error object.
    // Strict: unknown keys are REJECTED so model-supplied args cannot
    // smuggle extra fields into tool implementations.
    function validate(id, args) {
        const tool = toolsById[id];
        if (!tool) return { error: 'unknown-tool', id: String(id) };
        if (args === undefined || args === null) args = {};
        if (typeof args !== 'object' || Array.isArray(args)) {
            return { error: 'invalid-arguments', reason: 'args-must-be-object' };
        }
        const props = tool.inputSchema.properties;
        for (const k of Object.keys(args)) {
            if (!Object.prototype.hasOwnProperty.call(props, k)) {
                return { error: 'invalid-arguments', reason: 'unknown-key:' + k };
            }
        }
        const required = tool.inputSchema.required || [];
        for (const req of required) {
            if (args[req] === undefined) {
                return { error: 'invalid-arguments', reason: 'missing-required:' + req };
            }
        }
        for (const k of Object.keys(args)) {
            if (args[k] !== undefined && !_typeOk(props[k].type, args[k])) {
                return { error: 'invalid-arguments', reason: 'bad-type:' + k };
            }
        }
        return null;
    }

    let gen = 0;        // monotonic run generation: stale-callback guard
    let active = [];    // [{gen, cancellable}]

    const isDataImage = v => typeof v === 'string' &&
        v.lastIndexOf('data:image/', 0) === 0;

    function _trimValue(v) {
        if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
        if (typeof v === 'string') {
            // Phase 10: vision payloads are the one legitimate huge string;
            // they pass through INTACT here — truncation would ship a corrupt
            // image downstream. The single size gate lives in AgentManager
            // (image-too-large), using LIMITS.maxImageDataUrlChars.
            if (isDataImage(v)) return v;
            return v.length > LIMITS.maxValueChars ? v.slice(0, LIMITS.maxValueChars) : v;
        }
        if (Array.isArray(v)) {
            const items = v.slice(0, LIMITS.maxListItems).map(_trimValue);
            if (v.length > LIMITS.maxListItems) items.push({ truncated: true, total: v.length });
            return items;
        }
        if (typeof v === 'object') {
            const o = {};
            for (const k of Object.keys(v)) o[k] = _trimValue(v[k]);
            return o;
        }
        return String(v);
    }

    function normalizeResult(value) {
        const trimmed = _trimValue(value === undefined ? null : value);
        let s;
        try { s = JSON.stringify(trimmed); } catch (e) { return { value: '[unserializable-result]' }; }
        if (s === undefined) return { value: '[unserializable-result]' };
        // results carrying an image use the image ceiling for the total too,
        // so a valid screenshot never collapses into a preview stub
        const cap = (s.indexOf('"data:image/') !== -1)
            ? LIMITS.maxImageDataUrlChars + 64 : LIMITS.maxResultChars;
        if (s.length <= cap) return trimmed;
        return { truncated: true, preview: s.slice(0, LIMITS.maxResultChars) };
    }

    function execute(id, args, context, cb) {
        const vErr = validate(id, args);
        if (vErr) { cb(vErr, null); return; }
        const tool = toolsById[id];
        const myGen = ++gen;
        const cancellable = (context && context.cancellable) || null;
        if (cancellable) active.push({ gen: myGen, cancellable });

        const done = (err, result) => {
            active = active.filter(r => r.gen !== myGen);
            if (myGen !== gen) return; // stale: cancelled/superseded -> NEVER render
            if (err) { cb(err, null); return; }
            cb(null, normalizeResult(result));
        };
        try {
            // forward the CALLER'S context (capabilities etc.) with a
            // guaranteed cancellable slot — the registry owns cancellation
            const execCtx = Object.assign({}, context || {}, { cancellable: cancellable });
            tool.execute(args, execCtx, done);
        } catch (e) {
            done({ error: 'tool-failed', message: String((e && e.message) || e) });
        }
    }

    function cancel() {
        gen++; // invalidate every pending callback at once
        for (const r of active) { try { r.cancellable.cancel(); } catch (e) {} }
        active = [];
    }

    function destroy() { cancel(); }

    return { register, get, list, validate, execute, cancel, destroy, LIMITS, RISK_LEVELS };
}

module.exports = { createToolRegistry, LIMITS, RISK_LEVELS };
