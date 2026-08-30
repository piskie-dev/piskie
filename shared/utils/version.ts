/** Semver-compatible comparison used by both market projection and installed UI. */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) {
    return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
  }
  for (let index = 0; index < 3; index++) {
    const difference = a.release[index]! - b.release[index]!
    if (difference !== 0) return Math.sign(difference)
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0
    return a.prerelease.length === 0 ? 1 : -1
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index++) {
    const aPart = a.prerelease[index]
    const bPart = b.prerelease[index]
    if (aPart === undefined || bPart === undefined) return aPart === undefined ? -1 : 1
    if (aPart === bPart) continue
    const aNumber = /^\d+$/.test(aPart) ? Number(aPart) : undefined
    const bNumber = /^\d+$/.test(bPart) ? Number(bPart) : undefined
    if (aNumber !== undefined && bNumber !== undefined) return Math.sign(aNumber - bNumber)
    if (aNumber !== undefined || bNumber !== undefined) return aNumber !== undefined ? -1 : 1
    return aPart.localeCompare(bPart)
  }
  return 0
}

export function isVersionNewer(candidate: string | undefined, installed: string | undefined): boolean {
  return Boolean(candidate && installed && compareVersions(candidate, installed) > 0)
}

function parseVersion(value: string): { release: [number, number, number]; prerelease: string[] } | null {
  const match = value.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!match) return null
  return {
    release: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)],
    prerelease: match[4]?.split('.') ?? [],
  }
}
