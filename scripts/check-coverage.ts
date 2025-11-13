#!/usr/bin/env bun

/**
 * Checks coverage thresholds from test output
 * Reads from stdin (piped from bun test --coverage) or from a file
 * 
 * Usage:
 *   bun test --coverage | bun run scripts/check-coverage.ts
 *   bun test --coverage > coverage.txt && bun run scripts/check-coverage.ts coverage.txt
 */

import { readFile } from 'fs/promises';

const MIN_LINE_COVERAGE = 90;
const MIN_FUNCTION_COVERAGE = 90;

// Read input from file argument or stdin
let output: string;
if (process.argv[2]) {
  // Read from file
  output = await readFile(process.argv[2], 'utf-8');
} else {
  // Read from stdin and pass through to stdout
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
    // Pass through to stdout so test output is visible
    process.stdout.write(chunk);
  }
  output = new TextDecoder().decode(Bun.concatArrayBuffers(chunks));
}

// Parse coverage from output - look for "All files" line
const lines = output.split('\n');
const allFilesLine = lines.find(line => line.includes('All files') && line.includes('|'));
if (!allFilesLine) {
  console.error('❌ Could not parse coverage output');
  console.error('Output sample:', output.slice(-500));
  process.exit(1);
}

// Extract percentages: "All files                                              |   82.88 |   83.68 |"
const match = allFilesLine.match(/\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/);
if (!match) {
  console.error('❌ Could not parse coverage percentages from line:', allFilesLine);
  process.exit(1);
}

const functionCoverage = parseFloat(match[1]);
const lineCoverage = parseFloat(match[2]);

console.log(`\n📊 Coverage: Functions ${functionCoverage}%, Lines ${lineCoverage}%`);
console.log(`   Required: Functions ${MIN_FUNCTION_COVERAGE}%, Lines ${MIN_LINE_COVERAGE}%`);

if (functionCoverage < MIN_FUNCTION_COVERAGE || lineCoverage < MIN_LINE_COVERAGE) {
  console.error('\n❌ Coverage thresholds not met');
  process.exit(1);
}

console.log('\n✅ Coverage thresholds met');
process.exit(0);

