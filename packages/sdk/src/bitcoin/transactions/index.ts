/**
 * Bitcoin Transactions
 *
 * This directory contains modules for creating and managing Bitcoin transactions,
 * particularly for Ordinals inscriptions.
 */

// Export commit transaction functionality
export {
  createCommitTransaction,
  type CommitTransactionParams,
  type CommitTransactionResult
} from './commit.js';
