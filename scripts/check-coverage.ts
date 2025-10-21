#!/usr/bin/env bun

/**
 * Script to validate that test coverage meets minimum thresholds
 * Parses the coverage output from bun test --coverage
 */

import { spawn } from 'child_process';

const MIN_LINE_COVERAGE = 95;
const MIN_FUNCTION_COVERAGE = 95;

async function runTests(): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('bun', ['test', 'tests/integration', 'tests/unit', '--coverage'], {
      stdio: ['inherit', 'pipe', 'pipe'],
      cwd: process.cwd()
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
      process.stdout.write(data);
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      process.stderr.write(data);
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Tests failed with exit code ${code}`));
      } else {
        resolve(stdout + stderr);
      }
    });
  });
}

function parseCoverage(output: string): { functions: number; lines: number } | null {
  // Look for the "All files" line in coverage output
  // Format: "All files                                           |   96.76 |   98.65 |"
  const allFilesMatch = output.match(/All files\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|/);
  
  if (!allFilesMatch) {
    return null;
  }

  return {
    functions: parseFloat(allFilesMatch[1]),
    lines: parseFloat(allFilesMatch[2])
  };
}

async function main() {
  console.log('Running tests with coverage...\n');

  try {
    const output = await runTests();
    const coverage = parseCoverage(output);

    if (!coverage) {
      console.error('\n❌ Could not parse coverage from test output');
      process.exit(1);
    }

    console.log('\n📊 Coverage Results:');
    console.log(`   Functions: ${coverage.functions}% (minimum: ${MIN_FUNCTION_COVERAGE}%)`);
    console.log(`   Lines: ${coverage.lines}% (minimum: ${MIN_LINE_COVERAGE}%)`);

    const functionsPassed = coverage.functions >= MIN_FUNCTION_COVERAGE;
    const linesPassed = coverage.lines >= MIN_LINE_COVERAGE;

    if (functionsPassed && linesPassed) {
      console.log('\n✅ Coverage thresholds met!');
      process.exit(0);
    } else {
      console.log('\n❌ Coverage thresholds not met:');
      if (!functionsPassed) {
        console.log(`   - Functions coverage ${coverage.functions}% is below ${MIN_FUNCTION_COVERAGE}%`);
      }
      if (!linesPassed) {
        console.log(`   - Lines coverage ${coverage.lines}% is below ${MIN_LINE_COVERAGE}%`);
      }
      process.exit(1);
    }
  } catch (error) {
    console.error('\n❌ Error running tests:', error);
    process.exit(1);
  }
}

main();
