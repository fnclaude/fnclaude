import type { CtorRegistration, FactoryRegistration } from '@rhombus-std/di.core';
import type { IAsImplementer, RegistrationBuilder, Slot } from '@rhombus-std/di.core/builders';
import type { AbstractCtor, Ctor, Func } from '@rhombus-toolkit/types';
declare module '@rhombus-std/di.core/builders' {
    interface IAsImplementer<T, Lifetime, Slots extends Slot> {
        /**
         * Takes the constructor door with the implementer's type observed from `ctor` instead of
         * taken explicitly.
         */
        asClass(ctor: AbstractCtor<any[], T> & Ctor): RegistrationBuilder<T, Lifetime, Exclude<Slots, 'implementer'>, CtorRegistration<Lifetime>>;
        /**
         * Takes the factory door with the producer's type observed from `fn` instead of taken
         * explicitly.
         */
        asFactory(fn: Func<any[], T>): RegistrationBuilder<T, Lifetime, Exclude<Slots, 'implementer'>, FactoryRegistration<Lifetime>>;
    }
}
export declare const AsImplementerRegistrationAugmentations: {
    asClass(this: IAsImplementer<any, any, Slot>, ctor: Ctor): RegistrationBuilder<any, any, Exclude<Slot, 'implementer'>, CtorRegistration<any>>;
    asFactory(this: IAsImplementer<any, any, Slot>, fn: Func): RegistrationBuilder<any, any, Exclude<Slot, 'implementer'>, FactoryRegistration<any>>;
};
