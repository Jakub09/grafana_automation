import { test } from 'node:test';
import assert from 'node:assert/strict';
import { darken, lastCrossing, linearTrend, movingAverage } from '../../src/domain/charting/series-math';

const DAY = 86_400_000;

test('linearTrend: dokładna prosta, czas osiągnięcia wartości, przypadki brzegowe', () => {
    // 100 + 10/dobę
    const points = [0, 1, 2, 3].map(d => ({ timestamp: d * DAY, value: 100 + 10 * d }));
    const trend = linearTrend(points)!;
    assert.equal(trend.slopePerDay, 10);
    assert.equal(trend.valueAt(10 * DAY), 200);
    assert.equal(trend.timeOf(150), 5 * DAY);

    assert.equal(linearTrend(points.slice(0, 1)), null);
    assert.equal(linearTrend([{ timestamp: 5, value: 1 }, { timestamp: 5, value: 2 }]), null);
    assert.equal(linearTrend([{ timestamp: 0, value: 7 }, { timestamp: DAY, value: 7 }])!.timeOf(8), null);
});

test('movingAverage: okno czasowe, także przy lukach w danych', () => {
    const h = 3_600_000;
    const points = [0, 1, 2, 3, 10].map(i => ({ timestamp: i * h, value: i }));
    assert.deepEqual(movingAverage(points, 2 * h).map(p => p.value), [0, 0.5, 1.5, 2.5, 10]); // po luce okno zawiera 1 punkt
});

test('darken: ciemniejszy odcień', () => {
    assert.equal(darken('#ffffff', 0.5), '#808080');
});

test('lastCrossing: ostatnie przejście przez próg w kierunku alertu', () => {
    const pts = [100, 120, 90, 95, 130, 140].map((value, i) => ({ timestamp: i * 1000, value }));
    assert.equal(lastCrossing(pts, 110, 'gt'), 4000); // 95 -> 130 (wcześniejsze 100 -> 120 pominięte)
    assert.equal(lastCrossing(pts, 100, 'lt'), 2000); // 120 -> 90
    assert.equal(lastCrossing(pts, 50, 'gt'), null); // cały czas powyżej - brak przejścia
});
