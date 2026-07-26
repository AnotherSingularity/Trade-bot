/**
 * Stage 1 §13 — Explicit adapter mode factory.
 *
 * Production may never select the in-memory runner or a stub health
 * probe. Tests get deterministic fakes. Development explicitly opts
 * in to fakes via a visible flag.
 */

import { ChildProcessCommandRunner, InMemoryCommandRunner, type CommandRunner } from './commandRunner';

export type Environment = 'production' | 'development' | 'test';
export type ServiceMode = 'managed_docker' | 'external_services';

export interface AdapterFactoryInput {
  environment: Environment;
  serviceMode: ServiceMode;
  isPackagedBuild?: boolean;
  developmentFake?: boolean;
}

export class ProductionAdapterViolation extends Error {
  constructor(reason: string) { super(`production_adapter_violation: ${reason}`); }
}

export interface AdapterHandles {
  runner: CommandRunner;
  environment: Environment;
  serviceMode: ServiceMode;
}

export function createServiceAdapters(input: AdapterFactoryInput): AdapterHandles {
  const env: Environment = input.environment;
  if (env !== 'production' && env !== 'development' && env !== 'test') {
    throw new ProductionAdapterViolation(`unknown_environment: ${String(env)}`);
  }
  if (input.serviceMode !== 'managed_docker' && input.serviceMode !== 'external_services') {
    throw new ProductionAdapterViolation(`unknown_service_mode: ${String(input.serviceMode)}`);
  }
  if (env === 'production') {
    if (input.developmentFake) throw new ProductionAdapterViolation('developmentFake_forbidden_in_production');
    return {
      runner: new ChildProcessCommandRunner(),
      environment: 'production',
      serviceMode: input.serviceMode,
    };
  }
  if (env === 'development') {
    if (input.isPackagedBuild && input.developmentFake) {
      throw new ProductionAdapterViolation('developmentFake_forbidden_in_packaged_build');
    }
    return {
      runner: input.developmentFake ? new InMemoryCommandRunner() : new ChildProcessCommandRunner(),
      environment: 'development',
      serviceMode: input.serviceMode,
    };
  }
  // test
  return {
    runner: new InMemoryCommandRunner(),
    environment: 'test',
    serviceMode: input.serviceMode,
  };
}

export function assertProductionRunner(runner: CommandRunner): void {
  if (runner.kind !== 'ChildProcessCommandRunner') {
    throw new ProductionAdapterViolation(`production_runner_must_be_child_process; got=${runner.kind}`);
  }
}
