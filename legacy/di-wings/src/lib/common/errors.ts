export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, NotImplementedError.prototype);
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}