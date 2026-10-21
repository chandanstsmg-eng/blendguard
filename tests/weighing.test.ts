import { describe, expect, it } from 'vitest';
import { acceptanceWindow, evaluate, grams } from '../shared/weighing.js';

const line = { targetMg: 180_000, tolMinusMg: 500, tolPlusMg: 500 };
const scale = { resolutionMg: 10, uncertaintyMg: 20, validated: true };
const read = (grossMg: number | null, stable = true, connected = true) => ({ grossMg, stable, connected, at: Date.now() });

describe('weight acceptance', () => {
  it('guard-bands the tolerance by the measurement uncertainty', () => {
    expect(acceptanceWindow(line, scale)).toMatchObject({ acceptLowMg: 179_520, acceptHighMg: 180_480, lowLimitMg: 179_500, highLimitMg: 180_500 });
  });

  it('accepts only stable readings inside the guard-banded window', () => {
    const tare = 400_000;
    expect(evaluate(read(tare + 180_000), tare, line, scale).verdict).toBe('OK');
    expect(evaluate(read(tare + 179_520), tare, line, scale).verdict).toBe('OK');
    expect(evaluate(read(tare + 180_480), tare, line, scale).verdict).toBe('OK');
    // Inside the nominal tolerance but inside the uncertainty band: not certifiable, not accepted.
    expect(evaluate(read(tare + 179_510), tare, line, scale).verdict).toBe('UNDER');
    expect(evaluate(read(tare + 180_490), tare, line, scale).verdict).toBe('OVER');
    expect(evaluate(read(tare + 178_500), tare, line, scale)).toMatchObject({ verdict: 'UNDER', remainingMg: 1_500 });
    expect(evaluate(read(tare + 180_000, false), tare, line, scale).verdict).toBe('UNSTABLE');
  });

  it('refuses to decide without a connected, validated, zeroed scale', () => {
    expect(evaluate(read(null, true, false), 0, line, scale).verdict).toBe('DISCONNECTED');
    expect(evaluate(read(180_000), 0, line, { ...scale, validated: false }).verdict).toBe('NOT_VALIDATED');
    expect(evaluate(read(180_000), null, line, scale).verdict).toBe('NOT_TARED');
  });

  it('cannot certify when the scale is too coarse for the tolerance', () => {
    const tiny = { targetMg: 4_500, tolMinusMg: 50, tolPlusMg: 50 };
    expect(evaluate(read(4_500), 0, tiny, { resolutionMg: 100, uncertaintyMg: 100, validated: true }).verdict).toBe('CANNOT_CERTIFY');
    expect(evaluate(read(4_500), 0, tiny, scale).verdict).toBe('OK');
  });

  it('formats grams without rounding up', () => {
    expect(grams(179_999, 2)).toBe('179.99');
    expect(grams(4_500, 2)).toBe('4.50');
    expect(grams(-1_230, 2)).toBe('-1.23');
    expect(grams(180_000, 1)).toBe('180.0');
  });
});
