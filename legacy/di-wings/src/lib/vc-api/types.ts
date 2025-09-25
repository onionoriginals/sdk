import type { VerifiablePresentation } from "../common/interfaces";

export interface WorkflowConfig {
  steps: Record<string, {
    step: StepAction;
  }>;
  initialStep: string;
  controller?: string;
  authorization?: any;
  credentialTemplates?: CredentialTemplate[];
}

export interface StepAction {
  verifiablePresentationRequest?: VerifiablePresentationRequest;
  verifiablePresentation?: VerifiablePresentation;
  createChallenge?: boolean;
  issueRequests?: IssueRequest[];
  nextStep?: string | null;
}

export interface CredentialTemplate {
  id: string;
  type: 'jsonata' | string;
  template: string;
}

export interface IssueRequest {
  credentialTemplateId: string;
  variables?: string | Record<string, any>;
  verificationMethodId?: string;
}

export interface ExchangeRequest {
  verifiablePresentation?: VerifiablePresentation;
  verifiablePresentationRequest?: VerifiablePresentationRequest;
}

export interface ExchangeResponse {
  verifiablePresentation?: VerifiablePresentation;
  verifiablePresentationRequest?: VerifiablePresentationRequest;
}

export interface ExchangeStateUpdate {
  state: 'pending' | 'active' | 'complete' | 'invalid';
  nextStep?: string | null;
  variables?: Record<string, any>[];
}


export interface VerifiablePresentationRequest {
  query: {
    type: string;
    challenge?: string;
    domain?: string;
    credentialQuery?: any[];
  }[];
  interact?: any[];
}

export interface IWorkflow {
  id: string;
  userId: string;
  config: WorkflowConfig;
  exchanges: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface IExchange {
  id: string;
  workflowId: string;
  ttl: string;
  variables: Record<string, any>[];
  step: string;
  state: 'pending' | 'active' | 'complete' | 'invalid';
  createdAt: Date;
  updatedAt: Date;
  sequence?: number;
} 