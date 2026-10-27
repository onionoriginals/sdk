// Runs the task's named test files and writes a REV test report.
// Usage: run-tests.mjs TASK_JSON SOURCES_DIR TESTS_DIR SOURCE_SHA TESTS_SHA OUTPUT
// When SOURCES_DIR differs from TESTS_DIR, the named test files are copied from
// TESTS_DIR (head) onto SOURCES_DIR (merge base) first. Test failures are data,
// not errors: the base run is expected to fail.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const toolPath = () => resolve(process.env.REV_TOOL_PATH || '.rev-tool');

export const testFiles = task => [...new Set(task.criteria.flatMap(c => c.tests.map(t => t.split(' > ')[0])))].sort();

// TypeScript tests run under Bun from their package directory; .mjs/.js tests under Node from the repository root.
export function runnerFor(file, root) {
  if (/\.test\.(c|m)?js$/.test(file)) return { cwd: root, command: 'node', args: ['--test', '--test-reporter=junit'], path: file };
  if (!/\.test\.tsx?$/.test(file)) throw new Error(`unsupported test file: ${file}`);
  let dir = dirname(join(root, file));
  while (dir !== root && !existsSync(join(dir, 'package.json'))) dir = dirname(dir);
  return { cwd: dir, command: 'bun', args: ['test', '--reporter=junit'], path: relative(dir, join(root, file)) };
}

export async function runTests(task, sourcesDir, testsDir, sourceSha, testsSha) {
  const root = realpathSync(sourcesDir);
  const { testReport } = await import(pathToFileURL(join(toolPath(), 'scripts/junit.js')).href);
  const work = mkdtempSync(join(tmpdir(), 'rev-junit-'));
  const tests = [];
  testFiles(task).forEach((file, i) => {
    if (realpathSync(testsDir) !== root) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      copyFileSync(join(testsDir, file), join(root, file));
    }
    const run = runnerFor(file, root);
    const output = join(work, `${i}.xml`);
    const reporter = run.command === 'node' ? [`--test-reporter-destination=${output}`] : [`--reporter-outfile=${output}`];
    // Drop the parent runner's context so a nested `node --test` writes its own JUnit report.
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    spawnSync(run.command, [...run.args, ...reporter, run.path], { cwd: run.cwd, stdio: 'inherit', timeout: 600000,
      env: { ...env, REV_TOOL_PATH: toolPath() } });
    // A file that cannot load may write no report: its named tests are then missing, which never passes.
    if (existsSync(output)) tests.push(...testReport([readFileSync(output, 'utf8')], realpathSync(run.cwd), root, sourceSha, testsSha).tests);
  });
  return { version: 1, sourceSha, testsSha, tests: tests.sort((a, b) => a.id < b.id ? -1 : 1) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [taskFile, sourcesDir, testsDir, sourceSha, testsSha, output] = process.argv.slice(2);
  if (!output) { console.error('Usage: run-tests.mjs TASK_JSON SOURCES_DIR TESTS_DIR SOURCE_SHA TESTS_SHA OUTPUT'); process.exit(1); }
  const report = await runTests(JSON.parse(readFileSync(taskFile, 'utf8')), sourcesDir, testsDir, sourceSha, testsSha);
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`REV report: ${report.tests.filter(t => t.status === 'passed').length}/${report.tests.length} named-file tests passed on ${sourceSha}`);
}
