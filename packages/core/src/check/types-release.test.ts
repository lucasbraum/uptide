import { describe, expect, it } from 'vitest';
import { typedPackageOf, typesPackageOf, typesReleaseFor } from './types-release.js';

const published = ['18.2.0', '18.3.31', '19.0.0', '19.0.14', '19.1.0-rc.1', '19.2.7', '19.3.0'];

describe('the @types release that types a runtime version', () => {
  it('prefers the newest release at the target major.minor, then the major, then the newest', () => {
    expect(typesReleaseFor(published, '19.0.0', '18.2.0')).toBe('19.0.14');
    expect(typesReleaseFor(published, '19.2.1', '18.3.31')).toBe('19.2.7');
    // No release for the minor: the major's newest.
    expect(typesReleaseFor(published, '19.1.0', '18.2.0')).toBe('19.3.0');
    // No release for the major (a 0.x package typed by @types 1.x): the newest there is.
    expect(typesReleaseFor(['1.0.0', '1.1.0'], '0.7.0', '1.0.0')).toBe('1.1.0');
  });

  it('never goes below what is installed, and skips prereleases', () => {
    expect(typesReleaseFor(published, '18.3.1', '19.0.0')).toBe('19.3.0');
    expect(typesReleaseFor(['19.1.0-rc.1'], '19.1.0')).toBeUndefined();
    expect(typesReleaseFor([], '19.0.0')).toBeUndefined();
  });

  it('names the types package of a runtime package and back', () => {
    expect(typesPackageOf('react')).toBe('@types/react');
    expect(typesPackageOf('@scope/name')).toBe('@types/scope__name');
    expect(typedPackageOf('@types/scope__name')).toBe('@scope/name');
    expect(typedPackageOf('react')).toBeUndefined();
  });
});
