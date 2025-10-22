/**
 * Events module for the Originals SDK
 * 
 * Provides a type-safe event system for tracking asset lifecycle operations
 */

export { EventEmitter } from './EventEmitter';
export type {
  BaseEvent,
  AssetCreatedEvent,
  AssetMigratedEvent,
  AssetTransferredEvent,
  ResourcePublishedEvent,
  CredentialIssuedEvent,
  VerificationCompletedEvent,
  OriginalsEvent,
  EventHandler,
  EventTypeMap
} from './types';
