#!/usr/bin/env node
/**
 * Pakuje projekt do jednego, samorozpakowującego się pliku JS.
 *
 *   node tools/pack.mjs [--output plik.js] [--root katalog] [--exclude wzorzec]... [--include wzorzec]... [--full]
 *
 * Wynikowy plik nie ma zależności (tylko Node.js >= 22) i odtwarza projekt ze strukturą katalogów:
 *   node grafana-automation.bundle.js [katalog-docelowy] [--force] [--list] [--verify]
 *
 * Pomijane jest to, co w .gitignore (node_modules, dist, .env, logi...) i w .bundleignore (środowisko dev na
 * kontenerach, testy e2e), a zawsze: .git i samo archiwum. W czystym archiwum package.json nie ma skryptów
 * odwołujących się do pominiętych plików, a z dokumentacji (*.md) usuwane są bloki
 * <!-- bundle:dev --> ... <!-- /bundle:dev -->. --full pakuje wszystko bez tych zmian.
 * Pliki zapisywane są binarnie (dowolny typ), z uprawnieniami (np. wykonywalność) i sumą SHA-256.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import zlib from 'node:zlib';

const { values: args } = parseArgs({
    options: {
        root: { type: 'string', default: '.' },
        output: { type: 'string' },
        exclude: { type: 'string', multiple: true, default: [] },
        include: { type: 'string', multiple: true, default: [] },
        full: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h' },
    },
});

if (args.help) {
    console.log(`Użycie: node tools/pack.mjs [--output plik.js] [--root katalog] [--exclude wzorzec]... [--include wzorzec]...

  --output   plik wynikowy (domyślnie <nazwa-z-package.json>.bundle.js w katalogu projektu)
  --exclude  dodatkowy wzorzec do pominięcia (składnia .gitignore), np. --exclude "analysis_*.md"
  --include  wzorzec do dołączenia mimo .gitignore, np. --include config/email-routing.json
  --full     pełna kopia: bez .bundleignore i bez czyszczenia package.json / dokumentacji (np. ze środowiskiem dev)`);
    process.exit(0);
}

const root = path.resolve(args.root);
const pkg = readJson(path.join(root, 'package.json'));
const name = (pkg?.name ?? path.basename(root)).replace(/[^\w.-]+/g, '-');
const output = path.resolve(args.output ?? path.join(root, `${name}.bundle.js`));

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
        return null;
    }
}

// --- Wzorce w stylu .gitignore ---

/** Wzorzec .gitignore -> { regex, negate, dirOnly } */
function compilePattern(line) {
    let pattern = line.trim();
    const negate = pattern.startsWith('!');
    if (negate) pattern = pattern.slice(1);
    const dirOnly = pattern.endsWith('/');
    pattern = pattern.replace(/\/+$/, '');
    // Wzorzec bez "/" (poza końcowym) pasuje na dowolnej głębokości, z "/" - od katalogu głównego
    const anchored = pattern.includes('/');
    pattern = pattern.replace(/^\//, '');
    const body = pattern
        .split(/(\*\*\/?|\*|\?)/)
        .map(part => part === '**/' ? '(?:.*/)?' : part === '**' ? '.*' : part === '*' ? '[^/]*' : part === '?' ? '[^/]'
            : part.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
        .join('');
    return { regex: new RegExp(`${anchored ? '^' : '(?:^|/)'}${body}$`), negate, dirOnly };
}

function loadPatterns(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf-8')
        .split(/\r?\n/)
        .filter(l => l.trim() && !l.trim().startsWith('#'))
        .map(compilePattern);
}

// Reguły czystego archiwum - także do usuwania skryptów package.json, które z tych plików korzystają
const bundleRules = args.full ? [] : loadPatterns(path.join(root, '.bundleignore'));
const ignoreRules = [
    ...['.git/', '*.bundle.js'].map(compilePattern),
    ...loadPatterns(path.join(root, '.gitignore')),
    ...bundleRules,
    ...args.exclude.map(compilePattern),
    ...args.include.map(p => compilePattern(`!${p}`)),
];

/** Ostatnia pasująca reguła decyduje (jak w git) */
function isIgnored(relPath, isDir, rules = ignoreRules) {
    let ignored = false;
    for (const rule of rules) {
        if (rule.dirOnly && !isDir) continue;
        if (rule.regex.test(relPath)) ignored = !rule.negate;
    }
    return ignored;
}

/**
 * Ścieżka (plik albo wzorzec z *) leży w miejscu pominiętym przez .bundleignore - sama albo któryś z jej katalogów.
 * Reguły .gitignore się nie liczą: np. .env nie ma w archiwum, ale skrypty z --env-file=.env mają zostać.
 */
function isExcludedPath(token) {
    const clean = token.replace(/^\.\//, '').split(/[*?]/)[0].replace(/\/+$/, '');
    if (!clean || clean.startsWith('-') || clean.startsWith('/') || clean.includes('..')) return false;
    const parts = clean.split('/');
    for (let i = 1; i < parts.length; i++) {
        if (isIgnored(parts.slice(0, i).join('/'), true, bundleRules)) return true;
    }
    return isIgnored(clean, false, bundleRules) || isIgnored(clean, true, bundleRules);
}

/** Słowa polecenia wyglądające na ścieżki plików projektu */
const pathTokens = (command) => command.split(/[\s="']+/).filter(t => t.includes('/') || /^\.env\b|\.(sh|ts|mjs|js|ya?ml|json)$/.test(t));

/**
 * Czysty projekt: package.json bez skryptów odwołujących się do pominiętych plików (np. env:*, test:e2e),
 * tsconfig.json bez pominiętych katalogów, dokumentacja bez bloków <!-- bundle:dev -->.
 */
function transform(rel, content) {
    if (args.full) return { content, note: null };
    if (rel === 'package.json') {
        const pkgJson = JSON.parse(content.toString('utf-8'));
        const removed = Object.entries(pkgJson.scripts ?? {}).filter(([, cmd]) => pathTokens(cmd).some(isExcludedPath)).map(([n]) => n);
        for (const n of removed) delete pkgJson.scripts[n];
        return { content: Buffer.from(JSON.stringify(pkgJson, null, 2) + '\n'), note: removed.length ? `skrypty: ${removed.join(', ')}` : null };
    }
    if (rel === 'tsconfig.json') {
        const ts = JSON.parse(content.toString('utf-8'));
        const removed = (ts.include ?? []).filter(isExcludedPath);
        if (!removed.length) return { content, note: null };
        ts.include = ts.include.filter(p => !removed.includes(p));
        return { content: Buffer.from(JSON.stringify(ts, null, 2) + '\n'), note: `include: ${removed.join(', ')}` };
    }
    if (rel.endsWith('.md')) {
        const text = content.toString('utf-8');
        const stripped = text.replace(/[ \t]*<!-- bundle:dev -->[\s\S]*?<!-- \/bundle:dev -->[ \t]*\r?\n?/g, '');
        return stripped === text ? { content, note: null } : { content: Buffer.from(stripped.replace(/\n{3,}/g, '\n\n')), note: 'sekcje środowiska dev' };
    }
    return { content, note: null };
}

// --- Zbieranie plików ---

function collect(dir, prefix = '') {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    const files = [];
    for (const entry of entries) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const abs = path.join(dir, entry.name);
        if (abs === output) continue;
        if (entry.isDirectory()) {
            // Katalogu ignorowanego nie przeszukujemy, chyba że jakaś reguła "!" może coś z niego przywrócić
            const canReinclude = ignoreRules.some(r => r.negate && r.regex.source.includes(entry.name));
            if (isIgnored(rel, true) && !canReinclude) continue;
            files.push(...collect(abs, rel));
        } else if (entry.isFile()) {
            if (!isIgnored(rel, false)) files.push(rel);
        }
        // dowiązania symboliczne i pliki specjalne są pomijane
    }
    return files;
}

const files = collect(root);
const cleaned = [];
const entries = files.map(rel => {
    const abs = path.join(root, rel);
    const { content, note } = transform(rel, fs.readFileSync(abs));
    if (note) cleaned.push(`${rel} (${note})`);
    return {
        path: rel,
        mode: fs.statSync(abs).mode & 0o777,
        size: content.length,
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
        data: content.toString('base64'),
    };
});

const archive = zlib.gzipSync(Buffer.from(JSON.stringify(entries)), { level: 9 });
const encoded = archive.toString('base64');
const totalSize = entries.reduce((sum, e) => sum + e.size, 0);
const meta = {
    name,
    version: pkg?.version ?? null,
    createdAt: new Date().toISOString(),
    files: entries.length,
    size: totalSize,
    sha256: crypto.createHash('sha256').update(archive).digest('hex'),
};

// Dane w liniach po 120 znaków - plik da się otworzyć w edytorze i przejrzeć w diffie
const dataLines = encoded.match(/.{1,120}/g).join('\n');

const bundle = `#!/usr/bin/env node
/*
 * Samorozpakowujące się archiwum projektu "${meta.name}"${meta.version ? ` ${meta.version}` : ''}.
 * Utworzone ${meta.createdAt} przez tools/pack.mjs - plików: ${meta.files}, rozmiar: ${(totalSize / 1024).toFixed(0)} KB.
 *
 * Użycie (wymaga tylko Node.js >= 22):
 *   node ${path.basename(output)} [katalog]     odtwarza projekt (domyślnie ./${meta.name})
 *   node ${path.basename(output)} --list        lista plików w archiwum
 *   node ${path.basename(output)} --verify      sprawdza integralność archiwum
 *   --force                                     nadpisuje istniejące pliki w katalogu docelowym
 */
'use strict';

const META = ${JSON.stringify(meta, null, 2)};

const DATA = \`
${dataLines}
\`;

(function main() {
    // getBuiltinModule działa i w CommonJS, i w ESM (gdy obok jest package.json z "type": "module")
    const load = (id) => (typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule(id) : require(id));
    const fs = load('node:fs');
    const path = load('node:path');
    const zlib = load('node:zlib');
    const crypto = load('node:crypto');

    const argv = process.argv.slice(2);
    const flags = new Set(argv.filter(a => a.startsWith('--')));
    const positional = argv.filter(a => !a.startsWith('--'));
    const fail = (message) => {
        console.error('Błąd: ' + message);
        process.exit(1);
    };
    const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

    if (flags.has('--help') || flags.has('-h')) {
        console.log('Użycie: node ' + path.basename(process.argv[1]) + ' [katalog] [--force] [--list] [--verify]');
        return;
    }
    const unknown = [...flags].filter(f => !['--force', '--list', '--verify', '--help'].includes(f));
    if (unknown.length) fail('nieznane opcje: ' + unknown.join(', '));

    // 1. Rozpakowanie i weryfikacja archiwum
    const archive = Buffer.from(DATA.replace(/\\s+/g, ''), 'base64');
    if (sha256(archive) !== META.sha256) fail('archiwum jest uszkodzone (niezgodna suma SHA-256)');
    const entries = JSON.parse(zlib.gunzipSync(archive).toString('utf-8'));
    for (const e of entries) {
        if (sha256(Buffer.from(e.data, 'base64')) !== e.sha256) fail('uszkodzony plik w archiwum: ' + e.path);
    }

    if (flags.has('--list')) {
        for (const e of entries) console.log(String(e.size).padStart(9) + '  ' + e.path);
        console.log('\\n' + entries.length + ' plików, ' + (META.size / 1024).toFixed(0) + ' KB, utworzono ' + META.createdAt);
        return;
    }
    if (flags.has('--verify')) {
        console.log('OK: archiwum ' + META.name + ' jest kompletne (' + entries.length + ' plików, SHA-256 zgodne)');
        return;
    }

    // 2. Katalog docelowy i ochrona przed nadpisaniem
    const target = path.resolve(positional[0] || META.name);
    const resolve = (rel) => {
        const abs = path.resolve(target, rel);
        if (abs !== target && !abs.startsWith(target + path.sep)) fail('niebezpieczna ścieżka w archiwum: ' + rel);
        return abs;
    };
    const existing = entries.filter(e => fs.existsSync(resolve(e.path)));
    if (existing.length && !flags.has('--force')) {
        fail('w ' + target + ' istnieje już ' + existing.length + ' plików z archiwum (np. ' + existing[0].path + '). '
            + 'Wybierz inny katalog albo użyj --force, żeby je nadpisać.');
    }

    // 3. Odtworzenie plików ze strukturą katalogów i uprawnieniami
    for (const e of entries) {
        const abs = resolve(e.path);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, Buffer.from(e.data, 'base64'), { mode: e.mode });
        fs.chmodSync(abs, e.mode);
    }

    console.log('Odtworzono ' + entries.length + ' plików w ' + target + (existing.length ? ' (nadpisano ' + existing.length + ')' : ''));
    if (entries.some(e => e.path === 'package.json')) {
        console.log('\\nDalej:\\n  cd ' + path.relative(process.cwd(), target) + '\\n  npm ci\\n  cp .env.example .env   # uzupełnij konfigurację');
    }
})();
`;

fs.writeFileSync(output, bundle, { mode: 0o755 });
console.log(`Zapisano ${path.relative(process.cwd(), output) || output}: ${entries.length} plików, `
    + `${(totalSize / 1024).toFixed(0)} KB -> ${(bundle.length / 1024).toFixed(0)} KB (gzip + base64)`
    + (args.full ? ' - pełna kopia' : ''));
if (cleaned.length) console.log(`Wyczyszczone w archiwum:\n${cleaned.map(c => `  - ${c}`).join('\n')}`);
