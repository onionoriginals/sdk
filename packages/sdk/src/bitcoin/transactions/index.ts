/**
 * Bitcoin Transactions
 *
 * This directory contains modules for creating and managing Bitcoin transactions,
 * particularly for Ordinals inscriptions.
 */

// Export commit transaction functionality
export {
  createCommitTransaction,
  createRevealTransaction,
  type CommitTransactionParams,
  type CommitTransactionResult,
  type RevealTransactionParams,
  type RevealTransactionResult
} from './commit.js';
