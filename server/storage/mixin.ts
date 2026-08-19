// TS mixin composition helpers for splitting the DatabaseStorage god-class
// into per-domain files. Each domain lives in its own mixin function
// (server/storage/<domain>.ts) that extends a Base constructor and adds one
// cohesive slice of IStorage. server/storage.ts composes them all back into
// a single DatabaseStorage class so external callers keep using one object.
//
// Why a fluent `.with()` builder instead of a single variadic `compose(...)`
// call: chaining one generic type parameter per `.with()` call lets the
// TypeScript compiler carry the exact accumulated type through the whole
// chain, so the final `implements IStorage` on DatabaseStorage still
// verifies every mixin-provided method against its real interface — a
// variadic `compose(Base, ...mixins)` would need combinatorial overloads (or
// an `any` escape hatch) to keep that same guarantee.
export type Constructor<T = object> = new (...args: any[]) => T;

class MixinBuilder<TBase extends Constructor> {
  constructor(private readonly base: TBase) {}

  with<TMixed extends TBase>(mixin: (Base: TBase) => TMixed): MixinBuilder<TMixed> {
    return new MixinBuilder(mixin(this.base));
  }

  build(): TBase {
    return this.base;
  }
}

export function compose<TBase extends Constructor>(base: TBase): MixinBuilder<TBase> {
  return new MixinBuilder(base);
}
