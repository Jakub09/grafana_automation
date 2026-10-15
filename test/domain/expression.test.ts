import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MathExpression } from '../../src/domain/metrics/expression';
import { TimeSeries } from '../../src/domain/metrics/time-series';
import { ValidationError } from '../../src/shared/errors';

const ts = (tags: Record<string, string>, values: [number, number][]) => new TimeSeries('m', tags, values.map(([timestamp, value]) => ({ timestamp, value })));

test('Wyrażenie math: kolejność działań, nawiasy, ${A}, minus, wspólne chwile serii, dzielenie przez 0 pomijane', () => {
    const series = new Map([
        ['A', [ts({}, [[1, 50], [2, 60], [3, 70], [4, 5]])]],
        ['B', [ts({}, [[1, 100], [2, 120], [4, 0]])]],
    ]);
    assert.deepEqual(new MathExpression('$A / $B').apply(series)[0].points, [{ timestamp: 1, value: 0.5 }, { timestamp: 2, value: 0.5 }]);
    assert.deepEqual(new MathExpression('(${A} - $B) * -2 + 1').apply(series)[0].points.map(p => p.value), [101, 121, -9]);
    assert.deepEqual(new MathExpression('$A / $B * 100').refs, ['A', 'B']);
});

test('Wyrażenie math: serie z GROUP BY tag łączone po tagach, seria pojedyncza pasuje do każdej', () => {
    const series = new Map([
        ['A', [ts({ SGN: 'SG1' }, [[1, 10]]), ts({ SGN: 'SG2' }, [[1, 30]])]],
        ['B', [ts({ SGN: 'SG2' }, [[1, 60]]), ts({ SGN: 'SG1' }, [[1, 40]])]],
        ['K', [ts({}, [[1, 2]])]],
    ]);
    const result = new MathExpression('$A / $B * $K').apply(series);
    assert.deepEqual(result.map(r => [r.tags.SGN, r.points[0].value]), [['SG1', 0.5], ['SG2', 1]]);
});

test('Wyrażenie math: błędy składni i brakujące zapytania', () => {
    assert.throws(() => new MathExpression('$A /'), ValidationError);
    assert.throws(() => new MathExpression('$A $B'), /nadmiarowy/);
    assert.throws(() => new MathExpression('2 + 2'), /nie odwołuje się/);
    assert.throws(() => new MathExpression('$A % $B'), /niezrozumiały/);
    assert.throws(() => new MathExpression('$A / $C').apply(new Map([['A', []]])), /brak zapytania C/);
});
