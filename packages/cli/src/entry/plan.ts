/**
 * Plan root (design.di-architecture §2b): a short-lived async container that emits
 * the frozen {@link LaunchPlan} and is disposed before returning it.
 *
 * Config is loaded BEFORE the chain opens — it is an input to composition, plain
 * per-field-degraded data, not a service the container constructs (doctrine 7).
 */

import {
  Builder,
  standardLifetime,
  validateBuildability,
  validateScopes,
  validateUniversalAddresses,
} from '@rhombus-std/di';
import type {} from '@rhombus-std/di.extras';

import { loadConfig } from '../config/load';
import { registerPlanServices } from '../launch/register';
import type { IPlanner, LaunchInputs, LaunchPlan } from '../launch/contracts';

/** Load config, build the plan container, resolve the Planner, and emit its frozen plan. */
export async function buildLaunchPlan(inputs: LaunchInputs): Promise<LaunchPlan> {
  const cfg = await loadConfig({ env: inputs.xdg });
  await using provider = Builder.useAddon(validateUniversalAddresses())
    .useAddon(validateBuildability())
    .useAddon(validateScopes())
    .useAddon(standardLifetime())
    .withServices((m) => registerPlanServices(m, inputs, cfg))
    .build();
  return await provider.resolve<IPlanner>().plan();
}
