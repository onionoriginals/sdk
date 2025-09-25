import type{ IWorkflow, IExchange, WorkflowConfig } from './types';

export interface IWorkflowRepository {
  find(query?: any): Promise<IWorkflow[]>;
  findOne(query: any): Promise<IWorkflow | null>;
  findOneAndDelete(query: any): Promise<IWorkflow | null>;
  create(data: { config: WorkflowConfig; userId: string; exchanges: string[] }): Promise<IWorkflow>;
  save(workflow: IWorkflow): Promise<void>;
}

export interface IExchangeRepository {
  find(query: any): Promise<IExchange[]>;
  findOne(query: any): Promise<IExchange | null>;
  findOneAndUpdate(query: any, update: any, options?: any): Promise<IExchange | null>;
  create(data: {
    workflowId: string;
    ttl: string;
    variables: Record<string, any>[];
    step: string;
    state: string;
  }): Promise<IExchange>;
  save(exchange: IExchange): Promise<void>;
} 