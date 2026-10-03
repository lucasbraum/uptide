import type { ZodError, ZodIssue } from 'zod';

export interface FieldError {
  field: string;
  message: string;
}

const toFieldError = (issue: ZodIssue): FieldError => ({
  field: issue.path.join('.'),
  message: issue.message,
});

export function fieldErrors(error: ZodError): FieldError[] {
  return error.issues.map(toFieldError);
}

/** Retries left for a failed delivery; the queue stores the count as text. */
export function retriesLeft(stored: string): number {
  const left: number = stored;
  return left;
}

/** Errors that belong to the whole form, not to one field. */
export function formErrors(error: ZodError): string[] {
  return error.flatten().formErrors;
}
