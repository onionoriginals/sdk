import { nanoid } from 'nanoid';
import type {
  WorkflowConfig,
  StepAction,
  CredentialTemplate,
  IssueRequest,
  ExchangeRequest,
  ExchangeResponse,
  ExchangeStateUpdate,
  VerifiablePresentationRequest,
  IWorkflow,
  IExchange
} from './types';
import {
  WorkflowNotFoundError,
  ExchangeNotFoundError,
  InvalidVPError,
  CredentialIssuanceError,
  ExchangeStateError,
  ExchangeExpiredError
} from './errors';
import { validateCredentialTemplate } from './templateValidator';
import jsonata from 'jsonata';
import type { IWorkflowRepository, IExchangeRepository } from './repositories';
import { Issuer } from '../vcs';
import { Multikey } from '../crypto';
import type { PrivateVerificationMethod, VerifiablePresentation } from '../common/interfaces';

export interface WorkflowServiceConfig {
  workflowRepository: IWorkflowRepository;
  exchangeRepository: IExchangeRepository;
  verificationMethods?: PrivateVerificationMethod[];
  defaultVerificationMethodId?: string;
}

/**
 * WorkflowService implements the VC-API Workflow Service specification
 * @see https://w3c-ccg.github.io/vc-api/#workflow-service
 */
export class WorkflowService {

  constructor(private config: WorkflowServiceConfig) {}

  /**
   * Gets all workflows (admin access)
   */
  async getAllWorkflows(): Promise<IWorkflow[]> {
    return await this.config.workflowRepository.find();
  }

  /**
   * Gets workflows for a specific user
   */
  async getUserWorkflows(userId: string): Promise<IWorkflow[]> {
    return await this.config.workflowRepository.find({ userId });
  }

  /**
   * Creates a new workflow instance
   * @see https://w3c-ccg.github.io/vc-api/#create-workflow
   */
  async createWorkflow(config: WorkflowConfig, userId: string): Promise<IWorkflow> {
    try {
      this.validateWorkflowConfig(config);
      
      const workflow = await this.config.workflowRepository.create({
        userId,
        config,
        exchanges: []
      });

      return workflow;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Invalid workflow configuration: ${error.message}`);
      }
      throw error;
    }
  }

  private validateWorkflowConfig(config: WorkflowConfig): void {
    if (!config.steps || typeof config.steps !== 'object') {
      throw new Error('Invalid workflow configuration: steps must be an object');
    }

    if (!config.initialStep || typeof config.initialStep !== 'string') {
      throw new Error('Invalid workflow configuration: initialStep must be a string');
    }

    if (!config.steps[config.initialStep]) {
      throw new Error('Invalid workflow configuration: initialStep must reference a valid step');
    }

    // Validate each step
    Object.entries(config.steps).forEach(([stepId, stepConfig]) => {
      if (!stepConfig.step) {
        throw new Error(`Invalid workflow configuration: step ${stepId} must have a step property`);
      }
    });
  }

  /**
   * Creates a new exchange for a workflow
   * @see https://w3c-ccg.github.io/vc-api/#create-exchange
   */
  async createExchange(
    workflowId: string, 
    ttl: string = '900000',
    variables: Record<string, any>[] = [],
  ): Promise<IExchange> {
    const workflow = await this.config.workflowRepository.findOne({ id: workflowId });
    if (!workflow) {
      throw new WorkflowNotFoundError(workflowId);
    }
    const exchange = await this.config.exchangeRepository.create({
      workflowId: workflow.id,
      ttl,
      variables,
      step: workflow.config.initialStep,
      state: 'pending'
    });

    workflow.exchanges.push(exchange.id);
    await this.config.workflowRepository.save(workflow);

    return exchange;
  }

  /**
   * Handles participation in an exchange
   * @see https://w3c-ccg.github.io/vc-api/#participate-in-an-exchange
   */
  async participateInExchange(
    workflowId: string,
    exchangeId: string,
    exchangeData?: ExchangeRequest
  ): Promise<{
    response: ExchangeResponse;
    stateUpdate: ExchangeStateUpdate;
  }> {
    const workflow = await this.getWorkflow(workflowId,);
    const exchange = await this.getExchange(workflowId, exchangeId);

    if (!workflow || exchange.workflowId !== workflow.id) {
      throw new Error('Exchange does not belong to workflow');
    }

    const currentStepConfig = workflow.config.steps[exchange.step]?.step;
    if (!currentStepConfig) {
      throw new Error('Invalid step configuration');
    }

    // Handle empty request - return current step configuration
    if (!exchangeData || Object.keys(exchangeData).length === 0) {
      return this.handleEmptyRequest(currentStepConfig, workflow, exchange);
    }

    // Handle VP submission
    if (exchangeData.verifiablePresentation) {
      const result = await this.handleVerifiablePresentation(
        exchangeData.verifiablePresentation,
        currentStepConfig,
        exchange,
        workflow
      );
      
      // Save the updated variables to the exchange
      exchange.variables = result.stateUpdate.variables ?? exchange.variables;
      await this.config.exchangeRepository.findOneAndUpdate(
        { id: exchange.id },
        { $set: { variables: exchange.variables } }
      );
      
      return result;
    }

    // Handle VPR submission
    if (exchangeData.verifiablePresentationRequest) {
      return this.handleVerifiablePresentationRequest(
        exchangeData.verifiablePresentationRequest,
        currentStepConfig,
        exchange
      );
    }

    return {
      response: {},
      stateUpdate: { 
        state: 'invalid',
        nextStep: currentStepConfig.nextStep,
        variables: exchange.variables
      }
    };
  }

  private async handleEmptyRequest(
    stepConfig: StepAction,
    workflow: IWorkflow,
    exchange: IExchange
  ): Promise<{ response: ExchangeResponse; stateUpdate: ExchangeStateUpdate }> {
    // Handle VPR first
    if (stepConfig.verifiablePresentationRequest) {
      const vpr = { ...stepConfig.verifiablePresentationRequest };
      
      // Handle challenge if needed
      if (stepConfig.createChallenge) {
        const isInitialStep = exchange.step === workflow.config.initialStep;
        const challenge = isInitialStep ? exchange.id : nanoid();
        vpr.query[0].challenge = challenge;
      }

      // Return VPR and update state
      const response = { verifiablePresentationRequest: vpr };
      
      // If exchange is pending, mark it as active
      if (exchange.state === 'pending') {
        exchange.state = 'active';
        await this.config.exchangeRepository.findOneAndUpdate(
          { id: exchange.id },
          { $set: { state: 'active' } }
        ).catch(error => 
          console.error('Could not mark exchange active:', { error })
        );
      }

      return {
        response,
        stateUpdate: { state: exchange.state }
      };
    }

    // Handle credential issuance for empty requests (no VP required)
    if (stepConfig.issueRequests?.length) {
        try {
            const transformedCredentials = await Promise.all(
                stepConfig.issueRequests.map(async (request) => {
                    const template = workflow.config.credentialTemplates?.find(
                        ct => ct.id === request.credentialTemplateId
                    );
                    
                    if (!template) {
                        throw new CredentialIssuanceError(
                            `Template not found: ${request.credentialTemplateId}`
                        );
                    }

                    // Evaluate template with exchange variables
                    const transformedCredential = await this.evaluateTemplate({
                        template,
                        workflow,
                        exchange
                    });

                    // Always use workflow controller as issuer
                    const issuerDid = workflow.config.controller;

                    // Issue the transformed credential with appropriate verification method
                    const signedCredential = await this.issueCredential(transformedCredential, {
                        issuerDid: issuerDid,
                        verificationMethodId: request.verificationMethodId,
                        proofPurpose: 'assertionMethod'
                    });
                    return signedCredential;
                })
            );

            // Select appropriate verification method for response VP
            const responseVM = this.getVerificationMethod({ 
                issuer: workflow.config.controller,
                purpose: 'authentication' 
            });

            // Create response VP
            const responseVP = {
                '@context': ['https://www.w3.org/ns/credentials/v2'],
                type: ['VerifiablePresentation'],
                holder: { id: responseVM.controller },
                verifiableCredential: transformedCredentials
            }
            const signedResponseVP = await this.issuePresentation(responseVP, {
                verificationMethod: responseVM,
                proofPurpose: 'authentication'
            });

            return {
                response: { verifiablePresentation: signedResponseVP },
                stateUpdate: {
                    state: stepConfig.nextStep ? 'pending' : 'complete',
                    variables: [{
                        results: {
                            issuedCredentials: transformedCredentials
                        }
                    }]
                }
            };
        } catch (error) {
            console.error('Credential issuance failed:', { error });
            throw error;
        }
    }

    throw new Error('Step must include either VPR or issue requests');
  }

  private async evaluateTemplate({
    template,
    workflow,
    exchange
  }: {
    template: CredentialTemplate;
    workflow: IWorkflow;
    exchange: IExchange;
  }) {
    if (template.type !== 'jsonata') {
      throw new Error('Unsupported template type');
    }

    try {
      // Get template variables
      const variables = this.getTemplateVariables({ workflow, exchange });
      
      // Create and evaluate the expression
      const expression = jsonata(template.template);
      
      const result = await expression.evaluate(variables, variables);
      
      if (!result?.credentialSubject) {
        throw new CredentialIssuanceError('Template evaluation failed to produce credentialSubject');
      }

      return result;
    } catch (error) {
      console.error('Template evaluation failed:', { 
        error,
        template: template.template,
        variables: exchange.variables
      });
      throw error;
    }
  }

  private getTemplateVariables({
    workflow,
    exchange
  }: {
    workflow: IWorkflow;
    exchange: IExchange;
  }) {
    // Get the variables from exchange
    const variables = exchange.variables[0] || {};

    // Add globals for self-referencing
    variables.globals = {
      workflow: {
        id: workflow.id
      },
      exchange: {
        id: exchange.id
      }
    };

    return variables;
  }

  private updateExchangeVariables(exchange: IExchange, vp: VerifiablePresentation): Record<string, any>[] {
    // Create a deep copy of the existing variables
    const variables = JSON.parse(JSON.stringify(exchange.variables || []));
    
    // Find or create the verifiedPresentations object
    let verifiedPresentationsObj = variables.find((v: Record<string, any>) => v.hasOwnProperty('verifiedPresentations'));
    if (!verifiedPresentationsObj) {
        verifiedPresentationsObj = { verifiedPresentations: [] };
        variables.push(verifiedPresentationsObj);
    }
    
    // Add the new VP
    verifiedPresentationsObj.verifiedPresentations.push(vp);
    
    return variables;
  }

  private async handleVerifiablePresentation(
    vp: VerifiablePresentation,
    stepConfig: StepAction,
    exchange: IExchange,
    workflow: IWorkflow
  ): Promise<{ response: ExchangeResponse; stateUpdate: ExchangeStateUpdate }> {
    await this.validateVerifiablePresentation(vp);

    // Update exchange variables with the VP
    const variables = this.updateExchangeVariables(exchange, vp);

    // Save the variables immediately
    exchange.variables = variables;
    await this.config.exchangeRepository.findOneAndUpdate(
      { id: exchange.id },
      { $set: { variables: exchange.variables } }
    );

    // Handle credential issuance if needed
    if (stepConfig.issueRequests?.length) {
        const result = await this.handleCredentialIssuance(
            stepConfig.issueRequests,
            workflow,
            exchange,
            vp,
            variables
        );
        return result;
    }

    // Handle next step transition
    return {
        response: {},
        stateUpdate: {
            state: stepConfig.nextStep ? 'pending' : 'complete',
            nextStep: stepConfig.nextStep,
            variables
        }
    };
  }

  public async getWorkflow(workflowId: string): Promise<IWorkflow> {
    const workflow = await this.config.workflowRepository.findOne({ id: workflowId });
    if (!workflow) {
      throw new WorkflowNotFoundError(`Workflow ${workflowId} not found`);
    }
    return workflow;
  }

  public async getExchange(workflowId: string, exchangeId: string): Promise<IExchange> {
    const exchange = await this.config.exchangeRepository.findOne({ id: exchangeId });
    if (!exchange) {
      throw new ExchangeNotFoundError(exchangeId);
    }
    if (exchange.workflowId !== workflowId) {
      throw new ExchangeStateError('Exchange does not belong to workflow');
    }

    // Check exchange expiration
    const ttlMs = parseInt(exchange.ttl);
    const expirationTime = new Date(exchange.createdAt.getTime() + ttlMs);
    if (expirationTime < new Date()) {
      throw new ExchangeExpiredError(exchangeId);
    }

    return exchange;
  }

  public async validateVerifiablePresentation(vp: VerifiablePresentation): Promise<void> {
    if (!vp['@context'] || !vp.type) {
      throw new InvalidVPError('Missing required VP fields');
    }
    
    if (!vp.proof) {
      throw new InvalidVPError('Missing proof');
    }

    const proofs = Array.isArray(vp.proof) ? vp.proof : [vp.proof];
    const requiredProofFields = ['type', 'created', 'verificationMethod', 'proofPurpose', 'proofValue', 'cryptosuite'] as const;
    
    for (const proof of proofs) {
      if (typeof proof !== 'object') {
        throw new InvalidVPError('Invalid proof - must be an object');
      }

      const missingFields = requiredProofFields.filter(field => !proof[field]);
      
      if (missingFields.length > 0) {
        throw new InvalidVPError('Missing required proof fields', {
          required: requiredProofFields,
          missing: missingFields,
          received: Object.keys(proof)
        });
      }
    }
  }

  private validStateTransitions: Record<string, string[]> = {
    pending: ['pending', 'active', 'complete', 'invalid'],
    active: ['pending', 'active', 'complete', 'invalid'],
    complete: [],
    invalid: []
  };

  private validateStateTransition(currentState: string, nextState: string): boolean {
    return this.validStateTransitions[currentState]?.includes(nextState) || false;
  }

  async updateExchangeState(workflowId: string, exchangeId: string, update: ExchangeStateUpdate): Promise<void> {
    const exchange = await this.getExchange(workflowId, exchangeId);
    
    if (!this.validateStateTransition(exchange.state, update.state)) {
      throw new ExchangeStateError(`Invalid state transition from ${exchange.state} to ${update.state}`);
    }

    // Only include fields that are actually provided in the update
    const updateData: Partial<IExchange> = {
      state: update.state
    };

    if (update.nextStep !== undefined && update.nextStep !== null) {
      updateData.step = update.nextStep;
    }

    if (update.variables !== undefined) {
      updateData.variables = update.variables;
    }

    await this.config.exchangeRepository.findOneAndUpdate(
      { id: exchangeId, workflowId: workflowId },
      { $set: updateData },
      { new: true, runValidators: true }
    );
  }

  private async handleCredentialIssuance(
    issueRequests: IssueRequest[],
    workflow: IWorkflow,
    exchange: IExchange,
    vp: VerifiablePresentation,
    variables: Record<string, any>[]
  ): Promise<{ response: ExchangeResponse; stateUpdate: ExchangeStateUpdate }> {
    try {
        // Validate template references
        for (const request of issueRequests) {
            const template = workflow.config.credentialTemplates?.find(
                ct => ct.id === request.credentialTemplateId
            );
            if (!template) {
                throw new CredentialIssuanceError(
                    `Template not found: ${request.credentialTemplateId}`,
                    { availableTemplates: workflow.config.credentialTemplates?.map(t => t.id) }
                );
            }
            await validateCredentialTemplate(template);
        }

        // Transform and issue credentials with appropriate verification methods
        const transformedCredentials = await Promise.all(
            issueRequests.map(async (request) => {
                try {
                    const template = workflow.config.credentialTemplates!.find(
                        ct => ct.id === request.credentialTemplateId
                    )!;
                    const baseCredential = JSON.parse(template.template);
                    
                    let finalCredential = baseCredential;
                    
                    if (template.type === 'jsonata' && request.variables) {
                        const expression = jsonata(request.variables as string);
                        const transformedSubject = await expression.evaluate({
                            presentation: vp,
                            exchange: {
                                id: exchange.id,
                                variables: variables
                            }
                        });
                        finalCredential = {
                            ...baseCredential,
                            id: `urn:uuid:${nanoid()}`,
                            issuanceDate: new Date().toISOString(),
                            credentialSubject: {
                                id: vp.holder?.id,
                                ...transformedSubject
                            }
                        };
                    }

                    // Determine issuer from credential or workflow configuration
                    const issuerDid = workflow.config.controller || 
                                    finalCredential.issuer || 
                                    (typeof finalCredential.issuer === 'object' ? finalCredential.issuer?.id : null);

                    // Issue the credential with appropriate verification method
                    const signedCredential = await this.issueCredential(finalCredential, {
                        issuerDid: issuerDid,
                        verificationMethodId: request.verificationMethodId, // Allow per-request VM selection
                        proofPurpose: 'assertionMethod'
                    });

                    return signedCredential;
                } catch (error) {
                    console.error('Credential transformation/issuance failed', { error, request });
                    throw new CredentialIssuanceError(
                        'Failed to transform and issue credential',
                        { originalError: error }
                    );
                }
            })
        );

        // Create response VP with appropriate verification method
        const holderDid = vp.holder?.id || 'did:example:issuer';
        const responseVM = this.getVerificationMethod({ 
            issuer: holderDid,
            purpose: 'authentication' 
        });

        const responseVP = {
            '@context': ['https://www.w3.org/ns/credentials/v2'],
            type: ['VerifiablePresentation'],
            holder: { id: responseVM.controller },
            verifiableCredential: transformedCredentials,
        };
        const signedResponseVP = await this.issuePresentation(responseVP, {
            verificationMethod: responseVM,
            proofPurpose: 'authentication'
        });

        return {
            response: { verifiablePresentation: signedResponseVP },
            stateUpdate: {
                state: 'complete',
                variables: [
                    ...variables,
                    { issuedCredentials: transformedCredentials }
                ]
            }
        };
    } catch (error) {
        console.error('Credential issuance failed', { error });
        throw error;
    }
  }

  private async handleVerifiablePresentationRequest(
    vpr: VerifiablePresentationRequest,
    stepConfig: StepAction,
    exchange: IExchange
  ): Promise<{ response: ExchangeResponse; stateUpdate: ExchangeStateUpdate }> {
    // Validate the VPR format
    if (!vpr.query || !Array.isArray(vpr.query)) {
      throw new Error('Invalid VPR: query array is required');
    }

    // If we have a VP to return in response to the VPR
    if (stepConfig.verifiablePresentation) {
      const vp = {
        '@context': [
          'https://www.w3.org/ns/credentials/v2'
        ],
        type: ['VerifiablePresentation'],
        holder: {
          id: 'did:example:issuer123'
        },
        verifiableCredential: stepConfig.verifiablePresentation.verifiableCredential
      }
      const signedResponseVP = await this.issuePresentation(vp, {
        verificationMethod: stepConfig.verifiablePresentation.verificationMethod as PrivateVerificationMethod,
        proofPurpose: 'authentication'
      });
      return {
        response: {
          verifiablePresentation: signedResponseVP
        },
        stateUpdate: {
          state: stepConfig.nextStep ? 'pending' : 'complete',
          nextStep: stepConfig.nextStep,
          variables: exchange.variables
        }
      };
    }

    // If we have a VPR to return
    if (stepConfig.verifiablePresentationRequest) {
      return {
        response: {
          verifiablePresentationRequest: stepConfig.verifiablePresentationRequest
        },
        stateUpdate: {
          state: 'pending',
          variables: exchange.variables
        }
      };
    }

    throw new Error('Cannot fulfill VPR in current step');
  }

  /**
   * Deletes a workflow by ID
   */
  async deleteWorkflow(workflowId: string): Promise<IWorkflow | null> {
    const workflow = await this.config.workflowRepository.findOneAndDelete({ id: workflowId });
    if (!workflow) {
      throw new WorkflowNotFoundError(workflowId);
    }
    return workflow;
  }

  private async evaluateJSONata(
    template: any,
    context: any
  ): Promise<any> {
    if (typeof template === 'string') {
      try {
        // Create JSONata expression
        const expression = jsonata(template);
        const result = await expression.evaluate(context);
        // If result is undefined, return the original string
        return result === undefined ? template : result;
      } catch (e) {
        console.info('JSONata evaluation failed:', { error: e, template });
        return template; // Return as-is if not a valid JSONata expression
      }
    }

    if (typeof template === 'object') {
      const result: any = Array.isArray(template) ? [] : {};
      for (const [key, value] of Object.entries(template)) {
        result[key] = await this.evaluateJSONata(value, context);
      }
      return result;
    }

    return template;
  }

  /**
   * Get verification method for signing credentials
   * @param criteria Selection criteria for choosing the verification method
   * @returns PrivateVerificationMethod
   */
  private getVerificationMethod(criteria?: {
    id?: string;
    controller?: string;
    issuer?: string;
    preferredType?: string;
    purpose?: 'authentication' | 'assertionMethod' | 'keyAgreement' | 'capabilityInvocation';
  }): PrivateVerificationMethod {
    if (!this.config.verificationMethods || this.config.verificationMethods.length === 0) {
      throw new Error('No verification methods configured');
    }

    // If specific ID is requested, find it
    if (criteria?.id) {
      const vm = this.config.verificationMethods.find(vm => vm.id === criteria.id);
      if (!vm) {
        throw new Error(`Verification method not found: ${criteria.id}`);
      }
      return vm;
    }

    // If controller/issuer DID is specified, find matching verification method
    if (criteria?.controller || criteria?.issuer) {
      const targetController = criteria.controller || criteria.issuer;
      const vm = this.config.verificationMethods.find(vm => vm.controller === targetController);
      if (vm) {
        return vm;
      }
    }

    // If preferred type is specified, find matching verification method
    if (criteria?.preferredType) {
      const vm = this.config.verificationMethods.find(vm => vm.type === criteria.preferredType);
      if (vm) {
        return vm;
      }
    }

    // Use configured default verification method
    if (this.config.defaultVerificationMethodId) {
      const vm = this.config.verificationMethods.find(vm => vm.id === this.config.defaultVerificationMethodId);
      if (vm) {
        return vm;
      }
    }

    // Fall back to first available verification method
    return this.config.verificationMethods[0];
  }

  /**
   * Get all available verification methods
   * @returns Array of verification method summaries
   */
  getAvailableVerificationMethods(): Array<{
    id: string;
    controller: string;
    type: string;
    purpose?: string[];
  }> {
    if (!this.config.verificationMethods) {
      return [];
    }

    return this.config.verificationMethods.map(vm => ({
      id: vm.id,
      controller: vm.controller,
      type: vm.type || 'Multikey',
      purpose: ['assertionMethod', 'authentication'] // Default purposes
    }));
  }

  /**
   * Issue a credential with specified or automatically selected verification method
   * @param credential The credential to sign
   * @param options Issuance options including verification method selection
   * @returns Promise<VerifiableCredential>
   */
  async issueCredential(
    credential: any, 
    options?: {
      verificationMethodId?: string;
      issuerDid?: string;
      proofPurpose?: string;
    }
  ) {
    try {
      // Determine issuer DID from credential or options
      const issuerDid = options?.issuerDid || 
                       (typeof credential.issuer === 'string' ? credential.issuer : credential.issuer?.id);

      // Select appropriate verification method
      const vm = this.getVerificationMethod({
        id: options?.verificationMethodId,
        issuer: issuerDid,
        purpose: (options?.proofPurpose as any) || 'assertionMethod'
      });

      if (!vm.publicKeyMultibase) {
        throw new Error('Verification method has no public key');
      }
      if (!vm.secretKeyMultibase) {
        throw new Error('Verification method has no secret key');
      }

      // Set the issuer if not already set
      if (!credential.issuer) {
        credential.issuer = vm.controller;
      }

      const key = Multikey.fromMultibase({
        id: vm.id,
        controller: vm.controller,
        publicKeyMultibase: vm.publicKeyMultibase,
        secretKeyMultibase: vm.secretKeyMultibase
      });
      
      // Issue the credential using di-wings Issuer
      const verifiableCredential = await Issuer.issue(credential, {
        verificationMethod: key,
        proofPurpose: options?.proofPurpose || 'assertionMethod'
      });

      if (!verifiableCredential) {
        throw new Error('Failed to issue credential');
      }

      return verifiableCredential;
    } catch (error) {
      throw new Error('Failed to issue credential: ' + (error as Error).message);
    }
  }

  /**
   * Issue (sign) a verifiable presentation with a selected verification method
   * @param presentation The presentation to sign
   * @param options Issuance options including verification method selection and proof params
   * @returns Promise<VerifiablePresentation>
   */
  async issuePresentation(
    presentation: any,
    options?: {
      verificationMethodId?: string;
      verificationMethod?: PrivateVerificationMethod;
      holderDid?: string;
      proofPurpose?: 'authentication' | 'assertionMethod' | 'keyAgreement' | 'capabilityInvocation';
      challenge?: string;
      domain?: string;
    }
  ): Promise<VerifiablePresentation> {
    try {
      // Select appropriate verification method
      const vm: PrivateVerificationMethod = options?.verificationMethod || this.getVerificationMethod({
        id: options?.verificationMethodId,
        controller: options?.holderDid,
        purpose: options?.proofPurpose || 'authentication'
      });

      if (!vm.publicKeyMultibase) {
        throw new Error('Verification method has no public key');
      }
      if (!vm.secretKeyMultibase) {
        throw new Error('Verification method has no secret key');
      }

      const key = Multikey.fromMultibase({
        id: vm.id,
        controller: vm.controller,
        publicKeyMultibase: vm.publicKeyMultibase,
        secretKeyMultibase: vm.secretKeyMultibase
      });

      const issued = await Issuer.present(presentation, {
        verificationMethod: key,
        proofPurpose: options?.proofPurpose || 'authentication',
        challenge: options?.challenge,
        domain: options?.domain
      });

      return issued as VerifiablePresentation;
    } catch (error) {
      throw new Error('Failed to issue presentation: ' + (error as Error).message);
    }
  }

  async getWorkflowExchanges(workflowId: string): Promise<IExchange[]> {
    const exchanges = await this.config.exchangeRepository.find({ workflowId });
    return exchanges;
  }
} 