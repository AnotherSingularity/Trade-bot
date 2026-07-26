import { describe, expect, it } from 'vitest';
import { createServiceAdapters, assertProductionRunner, ProductionAdapterViolation } from '../src/main/serviceAdapterFactory';
import { ChildProcessCommandRunner, InMemoryCommandRunner } from '../src/main/commandRunner';

describe('stage1 §13 — production adapter factory', () => {
  it('T-S1.1: production boot cannot instantiate InMemoryRunner', () => {
    const h = createServiceAdapters({ environment: 'production', serviceMode: 'managed_docker' });
    expect(h.runner.kind).toBe('ChildProcessCommandRunner');
    expect(() => assertProductionRunner(new InMemoryCommandRunner())).toThrow(ProductionAdapterViolation);
    // Cannot pass developmentFake in production.
    expect(() => createServiceAdapters({ environment: 'production', serviceMode: 'managed_docker', developmentFake: true })).toThrow(ProductionAdapterViolation);
  });

  it('T-S1.2: production boot rejects stub environment values', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => createServiceAdapters({ environment: 'stub' as any, serviceMode: 'managed_docker' })).toThrow(ProductionAdapterViolation);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => createServiceAdapters({ environment: 'production', serviceMode: 'fake' as any })).toThrow(ProductionAdapterViolation);
  });

  it('T-S1.31: production_fake adapters are rejected (developmentFake at packaged build)', () => {
    expect(() => createServiceAdapters({ environment: 'development', serviceMode: 'external_services', developmentFake: true, isPackagedBuild: true })).toThrow(ProductionAdapterViolation);
  });

  it('T-S1.32: packaged development fake is rejected', () => {
    expect(() => createServiceAdapters({ environment: 'development', serviceMode: 'managed_docker', developmentFake: true, isPackagedBuild: true })).toThrow(ProductionAdapterViolation);
  });

  it('T-S1.30: test adapters use InMemoryCommandRunner', () => {
    const h = createServiceAdapters({ environment: 'test', serviceMode: 'managed_docker' });
    expect(h.runner.kind).toBe('InMemoryCommandRunner');
  });

  it('T-S1.30b: dev without fake gets real runner', () => {
    const h = createServiceAdapters({ environment: 'development', serviceMode: 'external_services' });
    expect(h.runner.kind).toBe('ChildProcessCommandRunner');
  });

  it('T-S1.assertProductionRunner: throws on wrong runner kind', () => {
    expect(() => assertProductionRunner(new ChildProcessCommandRunner())).not.toThrow();
    expect(() => assertProductionRunner(new InMemoryCommandRunner())).toThrow(ProductionAdapterViolation);
  });
});
