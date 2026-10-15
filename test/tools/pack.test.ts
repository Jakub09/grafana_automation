import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PACK = path.resolve('tools/pack.mjs');

function write(root: string, rel: string, content: string | Buffer, mode?: number) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    if (mode) fs.chmodSync(file, mode);
}

test('Archiwum jednoplikowe: odtwarza strukturę, treść (także binarną) i uprawnienia, pomija .gitignore', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-test-'));
    const src = path.join(tmp, 'src');
    write(src, 'package.json', JSON.stringify({ name: 'demo', version: '2.0.0' }));
    write(src, '.gitignore', 'node_modules/\n.env\n*.log\nsecret/\n');
    write(src, 'a/b/c/deep.txt', 'zażółć gęślą jaźń\n');
    write(src, 'bin/run.sh', '#!/bin/sh\necho ok\n', 0o755);
    write(src, 'img/logo.bin', Buffer.from([0, 1, 2, 255, 254, 0, 10, 13]));
    write(src, '.env.example', 'A=1\n');
    write(src, '.env', 'HASLO=tajne\n');
    write(src, 'node_modules/x/index.js', 'x');
    write(src, 'secret/klucz.pem', 'klucz');
    write(src, 'app.log', 'log');
    write(src, 'docs/notes.md', 'notatki');

    const bundle = path.join(tmp, 'demo.bundle.js');
    execFileSync('node', [PACK, '--root', src, '--output', bundle, '--exclude', 'docs/']);

    const list = execFileSync('node', [bundle, '--list']).toString();
    for (const excluded of ['.env\n', 'node_modules', 'secret/', 'app.log', 'docs/']) {
        assert.ok(!list.includes(excluded), `w archiwum nie powinno być: ${excluded.trim()}`);
    }

    const out = path.join(tmp, 'out');
    execFileSync('node', [bundle, out]);
    const restored = (rel: string) => fs.readFileSync(path.join(out, rel));
    assert.equal(restored('a/b/c/deep.txt').toString(), 'zażółć gęślą jaźń\n');
    assert.deepEqual([...restored('img/logo.bin')], [0, 1, 2, 255, 254, 0, 10, 13]);
    assert.equal(restored('.env.example').toString(), 'A=1\n');
    assert.equal(fs.statSync(path.join(out, 'bin/run.sh')).mode & 0o777, 0o755);
    assert.ok(!fs.existsSync(path.join(out, '.env')));

    // Ponowne rozpakowanie do tego samego katalogu wymaga --force
    const again = spawnSync('node', [bundle, out]);
    assert.equal(again.status, 1);
    assert.match(again.stderr.toString(), /--force/);
    assert.equal(spawnSync('node', [bundle, out, '--force']).status, 0);
});

test('Czyste archiwum: .bundleignore (Docker, środowisko dev), skrypty i sekcje dokumentacji z nich korzystające; --full bez zmian', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-clean-'));
    const src = path.join(tmp, 'src');
    const scripts = {
        start: 'node --env-file=.env dist/server.js',
        test: 'node --test "test/**/*.test.ts"',
        'env:up': 'sh dev/compose.sh up -d',
        'test:e2e': 'node --test "test/e2e/*.test.ts"',
        'cli:dev': 'tsx --env-file=.env.dev cli.ts',
    };
    write(src, 'package.json', JSON.stringify({ name: 'demo', scripts }));
    write(src, 'tsconfig.json', JSON.stringify({ include: ['src/**/*.ts', 'dev/**/*.ts'] }));
    write(src, '.gitignore', '.env\n.env.dev\n');
    write(src, '.bundleignore', 'Dockerfile\ncompose.yaml\ndev/\ntest/e2e/\n.env.dev\n.bundleignore\n');
    write(src, 'Dockerfile', 'FROM node');
    write(src, 'compose.yaml', 'services: {}');
    write(src, 'dev/compose.sh', 'podman compose "$@"');
    write(src, 'test/e2e/env.test.ts', 'e2e');
    write(src, 'test/unit.test.ts', 'unit');
    write(src, 'docs/a.md', '# Dok\n\nInstalacja.\n\n<!-- bundle:dev -->\n## Kontenery\n\n```bash\nnpm run env:up\n```\n<!-- /bundle:dev -->\n\n## Dalej\n');

    const clean = path.join(tmp, 'clean.bundle.js');
    execFileSync('node', [PACK, '--root', src, '--output', clean]);
    const out = path.join(tmp, 'out');
    execFileSync('node', [clean, out]);
    for (const rel of ['Dockerfile', 'compose.yaml', 'dev', 'test/e2e', '.bundleignore']) {
        assert.ok(!fs.existsSync(path.join(out, rel)), `w czystym archiwum nie powinno być: ${rel}`);
    }
    assert.ok(fs.existsSync(path.join(out, 'test/unit.test.ts')));
    const pkg = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf-8'));
    assert.deepEqual(Object.keys(pkg.scripts), ['start', 'test']); // .env (gitignore) nie usuwa skryptu
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'tsconfig.json'), 'utf-8')).include, ['src/**/*.ts']);
    assert.equal(fs.readFileSync(path.join(out, 'docs/a.md'), 'utf-8'), '# Dok\n\nInstalacja.\n\n## Dalej\n');

    const full = path.join(tmp, 'full.bundle.js');
    execFileSync('node', [PACK, '--root', src, '--output', full, '--full']);
    const fullOut = path.join(tmp, 'full');
    execFileSync('node', [full, fullOut]);
    assert.ok(fs.existsSync(path.join(fullOut, 'dev/compose.sh')));
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(fullOut, 'package.json'), 'utf-8')).scripts), Object.keys(scripts));
});
