const { test } = require('node:test');
const assert = require('node:assert');
const { classifyQuery, makeResult, dedupeResults, scoreResult, processResults } = require('../result.js');

test('classifyQuery routes query types', () => {
    assert.deepEqual(classifyQuery('2+2'), { calc: true, url: false, apps: false, files: false, web: false });
    assert.deepEqual(classifyQuery('125*8'), { calc: true, url: false, apps: false, files: false, web: false });
    assert.deepEqual(classifyQuery('https://github.com'), { calc: false, url: true, apps: false, files: false, web: false });
    assert.deepEqual(classifyQuery('github.com'), { calc: false, url: true, apps: false, files: false, web: false });
    assert.deepEqual(classifyQuery('firefox'), { calc: false, url: false, apps: true, files: true, web: true });
    assert.deepEqual(classifyQuery('document.pdf'), { calc: false, url: false, apps: true, files: true, web: true });
});

test('makeResult normalizes and generates stable ids', () => {
    const r1 = makeResult({ type: 'file', title: 'a.txt', path: '/home/u/a.txt' });
    const r2 = makeResult({ type: 'file', title: 'a.txt', path: '/home/u/a.txt' });
    assert.equal(r1.id, '/f//home/u/a.txt');
    assert.deepEqual(r1, r2);
    assert.equal(r1.type, 'file');
    assert.equal(r1.score, 0);

    const app = makeResult({ type: 'app', title: 'Firefox', appId: 'firefox.desktop' });
    assert.equal(app.id, '/a/firefox.desktop');

    const web = makeResult({ type: 'web', title: 'x', url: 'https://GitHub.com/?a=1' });
    assert.equal(web.id, '/w/github.com/?a=1'); // canonical: host lowercased, query kept
});

test('dedupeResults keeps first occurrence by id', () => {
    const a = makeResult({ type: 'app', title: 'Firefox', appId: 'f.desktop' });
    const b = makeResult({ type: 'app', title: 'Firefox ', appId: 'f.desktop' });
    const c = makeResult({ type: 'web', title: 'dup', url: 'https://github.com' });
    const d = makeResult({ type: 'web', title: 'dup', url: 'https://github.com' });
    const out = dedupeResults([a, b, c, d]);
    assert.equal(out.length, 2);
});

test('scoreResult tiers', () => {
    assert.ok(scoreResult('app-exact') > scoreResult('app-prefix'));
    assert.ok(scoreResult('app-prefix') > scoreResult('app-contains'));
    assert.ok(scoreResult('app-contains') > scoreResult('keyword'));
    assert.ok(scoreResult('file-exact') > scoreResult('file-prefix'));
    assert.ok(scoreResult('file-prefix') > scoreResult('file-contains'));
    assert.ok(scoreResult('calc') > scoreResult('app-exact'));
    assert.ok(scoreResult('url') > scoreResult('app-exact'));
    assert.ok(scoreResult('web-instant') < scoreResult('file-contains'));
    assert.ok(scoreResult('web-fallback') < scoreResult('web-instant'));
});

test('processResults sorts desc and applies per-type limits', () => {
    const mk = (type, score, uniq) => {
        let r;
        if (type === 'app') r = makeResult({ type, title: 't' + uniq, appId: 'id' + uniq });
        else if (type === 'file') r = makeResult({ type, title: 't' + uniq, path: '/p/' + uniq });
        else r = makeResult({ type, title: 't' + uniq, url: 'https://u' + uniq + '.com' });
        r.score = score;
        return r;
    };
    const lists = [
        [mk('app', 200, 1), mk('app', 300, 2), mk('app', 250, 3), mk('app', 100, 4), mk('app', 90, 5), mk('app', 80, 6)],
        [mk('file', 180, 1), mk('file', 120, 2), mk('file', 60, 3)]
    ];
    const out = processResults(lists, { app: 5, file: 15, web: 5 });
    assert.equal(out.length, 8); // 5 apps + 3 files
    assert.equal(out[0].score, 300); // global sort desc
    assert.equal(out[3].score, 180); // best file interleaves after top apps
    const counts = {};
    for (const r of out) counts[r.type] = (counts[r.type] || 0) + 1;
    assert.equal(counts.app, 5);   // app limit enforced
    assert.equal(counts.file, 3);
});
