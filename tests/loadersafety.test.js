// Phase 12/13 loader-safety gate (roadmap requirement #14).
//
// Cinnamon's zena loader resolves EVERY relative require against the applet
// root and strips './' sequences anywhere in the path (fileUtils.js). The
// breaking case is PARENT-TRAVERSAL:
//     require('../x.js')  ->  '.x.js'  ->  whole applet import dies.
// A root-level nested './providers/x.js' is SAFE: zena strips the leading
// './', leaving 'providers/x.js' which resolves correctly from the applet
// root. The other invariant: provider submodules must not require siblings
// at all — they receive cross-file constants/helpers via DEPENDENCY INJECTION
// (see providers/agentManager.js, which has zero project-relative requires).
//
// Test files under tests/ are excluded: they run under plain node and
// legitimately use '../'.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function productionFiles() {
    const out = [];
    function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === 'tests' ||
                entry.name === '.git' || entry.name === '.opencode') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
        }
    }
    walk(ROOT);
    return out;
}

// capture every require('...') literal in a source string
function requireLiterals(src) {
    const out = [];
    const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(src)) !== null) out.push(m[1]);
    return out;
}

test('loader: no parent-traversal (../) requires in production', () => {
    const files = productionFiles();
    assert.ok(files.length > 0, 'found production js files');
    const offenders = [];
    for (const f of files) {
        for (const lit of requireLiterals(fs.readFileSync(f, 'utf8'))) {
            if (lit.indexOf('../') === 0) offenders.push(path.relative(ROOT, f) + ': ' + lit);
        }
    }
    assert.deepEqual(offenders, [], 'parent-traversal requires:\n' + offenders.join('\n'));
});

test('loader: agentManager.js has zero project-relative requires (injection only)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'providers', 'agentManager.js'), 'utf8');
    const rel = requireLiterals(src).filter(l => l[0] === '.');
    assert.deepEqual(rel, [],
        'agentManager relative requires (must be empty): ' + rel.join(', '));
});

test('loader: every production require is absolute, gi.*/ui.*, or safe ./<path>.js', () => {
    const files = productionFiles();
    const bad = [];
    for (const f of files) {
        for (const lit of requireLiterals(fs.readFileSync(f, 'utf8'))) {
            const ok = lit[0] !== '.' ||                 // absolute module (mainloop, gi.*, ui.*, ...)
                       (lit.indexOf('../') !== 0 && /\.js$/.test(lit)); // safe ./<path>.js
            if (!ok) bad.push(path.relative(ROOT, f) + ': ' + lit);
        }
    }
    assert.deepEqual(bad, [], 'unexpected require form:\n' + bad.join('\n'));
});
