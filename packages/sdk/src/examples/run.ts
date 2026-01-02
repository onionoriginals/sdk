/**
 * Example Runner
 * 
 * Run all SDK examples to demonstrate functionality.
 * 
 * Usage:
 *   bun run src/examples/run.ts
 *   bun run src/examples/run.ts basic
 *   bun run src/examples/run.ts module
 *   bun run src/examples/run.ts lifecycle
 */

import { basicExample, digitalArtExample } from './basic-usage';
import { main as createModuleExample } from './create-module-original';
import { main as fullLifecycleExample } from './full-lifecycle-flow';

async function runAll(): Promise<void> {
  console.log('Running all Originals SDK examples...\n');
  
  console.log('='.repeat(60));
  console.log('BASIC USAGE EXAMPLES');
  console.log('='.repeat(60));
  await basicExample();
  await digitalArtExample();
  
  console.log('\n' + '='.repeat(60));
  console.log('CREATE MODULE ORIGINAL EXAMPLES');
  console.log('='.repeat(60));
  await createModuleExample();
  
  console.log('\n' + '='.repeat(60));
  console.log('FULL LIFECYCLE FLOW EXAMPLE');
  console.log('='.repeat(60));
  await fullLifecycleExample();
  
  console.log('\n' + '='.repeat(60));
  console.log('ALL EXAMPLES COMPLETED SUCCESSFULLY');
  console.log('='.repeat(60));
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  
  switch (arg) {
    case 'basic':
      await basicExample();
      await digitalArtExample();
      break;
    case 'module':
      await createModuleExample();
      break;
    case 'lifecycle':
      await fullLifecycleExample();
      break;
    default:
      await runAll();
  }
}

main().catch(console.error);