import { customAlphabet } from 'nanoid';

const createCompactValue = customAlphabet(
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  6,
);

export function createUuid(): string {
  return globalThis.crypto.randomUUID();
}

export function createCompactId(): string {
  return createCompactValue();
}
