import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { WorkflowService } from '../WorkflowService';
import type { IWorkflowRepository, IExchangeRepository } from '../repositories';
import type { WorkflowConfig, IWorkflow, IExchange } from '../types';
import {
  WorkflowNotFoundError,
  ExchangeNotFoundError,
  ExchangeStateError,
  ExchangeExpiredError
} from '../errors';

describe('WorkflowService', () => {
  let workflowService: WorkflowService;
  let mockWorkflowRepository: IWorkflowRepository;
  let mockExchangeRepository: IExchangeRepository;

  const mockWorkflow: IWorkflow = {
    id: 'workflow-1',
    userId: 'user-1',
    config: {
      steps: {
        initial: {
          step: {
            verifiablePresentationRequest: {
              query: [{
                type: 'QueryByExample',
                credentialQuery: []
              }]
            },
            createChallenge: true,
            nextStep: 'issue'
          }
        },
        issue: {
          step: {
            issueRequests: [{
              credentialTemplateId: 'template-1'
            }]
          }
        }
      },
      initialStep: 'initial',
      credentialTemplates: [{
        id: 'template-1',
        type: 'jsonata',
        template: '{"@context":["https://www.w3.org/ns/credentials/v2"],"type":["VerifiableCredential"],"credentialSubject":presentation.verifiableCredential[0].credentialSubject}'
      }]
    },
    exchanges: ['exchange-1'],
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const mockExchange: IExchange = {
    id: 'exchange-1',
    workflowId: 'workflow-1',
    step: 'initial',
    state: 'pending',
    ttl: '900000',
    variables: [],
    createdAt: new Date(),
    updatedAt: new Date()
  };

  beforeEach(() => {
    mockWorkflowRepository = {
      find: mock(() => Promise.resolve([mockWorkflow])),
      findOne: mock((query) => Promise.resolve(query.id === mockWorkflow.id ? mockWorkflow : null)),
      findOneAndDelete: mock((query) => Promise.resolve(query.id === mockWorkflow.id ? mockWorkflow : null)),
      create: mock((data) => Promise.resolve({ ...mockWorkflow, ...data })),
      save: mock(() => Promise.resolve())
    };

    mockExchangeRepository = {
      find: mock(() => Promise.resolve([mockExchange])),
      findOne: mock((query) => Promise.resolve(query.id === mockExchange.id ? mockExchange : null)),
      findOneAndUpdate: mock((query, update) => Promise.resolve({ ...mockExchange, ...update.$set })),
      create: mock((data) => Promise.resolve({ ...mockExchange, ...data })),
      save: mock(() => Promise.resolve())
    };

    workflowService = new WorkflowService({
      workflowRepository: mockWorkflowRepository,
      exchangeRepository: mockExchangeRepository,
      verificationMethods: Buffer.from(JSON.stringify([{
        id: 'did:example:issuer#key-1',
        controller: 'did:example:issuer',
        publicKeyMultibase: 'z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2',
        secretKeyMultibase: 'z3u2en7t8GjWgM3vKje7Tn4EMpVz8CTWpgSvYcTVwt42zf'
      }])).toString('base64')
    });
  });

  describe('getAllWorkflows', () => {
    it('should return all workflows', async () => {
      const workflows = await workflowService.getAllWorkflows();
      expect(workflows).toEqual([mockWorkflow]);
      expect(mockWorkflowRepository.find).toHaveBeenCalled();
    });
  });

  describe('getUserWorkflows', () => {
    it('should return workflows for a specific user', async () => {
      const workflows = await workflowService.getUserWorkflows('user-1');
      expect(workflows).toEqual([mockWorkflow]);
      expect(mockWorkflowRepository.find).toHaveBeenCalledWith({ userId: 'user-1' });
    });
  });

  describe('createWorkflow', () => {
    it('should create a new workflow', async () => {
      const config: WorkflowConfig = mockWorkflow.config;
      const workflow = await workflowService.createWorkflow(config, 'user-1');
      
      expect(workflow).toBeDefined();
      expect(mockWorkflowRepository.create).toHaveBeenCalledWith({
        userId: 'user-1',
        config,
        exchanges: []
      });
    });

    it('should throw error for invalid workflow config', async () => {
      const invalidConfig = { ...mockWorkflow.config, initialStep: undefined };
      
      await expect(
        workflowService.createWorkflow(invalidConfig as any, 'user-1')
      ).rejects.toThrow('Invalid workflow configuration: initialStep must be a string');
    });
  });

  describe('createExchange', () => {
    it('should create a new exchange', async () => {
      const exchange = await workflowService.createExchange('workflow-1');
      
      expect(exchange).toBeDefined();
      expect(mockExchangeRepository.create).toHaveBeenCalledWith({
        workflowId: 'workflow-1',
        ttl: '900000',
        variables: [],
        step: mockWorkflow.config.initialStep,
        state: 'pending'
      });
    });

    it('should throw error for non-existent workflow', async () => {
      mockWorkflowRepository.findOne = mock(() => Promise.resolve(null));
      
      await expect(
        workflowService.createExchange('non-existent')
      ).rejects.toThrow(WorkflowNotFoundError);
    });
  });

  describe('participateInExchange', () => {
    it('should handle empty request with VPR', async () => {
      const result = await workflowService.participateInExchange('workflow-1', 'exchange-1');
      
      expect(result.response.verifiablePresentationRequest).toBeDefined();
      expect(result.stateUpdate.state).toBe('active');
    });

    it('should handle verifiable presentation submission', async () => {
      const vp = {
        '@context': ['https://www.w3.org/ns/credentials/v2'],
        type: ['VerifiablePresentation'],
        holder: { id: 'did:example:holder' },
        verifiableCredential: [],
        proof: {
          type: 'DataIntegrityProof',
          created: new Date().toISOString(),
          verificationMethod: 'did:example:holder#key-1',
          proofPurpose: 'authentication',
          proofValue: 'z1234',
          cryptosuite: 'eddsa-rdfc-2022'
        }
      };

      const result = await workflowService.participateInExchange('workflow-1', 'exchange-1', {
        verifiablePresentation: vp
      });

      expect(result.stateUpdate.variables).toBeDefined();
      expect(mockExchangeRepository.findOneAndUpdate).toHaveBeenCalled();
    });
  });

  describe('getExchange', () => {
    it('should return exchange if valid', async () => {
      const exchange = await workflowService.getExchange('workflow-1', 'exchange-1');
      expect(exchange).toEqual(mockExchange);
    });

    it('should throw if exchange not found', async () => {
      mockExchangeRepository.findOne = mock(() => Promise.resolve(null));
      
      await expect(
        workflowService.getExchange('workflow-1', 'non-existent')
      ).rejects.toThrow(ExchangeNotFoundError);
    });

    it('should throw if exchange belongs to different workflow', async () => {
      const wrongExchange = { ...mockExchange, workflowId: 'different-workflow' };
      mockExchangeRepository.findOne = mock(() => Promise.resolve(wrongExchange));
      
      await expect(
        workflowService.getExchange('workflow-1', 'exchange-1')
      ).rejects.toThrow(ExchangeStateError);
    });

    it('should throw if exchange is expired', async () => {
      const expiredExchange = {
        ...mockExchange,
        createdAt: new Date(Date.now() - 1000000),
        ttl: '1000'
      };
      mockExchangeRepository.findOne = mock(() => Promise.resolve(expiredExchange));
      
      await expect(
        workflowService.getExchange('workflow-1', 'exchange-1')
      ).rejects.toThrow(ExchangeExpiredError);
    });
  });

  describe('updateExchangeState', () => {
    it('should update exchange state if transition is valid', async () => {
      const pendingExchange = { ...mockExchange, state: 'pending' };
      mockExchangeRepository.findOne = mock(() => Promise.resolve(pendingExchange as any));

      await workflowService.updateExchangeState('workflow-1', 'exchange-1', {
        state: 'active'
      });

      expect(mockExchangeRepository.findOneAndUpdate).toHaveBeenCalledWith(
        { id: 'exchange-1', workflowId: 'workflow-1' },
        { $set: { state: 'active' } },
        { new: true, runValidators: true }
      );
    });

    it('should throw error for invalid state transition', async () => {
      const completeExchange = { ...mockExchange, state: 'complete' };
      mockExchangeRepository.findOne = mock(() => Promise.resolve(completeExchange as any));

      await expect(
        workflowService.updateExchangeState('workflow-1', 'exchange-1', {
          state: 'pending'
        })
      ).rejects.toThrow(ExchangeStateError);
    });
  });

  describe('deleteWorkflow', () => {
    it('should delete workflow if exists', async () => {
      const result = await workflowService.deleteWorkflow('workflow-1');
      expect(result).toEqual(mockWorkflow);
      expect(mockWorkflowRepository.findOneAndDelete).toHaveBeenCalledWith({ id: 'workflow-1' });
    });

    it('should throw error if workflow not found', async () => {
      mockWorkflowRepository.findOneAndDelete = mock(() => Promise.resolve(null));
      
      expect(
        workflowService.deleteWorkflow('non-existent')
      ).rejects.toThrow(WorkflowNotFoundError);
    });
  });
}); 