import type { ResourceScope } from './lifecycle/resource-scope.js';

type ComponentRequirement = 'required' | 'optional';

interface StartContext {
  generation: string;
  startedAt: number;
  signal: AbortSignal;
}

export interface StopContext {
  generation: string;
  reason: string;
  deadlineAt: number;
  signal: AbortSignal;
}

interface VerifyContext {
  generation: string;
}

interface StopVerification {
  state: 'stopped' | 'live' | 'unknown';
  details?: Record<string, unknown>;
}

export interface RuntimeComponent<Ready = unknown> {
  readonly id: string;
  readonly requirement: ComponentRequirement;
  readonly dependsOn: readonly string[];
  readonly acceptsUnavailableDependencies?: readonly string[];
  readonly stopTimeoutMs?: number;

  start(context: StartContext, scope: ResourceScope): Promise<Ready>;
  stop(context: StopContext, ready: Ready | undefined): Promise<void>;
  forceClose?(context: StopContext, ready: Ready | undefined): Promise<void>;
  verifyStopped(context: VerifyContext): Promise<StopVerification>;
}

export interface ComponentManifest {
  readonly components: readonly RuntimeComponent[];
  readonly layers: readonly (readonly RuntimeComponent[])[];
}

export function createComponentManifest(
  components: readonly RuntimeComponent[],
): ComponentManifest {
  const byId = new Map<string, RuntimeComponent>();
  for (const component of components) {
    if (!component.id.trim()) throw new Error('Component id must not be empty');
    if (byId.has(component.id)) throw new Error(`Duplicate component id: ${component.id}`);
    byId.set(component.id, component);
  }

  for (const component of components) {
    for (const dependencyId of component.dependsOn) {
      const dependency = byId.get(dependencyId);
      if (!dependency) {
        throw new Error(`Component ${component.id} depends on unknown component ${dependencyId}`);
      }
      if (
        component.requirement === 'required'
        && dependency.requirement === 'optional'
        && !component.acceptsUnavailableDependencies?.includes(dependencyId)
      ) {
        throw new Error(
          `Required component ${component.id} depends on optional component ${dependencyId}`,
        );
      }
    }
  }

  const remaining = new Map(
    components.map((component) => [component.id, new Set(component.dependsOn)]),
  );
  const layers: RuntimeComponent[][] = [];
  const emitted = new Set<string>();

  while (emitted.size < components.length) {
    const layer = components.filter((component) => (
      !emitted.has(component.id)
      && [...remaining.get(component.id)!].every((dependency) => emitted.has(dependency))
    ));
    if (layer.length === 0) {
      const unresolved = components
        .filter((component) => !emitted.has(component.id))
        .map((component) => component.id)
        .join(', ');
      throw new Error(`Component dependency cycle: ${unresolved}`);
    }
    layers.push(layer);
    for (const component of layer) emitted.add(component.id);
  }

  return Object.freeze({
    components: Object.freeze([...components]),
    layers: Object.freeze(layers.map((layer) => Object.freeze([...layer]))),
  });
}
