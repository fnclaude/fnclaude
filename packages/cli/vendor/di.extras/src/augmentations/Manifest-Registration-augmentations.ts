import type { LifetimeArgument, Manifest, Registration, RegistrationBuilderFor } from '@rhombus-std/di.core';
import { registerInlineBodies, typefor } from '@rhombus-std/primitives.extras';
import type { AbstractCtor, ButNot, Ctor, Func } from '@rhombus-toolkit/types';

declare module '@rhombus-std/di.core' {
  interface Manifest<Lifetime> {
    /**
     * Registers a constructor as the implementation of `ServiceType`, the service type derived from the
     * type argument instead of taken explicitly.
     */
    add<ServiceType>(implementer: Ctor<any[], ServiceType>, ...lifetime: LifetimeArgument<Lifetime>): Manifest<Lifetime>;
    /**
     * Registers a factory as the producer of `ServiceType`, the service type derived from the
     * type argument instead of taken explicitly.
     */
    add<ServiceType>(implementer: Func<any[], ServiceType>, ...lifetime: LifetimeArgument<Lifetime>): Manifest<Lifetime>;
    /**
     * Registers a non-callable `value` as-is under `ServiceType`, the service type derived from
     * the type argument instead of taken explicitly. A callable lands on the shapes above
     * instead; {@link Manifest.addValue} is the door that forces one down the value path. A
     * registration stream lands on {@link Manifest.add}'s own batch shape instead, so this
     * overload never captures it either.
     */
    add<ServiceType>(value: ButNot<ServiceType, Func | AbstractCtor | Registration<any> | Iterable<Registration<any>>>): Manifest<Lifetime>;
    /**
     * Registers `value` as-is under `ServiceType`, the service type derived from the type
     * argument instead of taken explicitly.
     */
    addValue<ServiceType>(value: ServiceType): Manifest<Lifetime>;

    /** {@link Manifest.add}'s constructor shape, registering only when the service type has no registration yet. */
    tryAdd<ServiceType>(implementer: Ctor<any[], ServiceType>, ...lifetime: LifetimeArgument<Lifetime>): Manifest<Lifetime>;
    /** {@link Manifest.add}'s factory shape, registering only when the service type has no registration yet. */
    tryAdd<ServiceType>(implementer: Func<any[], ServiceType>, ...lifetime: LifetimeArgument<Lifetime>): Manifest<Lifetime>;
    /** {@link Manifest.add}'s value shape, registering only when the service type has no registration yet. */
    tryAdd<ServiceType>(value: ButNot<ServiceType, Func | AbstractCtor | Registration<any>>): Manifest<Lifetime>;
    /** {@link Manifest.addValue}, registering only when the service type has no registration yet. */
    tryAddValue<ServiceType>(value: ServiceType): Manifest<Lifetime>;

    /** {@link Manifest.add}'s constructor shape, replacing the service type's existing registration. */
    replace<ServiceType>(implementer: Ctor<any[], ServiceType>, ...lifetime: LifetimeArgument<Lifetime>): Manifest<Lifetime>;
    /** {@link Manifest.add}'s factory shape, replacing the service type's existing registration. */
    replace<ServiceType>(implementer: Func<any[], ServiceType>, ...lifetime: LifetimeArgument<Lifetime>): Manifest<Lifetime>;
    /** {@link Manifest.add}'s value shape, replacing the service type's existing registration. */
    replace<ServiceType>(value: ButNot<ServiceType, Func | AbstractCtor | Registration<any>>): Manifest<Lifetime>;
    /** {@link Manifest.addValue}, replacing the service type's existing registration. */
    replaceValue<ServiceType>(value: ServiceType): Manifest<Lifetime>;

    /**
     * Drops every registration of `ServiceType`, the service type derived from the type argument
     * instead of taken explicitly.
     */
    removeAll<ServiceType>(): Manifest<Lifetime>;

    /**
     * {@link Manifest.describe} with `ServiceType` derived from the type argument instead of
     * taken explicitly.
     */
    describe<ServiceType>(): RegistrationBuilderFor<ServiceType, Lifetime>;
  }
}

export const ManifestRegistrationAugmentations = {
  add<ServiceType>(this: Manifest<unknown>, implementer: any, lifetime?: unknown): Manifest<unknown> {
    return this.add(typefor<ServiceType>(), implementer, typefor(implementer), lifetime);
  },
  addValue<ServiceType>(this: Manifest<unknown>, value: ServiceType): Manifest<unknown> {
    return this.addValue(typefor<ServiceType>(), value);
  },
  tryAdd<ServiceType>(this: Manifest<unknown>, implementer: any, lifetime?: unknown): Manifest<unknown> {
    return this.tryAdd(typefor<ServiceType>(), implementer, typefor(implementer), lifetime);
  },
  tryAddValue<ServiceType>(this: Manifest<unknown>, value: ServiceType): Manifest<unknown> {
    return this.tryAddValue(typefor<ServiceType>(), value);
  },
  replace<ServiceType>(this: Manifest<unknown>, implementer: any, lifetime?: unknown): Manifest<unknown> {
    return this.replace(typefor<ServiceType>(), implementer, typefor(implementer), lifetime);
  },
  replaceValue<ServiceType>(this: Manifest<unknown>, value: ServiceType): Manifest<unknown> {
    return this.replaceValue(typefor<ServiceType>(), value);
  },
  removeAll<ServiceType>(this: Manifest<unknown>): Manifest<unknown> {
    return this.removeAll(typefor<ServiceType>());
  },
  describe<ServiceType>(this: Manifest<unknown>) {
    return this.describe(typefor<ServiceType>());
  },
};
registerInlineBodies<Manifest<unknown>>(ManifestRegistrationAugmentations);

// A separate set because its `add` is the value shape's own body — an object literal cannot
// carry a second `add` beside the callable blanket above.
export const ManifestRegistrationValueAugmentations = {
  add<ServiceType>(this: Manifest<unknown>, value: ButNot<ServiceType, Func | AbstractCtor | Registration<any> | Iterable<Registration<any>>>): Manifest<unknown> {
    return this.addValue(typefor<ServiceType>(), value);
  },
  tryAdd<ServiceType>(this: Manifest<unknown>, value: ButNot<ServiceType, Func | AbstractCtor | Registration<any>>): Manifest<unknown> {
    return this.tryAddValue(typefor<ServiceType>(), value);
  },
  replace<ServiceType>(this: Manifest<unknown>, value: ButNot<ServiceType, Func | AbstractCtor | Registration<any>>): Manifest<unknown> {
    return this.replaceValue(typefor<ServiceType>(), value);
  },
};
registerInlineBodies<Manifest<unknown>>(ManifestRegistrationValueAugmentations);
