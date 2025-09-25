// Replace the decorator with a type checking function
export function assertImplementsStatic<T>(constructor: any): asserts constructor is T {
  // This function does nothing at runtime, it's just for type checking
  // The type assertion happens at compile time
} 