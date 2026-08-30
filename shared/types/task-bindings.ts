/** Bindings copied from a reusable task into one AgentRun snapshot. */

// ============================================================
// Task bindings
// ============================================================

export interface StandardTaskBindings {
  type: 'standard';
  /** Browser workers can only select environments from this pool. */
  boundEnvironmentIds?: string[];
}

export type AgentRunBindings = StandardTaskBindings;
