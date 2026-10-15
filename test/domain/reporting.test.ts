import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conditionalErrors, RawHtml, renderTemplate } from '../../src/domain/notification/html-template';
import { evaluateAttention } from '../../src/domain/reporting/attention';
import { computeRanking } from '../../src/domain/reporting/ranking';

const DAY = 86_400_000;
const now = Date.UTC(2026, 9, 14);
/** Seria liniowa: wartość start + rate * dzień, przez `days` dni do "now" */
const linear = (label: string, start: number, ratePerDay: number, days = 10) => ({
    label,
    points: Array.from({ length: days + 1 }, (_, i) => ({ timestamp: now - (days - i) * DAY, value: start + ratePerDay * i })),
});

test('Szablon: bloki {{#IF}} / {{#ELSE}} / {{#UNLESS}}, zagnieżdżenia, puste wartości', () => {
    const template = '{{#IF ATTENTION}}<b>Uwaga: {{ATTENTION_COUNT}}</b>{{#ELSE}}OK{{/IF}}'
        + '{{#UNLESS ATTENTION_COUNT}}[spokojnie]{{/UNLESS}}{{#IF A}}a{{#IF B}}b{{/IF}}{{/IF}}';
    assert.equal(renderTemplate(template, { ATTENTION: new RawHtml('<ul></ul>'), ATTENTION_COUNT: 2, A: 'x', B: '' }), '<b>Uwaga: 2</b>a');
    assert.equal(renderTemplate(template, { ATTENTION: new RawHtml('  '), ATTENTION_COUNT: 0, A: 'x', B: 'y' }), 'OK[spokojnie]ab');
    assert.deepEqual(conditionalErrors('{{#IF A}}x'), ['Niedomknięty blok {{#IF ...}} (brak {{/IF}})']);
    assert.deepEqual(conditionalErrors('{{#IF A}}{{/UNLESS}}'), ['Nadmiarowe lub źle zagnieżdżone {{/UNLESS}}']);
    assert.deepEqual(conditionalErrors('{{#IF A}}{{#UNLESS B}}{{/UNLESS}}{{/IF}}'), []);
});

test('Wymaga uwagi: próg, spadek, wzrost procentowy, prognoza trendu w horyzoncie', () => {
    const ctx = { source: 'Wykres', now, formatValue: (v: number) => `${Math.round(v)} GB`, formatDay: (t: number) => new Date(t).toISOString().slice(0, 10) };
    const growing = linear('SG1', 1000, 50); // 1000 -> 1500, +50/dobę

    assert.deepEqual(evaluateAttention({ above: 1400, below: 1600 }, growing, ctx).map(i => i.message), [
        'ostatnia wartość 1500 GB powyżej 1400 GB', 'ostatnia wartość 1500 GB poniżej 1600 GB',
    ]);
    assert.deepEqual(evaluateAttention({ growthPercent: 40 }, growing, ctx).map(i => i.message), ['wzrost o 50% w okresie (1000 GB → 1500 GB)']);
    // 2000 GB za 10 dni
    assert.deepEqual(evaluateAttention({ forecast: { threshold: 2000, within: '30d' } }, growing, ctx).map(i => i.message),
        ['wg trendu osiągnie 2000 GB ok. 2026-10-24 (za 10 dni)']);
    assert.deepEqual(evaluateAttention({ forecast: { threshold: 2000, within: '7d' } }, growing, ctx), []);
    assert.deepEqual(evaluateAttention({ forecast: { threshold: 2000, within: '30d' } }, linear('SG2', 1500, -10), ctx), []);
    assert.deepEqual(evaluateAttention({ above: 1 }, { label: 'pusta', points: [] }, ctx), []);
    assert.equal(evaluateAttention({ above: 1400 }, growing, ctx)[0].series, 'SG1');
});

test('Ranking: tempo z trendu, zmiana, procent, sortowanie, limit, data osiągnięcia progu', () => {
    const series = [linear('wolny', 1000, 5), linear('szybki', 500, 40), linear('spada', 2000, -20), { label: 'pusty', points: [] }];
    const byRate = computeRanking(series, { metric: 'rate', order: 'desc', limit: 2, threshold: 1000, now });
    assert.deepEqual(byRate.map(r => r.label), ['szybki', 'wolny']);
    assert.ok(Math.abs(byRate[0].ratePerDay! - 40) < 1e-9);
    assert.deepEqual([byRate[0].first, byRate[0].last, byRate[0].change], [500, 900, 400]);
    assert.equal(new Date(byRate[0].reachesThresholdAt!).toISOString().slice(0, 13), '2026-10-16T12'); // 900 + 40/dobę -> 1000 za 2,5 dnia
    assert.equal(byRate[1].reachesThresholdAt, null); // już powyżej progu

    assert.deepEqual(computeRanking(series, { metric: 'change-percent', order: 'desc', limit: 10, now }).map(r => r.label), ['szybki', 'wolny', 'spada']);
    assert.deepEqual(computeRanking(series, { metric: 'last', order: 'asc', limit: 1, now }).map(r => r.label), ['szybki']);
});
