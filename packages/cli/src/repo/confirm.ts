/**
 * Thin interactive yes/no confirm over stdin.
 *
 * The pure decision (`parseYesNo`) is split out so it can be unit-tested
 * without any TTY: y/yes (any case) → true, n/no → false, empty → the
 * supplied default. The readline wiring stays minimal; when stdin is not a
 * TTY (CI, pipes) we never block on input and just return the default — so
 * a non-interactive run behaves as if the user accepted nothing.
 */

import { createInterface } from 'node:readline';

export function parseYesNo(answer: string, def: boolean): boolean {
  const a = answer.trim().toLowerCase();
  if (a === '') return def;
  if (a === 'y' || a === 'yes') return true;
  if (a === 'n' || a === 'no') return false;
  return def;
}

export type Confirm = (question: string, def: boolean) => Promise<boolean>;

export const confirm: Confirm = (question, def) => {
  if (!process.stdin.isTTY) return Promise.resolve(def);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise<boolean>((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(parseYesNo(answer, def));
    });
  });
};
