import { type AugmentationSet, type MergeStrategies, registerAugmentations as register } from '@rhombus-std/primitives';

import { typefor } from './typefor.js';

/**
 * Register `set`'s members against the receiver type `R` —
 * `registerAugmentations<IConfigBuilder>(ConfigBuilderJsonAugmentations)`.
 *
 * @remarks
 * The receiver arrives as a type argument, so no call site has to spell its `Type`.
 * Resolved at compile time; calling this without that resolution throws.
 *
 * A receiver reachable only as a VALUE — a composed `Type`, or one held in a variable —
 * has no type to name here. Register it through `@rhombus-std/primitives`' form, which
 * takes the receiver as its first argument.
 *
 * @example
 * ```ts
 * registerAugmentations<IConfigBuilder>(ConfigBuilderJsonAugmentations);
 * // → registerAugmentations(Type.imported('IConfigBuilder', '@rhombus-std/config.core'), ConfigBuilderJsonAugmentations)
 * ```
 */
export function registerAugmentations<R>(set: AugmentationSet<R>, merge?: MergeStrategies<R>): void {
  return register<R>(typefor<R>(), set, merge);
}

export const REGISTER_AUGMENTATIONS_NAME = 'registerAugmentations';
