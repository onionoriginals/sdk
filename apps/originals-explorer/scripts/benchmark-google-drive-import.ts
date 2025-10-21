/**
 * Performance Benchmark for Google Drive Import
 *
 * Tests importing 250 images to ensure completion in under 5 minutes.
 *
 * Usage:
 *   bun scripts/benchmark-google-drive-import.ts
 *
 * Requirements:
 * - GOOGLE_ACCESS_TOKEN environment variable
 * - Test folder with at least 250 images in Google Drive
 */

import { createGoogleDriveClient } from '../server/services/googleDriveClient';
import { processDriveFilesBatch } from '../server/services/batchDidCreator';
import { originalsSdk } from '../server/originals';
import { storage } from '../server/storage';

// Configuration
const TARGET_FILE_COUNT = 250;
const MAX_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const BATCH_SIZE = 20; // Optimized batch size for performance

interface BenchmarkResult {
  totalFiles: number;
  successfulFiles: number;
  failedFiles: number;
  durationMs: number;
  durationSeconds: number;
  averageTimePerFile: number;
  filesPerSecond: number;
  passedBenchmark: boolean;
  errors: Array<{ fileName: string; error: string }>;
}

async function runBenchmark(): Promise<BenchmarkResult> {
  const accessToken = process.env.GOOGLE_ACCESS_TOKEN;
  const testFolderId = process.env.BENCHMARK_FOLDER_ID;
  const userId = process.env.BENCHMARK_USER_ID || 'benchmark-user';

  if (!accessToken) {
    throw new Error(
      'GOOGLE_ACCESS_TOKEN environment variable is required.\n' +
      'Get a token from Google OAuth Playground: https://developers.google.com/oauthplayground/'
    );
  }

  if (!testFolderId) {
    throw new Error(
      'BENCHMARK_FOLDER_ID environment variable is required.\n' +
      'Provide the ID of a Google Drive folder containing at least 250 images.'
    );
  }

  console.log('🚀 Google Drive Import Performance Benchmark');
  console.log('='.repeat(60));
  console.log(`Target: ${TARGET_FILE_COUNT} files in under ${MAX_DURATION_MS / 1000}s`);
  console.log(`Batch size: ${BATCH_SIZE}`);
  console.log('='.repeat(60));
  console.log();

  // Initialize Google Drive client
  console.log('📂 Connecting to Google Drive...');
  const driveClient = createGoogleDriveClient(accessToken);

  const canConnect = await driveClient.testConnection();
  if (!canConnect) {
    throw new Error('Failed to connect to Google Drive. Check your access token.');
  }
  console.log('✓ Connected to Google Drive');
  console.log();

  // List files from the folder
  console.log(`📋 Listing files from folder ${testFolderId}...`);
  const filesResult = await driveClient.listImageFilesRecursive(testFolderId);

  console.log(`✓ Found ${filesResult.totalCount} image files`);

  if (filesResult.errors.length > 0) {
    console.log(`⚠️  ${filesResult.errors.length} errors during folder scan:`);
    filesResult.errors.forEach(err => {
      console.log(`   - ${err.folderId}: ${err.error}`);
    });
  }
  console.log();

  // Select files for benchmark
  const filesToImport = filesResult.files.slice(0, TARGET_FILE_COUNT);
  const actualFileCount = filesToImport.length;

  if (actualFileCount < TARGET_FILE_COUNT) {
    console.log(`⚠️  Warning: Only ${actualFileCount} files available (target: ${TARGET_FILE_COUNT})`);
  }

  console.log(`🎯 Importing ${actualFileCount} files...`);
  console.log();

  // Track progress
  let processedCount = 0;
  const progressInterval = setInterval(() => {
    const percent = Math.round((processedCount / actualFileCount) * 100);
    const bar = '█'.repeat(Math.floor(percent / 2)) + '░'.repeat(50 - Math.floor(percent / 2));
    process.stdout.write(`\r[${bar}] ${percent}% (${processedCount}/${actualFileCount})`);
  }, 100);

  // Run the import
  const startTime = Date.now();

  const result = await processDriveFilesBatch(
    filesToImport,
    originalsSdk,
    driveClient,
    userId,
    'benchmark-import',
    storage,
    {
      batchSize: BATCH_SIZE,
      onProgress: (current, total, file) => {
        processedCount = current;
      },
      onError: (file, error) => {
        console.log(`\n❌ Failed: ${file.name} - ${error.message}`);
      },
    }
  );

  const endTime = Date.now();
  const durationMs = endTime - startTime;

  clearInterval(progressInterval);
  console.log(); // New line after progress bar
  console.log();

  // Calculate metrics
  const durationSeconds = durationMs / 1000;
  const averageTimePerFile = durationMs / result.totalProcessed;
  const filesPerSecond = result.totalProcessed / durationSeconds;
  const passedBenchmark = durationMs <= MAX_DURATION_MS;

  return {
    totalFiles: result.totalProcessed,
    successfulFiles: result.successful.length,
    failedFiles: result.failed.length,
    durationMs,
    durationSeconds,
    averageTimePerFile,
    filesPerSecond,
    passedBenchmark,
    errors: result.failed.map(f => ({
      fileName: f.file.name,
      error: f.error || 'Unknown error',
    })),
  };
}

function printResults(result: BenchmarkResult): void {
  console.log('📊 Benchmark Results');
  console.log('='.repeat(60));
  console.log();

  // Summary
  console.log('Summary:');
  console.log(`  Total files:      ${result.totalFiles}`);
  console.log(`  Successful:       ${result.successfulFiles} ✓`);
  console.log(`  Failed:           ${result.failedFiles}${result.failedFiles > 0 ? ' ❌' : ''}`);
  console.log();

  // Performance metrics
  console.log('Performance:');
  console.log(`  Duration:         ${result.durationSeconds.toFixed(2)}s`);
  console.log(`  Target:           ${MAX_DURATION_MS / 1000}s`);
  console.log(`  Avg per file:     ${result.averageTimePerFile.toFixed(0)}ms`);
  console.log(`  Throughput:       ${result.filesPerSecond.toFixed(2)} files/sec`);
  console.log();

  // Benchmark result
  if (result.passedBenchmark) {
    console.log('✅ PASSED: Import completed within 5-minute target!');
  } else {
    const overtime = ((result.durationMs - MAX_DURATION_MS) / 1000).toFixed(2);
    console.log(`❌ FAILED: Import took ${overtime}s longer than target`);
  }
  console.log();

  // Errors
  if (result.errors.length > 0) {
    console.log('Errors:');
    result.errors.forEach((err, i) => {
      console.log(`  ${i + 1}. ${err.fileName}`);
      console.log(`     ${err.error}`);
    });
    console.log();
  }

  console.log('='.repeat(60));
}

// Run benchmark
console.log();
runBenchmark()
  .then(result => {
    printResults(result);
    process.exit(result.passedBenchmark ? 0 : 1);
  })
  .catch(error => {
    console.error();
    console.error('❌ Benchmark failed with error:');
    console.error(error);
    console.error();
    process.exit(1);
  });
