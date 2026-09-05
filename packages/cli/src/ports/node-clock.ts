import type { IClock } from './contracts';

/** The real {@link IClock} over `Date.now()`. */
export class SystemClock implements IClock {
  now(): number {
    return Date.now();
  }
}
