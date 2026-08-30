/** A workspace known through an actual Agent execution. */
export interface ProjectRecord {
  /** Canonical absolute path and stable Project identity. */
  workspace: string
  /** Directory-derived display name; run names never define Project identity. */
  name: string
  /** Names of the currently visible execution records in this Project. */
  runNames: string[]
  /** Most recent activity across the visible execution records. */
  lastActiveAt: string
  /** Number of visible execution records grouped into this Project. */
  threadCount: number
  /** False when the historical workspace no longer exists as a directory. */
  available: boolean
}

export function projectDisplayName(
  project: Pick<ProjectRecord, 'name' | 'workspace'>,
): string {
  return project.name || project.workspace.split(/[\\/]/).filter(Boolean).at(-1) || project.workspace
}
