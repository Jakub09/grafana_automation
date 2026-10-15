import { test } from 'node:test';
import assert from 'node:assert/strict';
import { niceStep } from '../../src/infrastructure/charting/chart-drawing';

test('niceStep: okrągłe podziałki osi', () => {
    assert.equal(niceStep(2.13), 0.5);
    assert.equal(niceStep(100), 20);
    assert.equal(niceStep(11), 2.5);
    assert.equal(niceStep(2300), 500);
    assert.equal(niceStep(0.07), 0.02);
});
