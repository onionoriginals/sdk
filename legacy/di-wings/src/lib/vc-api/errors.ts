export class WorkflowError extends Error {
  constructor(message: string, public details?: string) {
    super(message);
    this.name = 'WorkflowError';
  }
}

export class WorkflowNotFoundError extends WorkflowError {
  constructor(workflowId: string) {
    super(`Workflow ${workflowId} not found`);
    this.name = 'WorkflowNotFoundError';
  }
}

export class ExchangeNotFoundError extends WorkflowError {
  constructor(exchangeId: string) {
    super(`Exchange ${exchangeId} not found`);
    this.name = 'ExchangeNotFoundError';
  }
}

export class InvalidWorkflowConfigError extends WorkflowError {
  constructor(message: string) {
    super(`Invalid workflow configuration: ${message}`);
    this.name = 'InvalidWorkflowConfigError';
  }
}

export class InvalidVPError extends WorkflowError {
  constructor(message: string, public context?: any) {
    super(message);
    this.name = 'InvalidVPError';
  }
}

export class CredentialIssuanceError extends WorkflowError {
  constructor(message: string, public context?: any) {
    super(`Credential issuance failed: ${message}`);
    this.name = 'CredentialIssuanceError';
  }
}

export class ExchangeStateError extends WorkflowError {
  constructor(message: string) {
    super(`Exchange state error: ${message}`);
    this.name = 'ExchangeStateError';
  }
}

export class ExchangeExpiredError extends WorkflowError {
  constructor(exchangeId: string) {
    super(`Exchange ${exchangeId} has expired`);
    this.name = 'ExchangeExpiredError';
  }
} 