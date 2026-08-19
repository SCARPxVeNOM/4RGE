/**
 * @0gflow/verify — entry point.
 *
 * No shebang here: the bundler adds one as a banner, and two would be a
 * syntax error on line 2.
 *
 * Ships as a single bundled file with zero runtime dependencies (§9): a
 * verification tool with a large transitive dependency tree is not something a
 * third party can audit, and auditability is the entire point of this package.
 */

import { main } from './cli.js';

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`\n  unexpected error: ${(error as Error).message}\n`);
    process.exitCode = 2;
  });
