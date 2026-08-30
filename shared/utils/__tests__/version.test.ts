import { describe, expect, it } from 'vitest'

import { compareVersions, isVersionNewer } from '../version.js'

describe('shared version comparison', () => {
  it('compares release numbers numerically', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('v2.0', '2.0.0')).toBe(0)
  })

  it('orders prereleases below releases using semver rules', () => {
    expect(compareVersions('1.0.0', '1.0.0-rc.2')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-rc.10', '1.0.0-rc.2')).toBeGreaterThan(0)
    expect(isVersionNewer('1.0.0', '1.0.0')).toBe(false)
  })
})
