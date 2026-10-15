import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTimeExpression, TimeRange } from '../../src/domain/shared/time-range';
import { ValidationError } from '../../src/shared/errors';

// Środa 15.10.2026, 14:30:00 czasu lokalnego
const NOW = new Date(2026, 9, 15, 14, 30, 0);
const local = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} `
    + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;

test('Wyrażenia czasu jak w Grafanie', () => {
    const cases: [string, boolean, string][] = [
        ['now', false, '2026-10-15 14:30:00'],
        ['now-7d', false, '2026-10-08 14:30:00'],
        ['now-2h', false, '2026-10-15 12:30:00'],
        ['now/d', false, '2026-10-15 00:00:00'],
        ['now/d', true, '2026-10-15 23:59:59'],
        ['now/w', false, '2026-10-12 00:00:00'], // tydzień od poniedziałku
        ['now-1M/M', false, '2026-09-01 00:00:00'],
        ['now-1M/M', true, '2026-09-30 23:59:59'],
        ['now-1y/y', false, '2025-01-01 00:00:00'],
        ['2026-09-01', false, '2026-09-01 00:00:00'],
        ['2026-09-30', true, '2026-09-30 23:59:59'], // data bez godziny jako koniec = do końca dnia
        ['2026-09-30 12:15', true, '2026-09-30 12:15:00'],
    ];
    for (const [expr, roundUp, expected] of cases) {
        assert.equal(local(parseTimeExpression(expr, NOW, roundUp)), expected, `${expr} (roundUp=${roundUp})`);
    }
});

test('Zakresy: skrót, poprzedni miesiąc, błędy', () => {
    const week = TimeRange.fromSpec('7d', NOW);
    assert.equal(local(week.from), '2026-10-08 14:30:00');
    assert.equal(week.to.getTime(), NOW.getTime());

    const lastMonth = TimeRange.fromSpec({ from: 'now-1M/M', to: 'now-1M/M' }, NOW);
    assert.equal(local(lastMonth.from), '2026-09-01 00:00:00');
    assert.equal(local(lastMonth.to), '2026-09-30 23:59:59');

    for (const bad of ['tydzień', 'now-7x', '2026-13-01']) {
        assert.throws(() => parseTimeExpression(bad, NOW), ValidationError, bad);
    }
    assert.throws(() => TimeRange.fromSpec({ from: 'now', to: 'now-1d' }, NOW), ValidationError);
});

test('Okres porównawczy: poprzedni tej samej długości albo przesunięcie kalendarzowe (cały miesiąc -> cały miesiąc)', () => {
    const now = new Date(2026, 9, 14, 12, 0);
    const week = TimeRange.fromSpec('7d', now).shiftedBack();
    assert.deepEqual([week.from, week.to], [new Date(2026, 8, 30, 12, 0), new Date(2026, 9, 7, 12, 0)]);

    const september = TimeRange.fromSpec({ from: 'now-1M/M', to: 'now-1M/M' }, now);
    const august = september.shiftedBack('1M');
    assert.deepEqual([august.from, august.to], [new Date(2026, 7, 1), new Date(2026, 7, 31, 23, 59, 59, 999)]);
    assert.throws(() => september.shiftedBack('wczoraj'), ValidationError);
});
