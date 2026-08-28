#!/usr/bin/env node
/**
 * npx @0gflow/publish — list an agent on the marketplace.
 *
 * The private key is read from the environment, never from an argument.
 * Arguments land in shell history, in `ps` output and in CI logs; an
 * environment variable is not secret either, but it does not end up in three
 * places nobody thinks about.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GALILEO, type Network } from '@0gflow/config';
import { publishAgent, PublishError } from './publish.js';

const USAGE = `
0gflow-publish — list an agent so anyone can hire it

  ZG_PRIVATE_KEY=0x… npx @0gflow/publish --endpoint <url> --signer <addr> [options]

Required
  --endpoint <url>     Base URL of the running agent (it must answer /health,
                       /schema and /invoke)
  --signer <addr>      The key that will sign this agent's outputs. Publish the
                       address, never the key.

Options
  --name <text>        Display name for the directory
  --description <text> One line about what the agent does
  --agent-id <n>       Reuse an identity you already own instead of minting
  --pay-to <addr>      Where escrow sends payment    (default: your address)
  --price <wei>        Price per call in wei         (default: 0, negotiated)
  --force              Publish despite conformance failures
  --json               Emit the result as JSON
  --help

The agent is checked against the §6.4 adapter contract before anything is
written to chain. A failing agent is refused: passing is what makes an agent
safe for a stranger to hire.
`;

interface Args {
  endpoint?: string;
  signer?: string;
  name?: string;
  description?: string;
  agentId?: string;
  payTo?: string;
  price?: string;
  force: boolean;
  json: boolean;
  help: boolean;
}

function parse(argv: readonly string[]): Args {
  const args: Args = { force: false, json: false, help: false };
  const flags: Record<string, keyof Args> = {
    '--endpoint': 'endpoint',
    '--signer': 'signer',
    '--name': 'name',
    '--description': 'description',
    '--agent-id': 'agentId',
    '--pay-to': 'payTo',
    '--price': 'price',
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--help' || token === '-h') args.help = true;
    else if (token === '--force') args.force = true;
    else if (token === '--json') args.json = true;
    else if (flags[token] !== undefined) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${token} needs a value`);
      (args as unknown as Record<string, unknown>)[flags[token]!] = value;
    } else if (token.startsWith('-')) {
      throw new Error(`unknown option ${token}`);
    }
  }
  return args;
}

export async function main(argv: readonly string[], network: Network = GALILEO): Promise<number> {
  let args: Args;
  try {
    args = parse(argv);
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }

  if (args.help || argv.length === 0) {
    console.log(USAGE);
    return args.help ? 0 : 2;
  }

  const privateKey = process.env['ZG_PRIVATE_KEY'];
  if (privateKey === undefined || privateKey === '') {
    console.error('ZG_PRIVATE_KEY is not set. It pays for the mint and the registration.');
    return 2;
  }
  if (args.endpoint === undefined) {
    console.error('--endpoint is required: nobody can hire an agent they cannot reach.');
    return 2;
  }
  if (args.signer === undefined) {
    console.error(
      '--signer is required: without a published key, this agent can never prove it produced anything, and the escrow will not pay it.',
    );
    return 2;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(args.signer)) {
    console.error(`--signer must be an address, got ${args.signer}`);
    return 2;
  }

  try {
    const result = await publishAgent({
      network,
      privateKey,
      endpoint: args.endpoint,
      signer: args.signer as `0x${string}`,
      name: args.name ?? args.endpoint,
      description: args.description ?? '',
      force: args.force,
      ...(args.agentId === undefined ? {} : { agentId: BigInt(args.agentId) }),
      ...(args.payTo === undefined ? {} : { payTo: args.payTo as `0x${string}` }),
      ...(args.price === undefined ? {} : { pricePerCall: BigInt(args.price) }),
      log: args.json ? () => {} : (line) => console.log(`  ${line}`),
    });

    if (args.json) {
      console.log(
        JSON.stringify(
          {
            agentId: result.agentId.toString(),
            owner: result.owner,
            endpoint: result.endpoint,
            schemaRoot: result.schemaRoot,
            conformant: result.conformance.conformant,
            mintTx: result.mintTx,
            registrationTx: result.registrationTx,
          },
          null,
          2,
        ),
      );
    } else {
      console.log('');
      console.log(`  published — agent ${result.agentId}`);
      console.log(`  owner     ${result.owner}`);
      console.log(`  endpoint  ${result.endpoint}`);
      console.log(`  schema    ${result.schemaRoot}`);
      console.log(`  tx        ${result.explorerUrl}`);
      console.log('');
      console.log(`  Anyone can now hire it by naming agent ${result.agentId} in a flow.`);
      console.log('');
    }
    return 0;
  } catch (error) {
    const message = error instanceof PublishError ? error.message : (error as Error).message;
    console.error(`\n  not published: ${message}\n`);
    return 1;
  }
}

/**
 * Whether this module is the program being run, rather than imported.
 *
 * Compared as resolved real paths. npm's bin shim execs through
 * `node_modules/.bin/../@0gflow/<pkg>/dist/cli.js`, a symlinked install
 * resolves somewhere else again, and a relative invocation is shorter still —
 * all the same file under different names. Matching on the *shape* of the path,
 * which this used to do, silently ran nothing the moment that shape changed.
 * Running nothing and exiting 0 is the worst failure available to a CLI.
 */
function isEntrypoint(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntrypoint(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: Error) => {
      console.error(error.message);
      process.exit(1);
    });
}
