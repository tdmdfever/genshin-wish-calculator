import { describe, expect, it } from 'vitest';
import { char4Rate, char5Rate, weapon5Rate } from '../pity';

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
  it('ramps during soft pity to hard pity', () => {
    expect(weapon5Rate(63)).toBeGreaterThan(0.007);
    expect(weapon5Rate(79)).toBeLessThan(1);
  });
  it('is guaranteed at hard pity', () => {
    expect(weapon5Rate(80)).toBe(1);
    expect(weapon5Rate(81)).toBe(1);
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
