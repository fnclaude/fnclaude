import type { IServiceProvider } from '@rhombus-std/di.core';
import { registerInlineBodies, typefor } from '@rhombus-std/primitives.extras';
import type { Ctor, Func } from '@rhombus-toolkit/types';

declare module '@rhombus-std/di.core' {
  interface IServiceProvider {
    /**
     * The value registered for `ServiceType`, the service type derived from the type argument
     * instead of taken explicitly.
     *
     * @throws UnsatisfiableError - when nothing can produce `ServiceType`.
     */
    resolve<ServiceType>(): ServiceType;
    /** The value registered for `ServiceType`, the service type derived from the type argument instead of taken explicitly, or `undefined` once nothing can produce it. */
    tryResolve<ServiceType>(): ServiceType | undefined;
    /** Every registration of `ServiceType`, the service type derived from the type argument instead of taken explicitly, as one array. */
    resolveArray<ServiceType>(): ServiceType[];
    /** Every registration of `ServiceType` as one array, or `undefined` once nothing can produce that. */
    tryResolveArray<ServiceType>(): ServiceType[] | undefined;
    /**
     * Every registration of `ServiceType`, the service type derived from the type argument
     * instead of taken explicitly, as one sequence.
     */
    resolveIterable<ServiceType>(): Iterable<ServiceType>;
    /** Every registration of `ServiceType` as one sequence, or `undefined` once nothing can produce that. */
    tryResolveIterable<ServiceType>(): Iterable<ServiceType> | undefined;
    /**
     * The value registered for `ServiceType`, the service type derived from the type argument
     * instead of taken explicitly, delivered asynchronously — every dependency beneath it that
     * arrives as a promise is awaited before the value is handed over.
     *
     * @throws UnsatisfiableError - when nothing can produce `ServiceType`.
     */
    resolveAsync<ServiceType>(): Promise<ServiceType>;
    /** The value registered for `ServiceType`, delivered asynchronously, settling on `undefined` once nothing can produce it. */
    tryResolveAsync<ServiceType>(): Promise<ServiceType | undefined>;
    /** Every registration of `ServiceType` as one array, delivered asynchronously. */
    resolveArrayAsync<ServiceType>(): Promise<ServiceType[]>;
    /** Every registration of `ServiceType` as one array, delivered asynchronously, settling on `undefined` once nothing can produce that. */
    tryResolveArrayAsync<ServiceType>(): Promise<ServiceType[] | undefined>;
    /** Every registration of `ServiceType` as one sequence, delivered asynchronously. */
    resolveIterableAsync<ServiceType>(): Promise<Iterable<ServiceType>>;
    /** Every registration of `ServiceType` as one sequence, delivered asynchronously, settling on `undefined` once nothing can produce that. */
    tryResolveIterableAsync<ServiceType>(): Promise<Iterable<ServiceType> | undefined>;
    /**
     * Every registration of `ServiceType`, the service type derived from the type argument
     * instead of taken explicitly, each element awaited as the walk reaches it.
     */
    resolveAsyncIterable<ServiceType>(): AsyncIterable<ServiceType>;
    /** Every registration of `ServiceType` as one awaited walk, or `undefined` once nothing can produce that. */
    tryResolveAsyncIterable<ServiceType>(): AsyncIterable<ServiceType> | undefined;
    /**
     * Calls the callable registered for `Func<Args, ServiceType>` with `args`, the callable's
     * type derived from the type arguments instead of taken explicitly.
     *
     * @throws UnsatisfiableError - when nothing can produce that callable.
     */
    resolveWith<ServiceType, Args extends unknown[]>(...args: Args): ServiceType;
    /** Calls the callable registered for `Func<Args, ServiceType>` with `args`, or answers `undefined` once nothing can produce it. */
    tryResolveWith<ServiceType, Args extends unknown[]>(...args: Args): ServiceType | undefined;
    /**
     * Calls the callable registered for `Func<Args, Promise<ServiceType>>` with `args`, the
     * callable's type derived from the type arguments instead of taken explicitly.
     *
     * @throws UnsatisfiableError - when nothing can produce that callable.
     */
    resolveWithAsync<ServiceType, Args extends unknown[]>(...args: Args): Promise<ServiceType>;
    /** Calls the callable registered for `Func<Args, Promise<ServiceType>>` with `args`, settling on `undefined` once nothing can produce it. */
    tryResolveWithAsync<ServiceType, Args extends unknown[]>(...args: Args): Promise<ServiceType | undefined>;
    /** Constructs `ctor` fresh with the constructor type observed from `ctor` instead of taken explicitly. */
    instantiate<Instance>(ctor: Ctor<any[], Instance>): Instance;
    /** {@link IServiceProvider.instantiate}'s observed shape, answering `undefined` once a dependency of `ctor` cannot be produced. */
    tryInstantiate<Instance>(ctor: Ctor<any[], Instance>): Instance | undefined;
    /** Calls `func` with the function type observed from `func` instead of taken explicitly. */
    invoke<Result>(func: Func<any[], Result>): Result;
    /** {@link IServiceProvider.invoke}'s observed shape, answering `undefined` once a dependency of `func` cannot be produced. */
    tryInvoke<Result>(func: Func<any[], Result>): Result | undefined;
  }
}

export const ServiceProviderServiceAugmentations = {
  resolve<ServiceType>(this: IServiceProvider): ServiceType {
    return this.resolve(typefor<ServiceType>());
  },
  tryResolve<ServiceType>(this: IServiceProvider): ServiceType | undefined {
    return this.tryResolve(typefor<ServiceType>());
  },
  resolveArray<ServiceType>(this: IServiceProvider): ServiceType[] {
    return this.resolveArray(typefor<ServiceType>());
  },
  tryResolveArray<ServiceType>(this: IServiceProvider): ServiceType[] | undefined {
    return this.tryResolveArray(typefor<ServiceType>());
  },
  resolveIterable<ServiceType>(this: IServiceProvider): Iterable<ServiceType> {
    return this.resolveIterable(typefor<ServiceType>());
  },
  tryResolveIterable<ServiceType>(this: IServiceProvider): Iterable<ServiceType> | undefined {
    return this.tryResolveIterable(typefor<ServiceType>());
  },
  resolveAsync<ServiceType>(this: IServiceProvider): Promise<ServiceType> {
    return this.resolveAsync(typefor<ServiceType>());
  },
  tryResolveAsync<ServiceType>(this: IServiceProvider): Promise<ServiceType | undefined> {
    return this.tryResolveAsync(typefor<ServiceType>());
  },
  resolveArrayAsync<ServiceType>(this: IServiceProvider): Promise<ServiceType[]> {
    return this.resolveArrayAsync(typefor<ServiceType>());
  },
  tryResolveArrayAsync<ServiceType>(this: IServiceProvider): Promise<ServiceType[] | undefined> {
    return this.tryResolveArrayAsync(typefor<ServiceType>());
  },
  resolveIterableAsync<ServiceType>(this: IServiceProvider): Promise<Iterable<ServiceType>> {
    return this.resolveIterableAsync(typefor<ServiceType>());
  },
  tryResolveIterableAsync<ServiceType>(this: IServiceProvider): Promise<Iterable<ServiceType> | undefined> {
    return this.tryResolveIterableAsync(typefor<ServiceType>());
  },
  resolveAsyncIterable<ServiceType>(this: IServiceProvider): AsyncIterable<ServiceType> {
    return this.resolveAsyncIterable(typefor<ServiceType>());
  },
  tryResolveAsyncIterable<ServiceType>(this: IServiceProvider): AsyncIterable<ServiceType> | undefined {
    return this.tryResolveAsyncIterable(typefor<ServiceType>());
  },
  resolveWith<ServiceType, Args extends unknown[]>(this: IServiceProvider, ...args: Args): ServiceType {
    return this.resolveWith(typefor<Func<Args, ServiceType>>(), ...args);
  },
  tryResolveWith<ServiceType, Args extends unknown[]>(this: IServiceProvider, ...args: Args): ServiceType | undefined {
    return this.tryResolveWith(typefor<Func<Args, ServiceType>>(), ...args);
  },
  resolveWithAsync<ServiceType, Args extends unknown[]>(this: IServiceProvider, ...args: Args): Promise<ServiceType> {
    return this.resolveWithAsync(typefor<Func<Args, Promise<ServiceType>>>(), ...args);
  },
  tryResolveWithAsync<ServiceType, Args extends unknown[]>(this: IServiceProvider, ...args: Args): Promise<ServiceType | undefined> {
    return this.tryResolveWithAsync(typefor<Func<Args, Promise<ServiceType>>>(), ...args);
  },
  instantiate<Instance>(this: IServiceProvider, ctor: Ctor<any[], Instance>): Instance {
    return this.instantiate(typefor(ctor), ctor);
  },
  tryInstantiate<Instance>(this: IServiceProvider, ctor: Ctor<any[], Instance>): Instance | undefined {
    return this.tryInstantiate(typefor(ctor), ctor);
  },
  invoke<Result>(this: IServiceProvider, func: Func<any[], Result>): Result {
    return this.invoke(typefor(func), func);
  },
  tryInvoke<Result>(this: IServiceProvider, func: Func<any[], Result>): Result | undefined {
    return this.tryInvoke(typefor(func), func);
  },
};
registerInlineBodies<IServiceProvider>(ServiceProviderServiceAugmentations);
