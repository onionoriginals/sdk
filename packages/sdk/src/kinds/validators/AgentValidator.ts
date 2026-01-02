/**
 * Agent Kind Validator
 * 
 * Validates manifests for AI agents or autonomous systems with capabilities and model info.
 */

import { OriginalKind, type OriginalManifest, type ValidationResult, type AgentMetadata } from '../types';
import { BaseKindValidator, ValidationUtils } from './base';

/**
 * Known AI model providers
 */
const KNOWN_PROVIDERS = [
  'openai', 'anthropic', 'google', 'meta', 'mistral', 'cohere',
  'huggingface', 'replicate', 'together', 'groq', 'perplexity',
  'fireworks', 'local', 'custom',
];

/**
 * Valid memory types
 */
const VALID_MEMORY_TYPES = ['stateless', 'session', 'persistent'];

/**
 * Validator for Agent Originals
 */
export class AgentValidator extends BaseKindValidator<OriginalKind.Agent> {
  readonly kind = OriginalKind.Agent;
  
  protected validateKind(manifest: OriginalManifest<OriginalKind.Agent>): ValidationResult {
    const errors: ValidationResult['errors'] = [];
    const warnings: ValidationResult['warnings'] = [];
    const metadata = manifest.metadata as AgentMetadata;
    
    // Validate metadata exists
    if (!metadata || typeof metadata !== 'object') {
      return ValidationUtils.failure([
        ValidationUtils.error('MISSING_METADATA', 'Agent manifest must have metadata', 'metadata'),
      ]);
    }
    
    // Validate capabilities (required)
    if (!metadata.capabilities) {
      errors.push(ValidationUtils.error(
        'MISSING_CAPABILITIES',
        'Agent must specify capabilities',
        'metadata.capabilities',
      ));
    } else if (!Array.isArray(metadata.capabilities)) {
      errors.push(ValidationUtils.error(
        'INVALID_CAPABILITIES',
        'Capabilities must be an array of strings',
        'metadata.capabilities',
      ));
    } else if (metadata.capabilities.length === 0) {
      errors.push(ValidationUtils.error(
        'EMPTY_CAPABILITIES',
        'Agent must have at least one capability',
        'metadata.capabilities',
      ));
    } else {
      for (let i = 0; i < metadata.capabilities.length; i++) {
        if (typeof metadata.capabilities[i] !== 'string') {
          errors.push(ValidationUtils.error(
            'INVALID_CAPABILITY',
            `Capability at index ${i} must be a string`,
            `metadata.capabilities[${i}]`,
          ));
        } else if (metadata.capabilities[i].length === 0) {
          errors.push(ValidationUtils.error(
            'EMPTY_CAPABILITY',
            `Capability at index ${i} cannot be empty`,
            `metadata.capabilities[${i}]`,
          ));
        }
      }
    }
    
    // Validate model if specified
    if (metadata.model) {
      if (typeof metadata.model !== 'object') {
        errors.push(ValidationUtils.error(
          'INVALID_MODEL',
          'Model must be an object',
          'metadata.model',
        ));
      } else {
        // Model name is required
        if (!metadata.model.name || typeof metadata.model.name !== 'string') {
          errors.push(ValidationUtils.error(
            'MISSING_MODEL_NAME',
            'Model must have a name',
            'metadata.model.name',
          ));
        }
        
        // Validate provider if specified
        if (metadata.model.provider) {
          const normalizedProvider = metadata.model.provider.toLowerCase();
          if (!KNOWN_PROVIDERS.includes(normalizedProvider)) {
            warnings.push(ValidationUtils.warning(
              'UNKNOWN_PROVIDER',
              `Model provider "${metadata.model.provider}" is not a commonly recognized provider`,
              'metadata.model.provider',
              `Consider using one of: ${KNOWN_PROVIDERS.join(', ')}`,
            ));
          }
        }
      }
    }
    
    // Validate input/output types if specified
    if (metadata.inputTypes) {
      if (!Array.isArray(metadata.inputTypes)) {
        errors.push(ValidationUtils.error(
          'INVALID_INPUT_TYPES',
          'Input types must be an array',
          'metadata.inputTypes',
        ));
      }
    }
    
    if (metadata.outputTypes) {
      if (!Array.isArray(metadata.outputTypes)) {
        errors.push(ValidationUtils.error(
          'INVALID_OUTPUT_TYPES',
          'Output types must be an array',
          'metadata.outputTypes',
        ));
      }
    }
    
    // Validate memory if specified
    if (metadata.memory) {
      if (typeof metadata.memory !== 'object') {
        errors.push(ValidationUtils.error(
          'INVALID_MEMORY',
          'Memory must be an object',
          'metadata.memory',
        ));
      } else {
        if (!metadata.memory.type || !VALID_MEMORY_TYPES.includes(metadata.memory.type)) {
          errors.push(ValidationUtils.error(
            'INVALID_MEMORY_TYPE',
            `Memory type must be one of: ${VALID_MEMORY_TYPES.join(', ')}`,
            'metadata.memory.type',
            metadata.memory.type,
          ));
        }
        
        if (metadata.memory.maxSize !== undefined && 
            (typeof metadata.memory.maxSize !== 'number' || metadata.memory.maxSize <= 0)) {
          errors.push(ValidationUtils.error(
            'INVALID_MEMORY_SIZE',
            'Memory maxSize must be a positive number',
            'metadata.memory.maxSize',
          ));
        }
      }
    }
    
    // Validate tools if specified
    if (metadata.tools) {
      if (!Array.isArray(metadata.tools)) {
        errors.push(ValidationUtils.error(
          'INVALID_TOOLS',
          'Tools must be an array',
          'metadata.tools',
        ));
      } else {
        for (let i = 0; i < metadata.tools.length; i++) {
          const tool = metadata.tools[i];
          const toolPath = `metadata.tools[${i}]`;
          
          if (!tool || typeof tool !== 'object') {
            errors.push(ValidationUtils.error(
              'INVALID_TOOL',
              `Tool at index ${i} must be an object`,
              toolPath,
            ));
            continue;
          }
          
          if (!tool.name || typeof tool.name !== 'string') {
            errors.push(ValidationUtils.error(
              'MISSING_TOOL_NAME',
              `Tool at index ${i} must have a name`,
              `${toolPath}.name`,
            ));
          }
          
          if (!tool.description || typeof tool.description !== 'string') {
            warnings.push(ValidationUtils.warning(
              'MISSING_TOOL_DESC',
              `Tool "${tool.name || i}" should have a description`,
              `${toolPath}.description`,
            ));
          }
        }
      }
    }
    
    // Validate rate limits if specified
    if (metadata.rateLimit) {
      if (typeof metadata.rateLimit !== 'object') {
        errors.push(ValidationUtils.error(
          'INVALID_RATE_LIMIT',
          'Rate limit must be an object',
          'metadata.rateLimit',
        ));
      } else {
        if (metadata.rateLimit.requestsPerMinute !== undefined &&
            (typeof metadata.rateLimit.requestsPerMinute !== 'number' || 
             metadata.rateLimit.requestsPerMinute <= 0)) {
          errors.push(ValidationUtils.error(
            'INVALID_RPM',
            'requestsPerMinute must be a positive number',
            'metadata.rateLimit.requestsPerMinute',
          ));
        }
        
        if (metadata.rateLimit.tokensPerMinute !== undefined &&
            (typeof metadata.rateLimit.tokensPerMinute !== 'number' || 
             metadata.rateLimit.tokensPerMinute <= 0)) {
          errors.push(ValidationUtils.error(
            'INVALID_TPM',
            'tokensPerMinute must be a positive number',
            'metadata.rateLimit.tokensPerMinute',
          ));
        }
      }
    }
    
    // Suggest adding model info for AI agents
    if (!metadata.model) {
      warnings.push(ValidationUtils.warning(
        'MISSING_MODEL',
        'Consider adding model information if this is an AI-based agent',
        'metadata.model',
      ));
    }
    
    // Suggest adding system prompt
    if (!metadata.systemPrompt) {
      warnings.push(ValidationUtils.warning(
        'MISSING_SYSTEM_PROMPT',
        'Consider adding a system prompt to define the agent\'s behavior',
        'metadata.systemPrompt',
      ));
    }
    
    return errors.length > 0
      ? ValidationUtils.failure(errors, warnings)
      : ValidationUtils.success(warnings);
  }
}

