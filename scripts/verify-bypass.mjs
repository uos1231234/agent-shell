// Permanent regression gate for dangerous-command bypass vectors.
// Each case: [command, expectedDangerous].
// Run: npx tsx scripts/verify-bypass.mjs
import { checkDangerousCommand } from '../src/im/tools/security/dangerous-command.js';

const cases = [
  // --- original bypass vectors (fixed v0.16.2 Batch B) ---
  ['bash <<< \'rm -rf /\'', true],                    // here-string
  ['(rm -rf /)', true],                               // bare subshell parens
  ['bash <<EOF\nrm -rf /\nEOF', true],                // here-doc
  ['cat <<X | bash\nrm -rf /\nX', true],              // here-doc piped to shell
  ['$(echo rm -rf /)', true],                         // $() echo payload
  ['echo rm -rf / | bash', true],                     // echo piped (control)
  ['eval \'rm -rf /\'', true],                        // eval (control)
  ['rm -rf /', true],                                 // direct (control)

  // --- second-round bypass vectors (fixed in zero-trust audit Batch B) ---
  ['`echo rm -rf /`', true],                          // backtick echo payload
  ['$(echo $(echo rm -rf /))', true],                 // $() double nesting
  ['bash <<< \'bash <<< rm -rf /\'', true],           // here-string nesting
  ['eval '.repeat(100) + 'rm -rf /', true],           // eval depth 100 (was stack overflow risk)
  ['eval '.repeat(2000) + 'rm -rf /', true],          // eval depth 2000 (depth-limit fail-closed)

  // --- safe controls ---
  ['rm -rf node_modules/', false],                    // artifact cleanup exempt
  ['git push', false],                                // non-force push
  ['echo hello', false],                              // trivial
  ['git clean -n', false],                            // dry-run clean
];

let passed = 0;
let failed = 0;
for (const [cmd, expectedDangerous] of cases) {
  let result;
  try {
    result = checkDangerousCommand(cmd);
  } catch (e) {
    result = `THREW: ${e instanceof Error ? e.message : String(e)}`;
  }
  const isDangerous = result !== null && typeof result === 'object';
  const ok = typeof result === 'object'
    ? isDangerous === expectedDangerous
    : false; // a throw is always a failure
  if (ok) {
    passed += 1;
    console.log(`PASS: ${cmd.slice(0, 45).replace(/\n/g, '\\n').padEnd(47)} expected=${expectedDangerous} got=${isDangerous}`);
  } else {
    failed += 1;
    console.log(`FAIL: ${cmd.slice(0, 45).replace(/\n/g, '\\n').padEnd(47)} expected=${expectedDangerous} got=${typeof result === 'string' ? result : isDangerous}`);
  }
}

console.log(`\n${passed}/${cases.length} passed${failed > 0 ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
