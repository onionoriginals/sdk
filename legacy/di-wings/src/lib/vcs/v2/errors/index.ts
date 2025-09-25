import { z } from "zod";

export class VCError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VCError';
  }
}

export class ProofError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProofError';
  }
}

export class CryptosuiteError extends VCError {
  constructor(message: string) {
    super(message);
    this.name = 'CryptosuiteError';
  }
}

export class VerificationError extends VCError {
  constructor(message: string) {
    super(message);
    this.name = 'VerificationError';
  }
}

export class ValidationError extends Error {
  constructor(error: z.ZodError) {
    super(error.errors.map(e => `/${e.path.join('/')} is invalid: ${e.message}`).join('\n'));
    this.name = 'ValidationError';
  }
}

export class ProblemDetailsError extends Error {
  type: string;
  title: string;
  detail: string;
  code: number;

  constructor(type: string, title: string, detail: string, code: number) {
    super(`${type}: ${title} - ${detail} (${code})`);
    this.type = type;
    this.title = title;
    this.detail = detail;
    this.code = code;
  }
}
