import { z } from 'zod';

import { ACCOUNT_OPERATIONS } from '../../shared/electron-contracts/account.js';
import type { ControllerContext, OperationDefinition } from '../capabilities/catalog.js';
import { args, identifier } from '../capabilities/validation.js';
import type { AccountApplication } from './account-application.js';

export function createAccountController(
  application: AccountApplication,
): { operations: readonly OperationDefinition[] } {
  const flowId = identifier;
  const operations: OperationDefinition[] = [
    operation(ACCOUNT_OPERATIONS.status, args([]), (context) => application.status(context.signal)),
    operation(
      ACCOUNT_OPERATIONS.beginSignIn,
      args([]),
      (context) => application.beginSignIn(context.signal),
    ),
    operation(
      ACCOUNT_OPERATIONS.waitForSignIn,
      args([flowId]),
      (context, input) => application.waitForSignIn(input[0] as string, context.signal),
    ),
    operation(
      ACCOUNT_OPERATIONS.reopenSignIn,
      args([flowId]),
      (_context, input) => application.reopenSignIn(input[0] as string),
    ),
    operation(
      ACCOUNT_OPERATIONS.cancelSignIn,
      args([flowId]),
      (_context, input) => application.cancelSignIn(input[0] as string),
    ),
    operation(
      ACCOUNT_OPERATIONS.signOut,
      args([]),
      (context) => application.signOut(context.signal),
    ),
  ];
  return Object.freeze({ operations: Object.freeze(operations) });
}

function operation(
  id: string,
  input: z.ZodType<unknown[]>,
  execute: (context: ControllerContext, input: unknown[]) => unknown,
): OperationDefinition<unknown[]> {
  return { id, capability: 'account', input, execute };
}
