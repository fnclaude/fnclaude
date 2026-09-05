import type { LifetimeArgument, Manifest, Registration, RegistrationBuilderFor } from '@rhombus-std/di.core';
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
export declare const ManifestRegistrationAugmentations: {
    add<ServiceType>(this: Manifest<unknown>, implementer: any, lifetime?: unknown): Manifest<unknown>;
    addValue<ServiceType>(this: Manifest<unknown>, value: ServiceType): Manifest<unknown>;
    tryAdd<ServiceType>(this: Manifest<unknown>, implementer: any, lifetime?: unknown): Manifest<unknown>;
    tryAddValue<ServiceType>(this: Manifest<unknown>, value: ServiceType): Manifest<unknown>;
    replace<ServiceType>(this: Manifest<unknown>, implementer: any, lifetime?: unknown): Manifest<unknown>;
    replaceValue<ServiceType>(this: Manifest<unknown>, value: ServiceType): Manifest<unknown>;
    removeAll<ServiceType>(this: Manifest<unknown>): Manifest<unknown>;
    describe<ServiceType>(this: Manifest<unknown>): RegistrationBuilderFor<any, unknown>;
};
export declare const ManifestRegistrationValueAugmentations: {
    add<ServiceType>(this: Manifest<unknown>, value: ButNot<ServiceType, Func | AbstractCtor | Registration<any> | Iterable<Registration<any>>>): Manifest<unknown>;
    tryAdd<ServiceType>(this: Manifest<unknown>, value: ButNot<ServiceType, Func | AbstractCtor | Registration<any>>): Manifest<unknown>;
    replace<ServiceType>(this: Manifest<unknown>, value: ButNot<ServiceType, Func | AbstractCtor | Registration<any>>): Manifest<unknown>;
};
