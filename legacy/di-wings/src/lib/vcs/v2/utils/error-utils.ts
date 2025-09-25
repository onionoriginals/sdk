import { ProblemDetailsError } from "../errors";

export function wrapError(
  originalError: any, 
  errorType: string,
  title: string,
  defaultMessage?: string,
  status?: number
): Error {
  // If it's already a ProblemDetailsError, just return it
  if (originalError instanceof ProblemDetailsError) {
    return originalError;
  }

  // Create detailed error message that includes original error details
  const detailedMessage = [
    defaultMessage || 'An error occurred',
    `Original error: ${originalError.message}`,
    originalError.cause ? `Cause: ${originalError.cause}` : null,
    originalError.code ? `Code: ${originalError.code}` : null,
    originalError.details ? `Details: ${JSON.stringify(originalError.details)}` : null
  ].filter(Boolean).join('\n');

  // Create a new error that wraps the original
  const wrappedError = new ProblemDetailsError(
    errorType,
    title,
    detailedMessage,
    status || -16
  );

  // Add original error as cause
  wrappedError.cause = originalError;

  // Preserve the original stack trace
  if (originalError.stack) {
    const currentStack = wrappedError.stack?.split('\n') || [];
    const originalStack = originalError.stack.split('\n');
    
    // Combine stacks while removing duplicate lines
    wrappedError.stack = [
      currentStack[0], // Keep the wrapped error message line
      'Caused by:', 
      ...originalStack
    ].join('\n');
  }

  // Add additional debugging info if available
  if (typeof originalError === 'object') {
    Object.entries(originalError).forEach(([key, value]) => {
      if (!wrappedError.hasOwnProperty(key)) {
        (wrappedError as any)[`original_${key}`] = value;
      }
    });
  }

  return wrappedError;
} 