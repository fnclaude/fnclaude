/**
 * The run root's {@link IDispatcher}: it folds the aggregated {@link IToolHandler}s
 * over the default stub handlers into one fixed op→handler map at construction and
 * exposes the per-connection callback {@link startMcpListener} drives — matching the
 * pre-DI `createParentDispatcher` map exactly (design.di-architecture §2 doctrine 3).
 */

import type { IDispatcher, IToolHandler } from '../launch/contracts';
import type { AcceptedSocket } from './listener';
import {
  createParentDispatcher,
  type ParentDispatchHandlers,
  stubParentHandlers,
} from './parent-dispatch';

export class Dispatcher implements IDispatcher {
  readonly #onConnection: (accepted: AcceptedSocket) => void;

  // The aggregate ctor param is a mutable `T[]`: the engine plans an array-typed ctor
  // param as that element's aggregate (di PlannerVisitor.visitArray), the door a
  // multi-registration is read back through.
  constructor(handlers: IToolHandler[]) {
    const map: ParentDispatchHandlers = { ...stubParentHandlers };
    for (const handler of handlers) {
      map[handler.op] = handler.handle;
    }
    this.#onConnection = createParentDispatcher({ handlers: map });
  }

  onConnection(accepted: AcceptedSocket): void {
    this.#onConnection(accepted);
  }
}
