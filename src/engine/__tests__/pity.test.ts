import { describe, expect, it } from 'vitest';
import { char4Rate, char5Rate, weapon4Rate, weapon5Rate } from '../pity';

describe('char5Rate', () => {
  it('is 0.6% before soft pity', () => {
    expect(char5Rate(1)).toBeCloseTo(0.006);
    expect(char5Rate(73)).toBeCloseTo(0.006);
  });
  it('ramps by 6%/pull during soft pity', () => {
    expect(char5Rate(74)).toBeCloseTo(0.066);
    expect(char5Rate(75)).toBeCloseTo(0.126);
    expect(char5Rate(89)).toBeCloseTo(0.966);
  });
  it('is guaranteed at hard pity', () => {
    expect(char5Rate(90)).toBe(1);
    expect(char5Rate(91)).toBe(1);
  });
});

describe('weapon5Rate', () => {
  it('is 0.7% before soft pity', () => {
    expect(weapon5Rate(1)).toBeCloseTo(0.007);
    expect(weapon5Rate(62)).toBeCloseTo(0.007);
  });
  it('ramps 7% per pull during soft pity', () => {
    expect(weapon5Rate(63)).toBeCloseTo(0.077);
    expect(weapon5Rate(76)).toBeCloseTo(0.987);
  });
  it('is guaranteed from pull 77 (not the in-game description\'s 80)', () => {
    expect(weapon5Rate(77)).toBe(1);
    expect(weapon5Rate(80)).toBe(1);
  });
});

describe('char4Rate', () => {
  it('is 5.1% before soft pity', () => {
    expect(char4Rate(1)).toBeCloseTo(0.051);
    expect(char4Rate(8)).toBeCloseTo(0.051);
  });
  it('jumps at pull 9', () => {
    expect(char4Rate(9)).toBeCloseTo(0.561);
  });
  it('is guaranteed at pull 10', () => {
    expect(char4Rate(10)).toBe(1);
    expect(char4Rate(11)).toBe(1);
  });
});

describe('weapon4Rate', () => {
  it('is 6% before soft pity — higher than the character banner', () => {
    expect(weapon4Rate(1)).toBeCloseTo(0.06);
    expect(weapon4Rate(7)).toBeCloseTo(0.06);
    expect(char4Rate(1)).toBeLessThan(weapon4Rate(1));
  });
  it('jumps at pull 8', () => {
    expect(weapon4Rate(8)).toBeCloseTo(0.66);
  });
  it('is guaranteed from pull 9', () => {
    expect(weapon4Rate(9)).toBe(1);
    expect(weapon4Rate(10)).toBe(1);
  });
  it('averages out close to the official 14.5% consolidated rate', () => {
    let survival = 1;
    let expectedPulls = 0;
    for (let n = 1; n <= 10; n++) {
      expectedPulls += n * survival * weapon4Rate(n);
      survival *= 1 - weapon4Rate(n);
    }
    expect(1 / expectedPulls).toBeGreaterThan(0.14);
    expect(1 / expectedPulls).toBeLessThan(0.15);
  });
});
