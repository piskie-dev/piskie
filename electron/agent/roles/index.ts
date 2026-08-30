/**
 * Role 工厂
 */

import type { AgentRole, RoleType } from './role.js';
import { DirectorRole } from './director.role.js';
import { WorkerRole } from './worker.role.js';

export function createRole(type: RoleType): AgentRole {
  switch (type) {
    case 'director':
      return new DirectorRole();
    case 'worker':
      return new WorkerRole();
  }
}
