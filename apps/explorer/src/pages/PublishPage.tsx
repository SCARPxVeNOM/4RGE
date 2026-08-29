/**
 * Publishing an agent without a terminal.
 *
 * The CLI has always been the front door, and it asks for a private key on the
 * command line. That is fine for someone who already has one in an environment
 * variable and wrong for everyone else — it is the single step between "I built
 * an agent" and "anyone can hire it", and it should not require handing a key
 * to a program you have not read.
 *
 * So the two writes happen in the visitor's own wallet. This page never sees a
 * key, and the explorer's server never sends a transaction. The split is:
 *
 *   server   probes the endpoint, runs the §6.4 gate, pays to store the schema
 *   wallet   mints the identity, writes the listing
 *
 * The server's half is checkable after the fact — the schema is a public 0G
 * Storage object and `npx @0gflow/conform` re-runs the suite from your own
 * machine — and the page says so rather than asking to be trusted.
 *
 * Ordering is the same as the CLI's and for the same reason: nothing
 * irreversible happens before the reversible checks have passed. A failing
 * agent costs the publisher a probe, not a minted identity that can never be
 * cleaned up.
 */

import { useEffect, useState } from 'react';
import {
  encodeRegisterAdapter,
  encodeRegisterIdentity,
  listingMetadataURI,
  registrationTokenURI,
} from '@0gflow/publish/calldata';
import { api, useAsync, type Health } from '../api.js';
import { Chip, Command, Copyable, Empty, Section } from '../components/ui.js';
import { HeroShot } from '../components/HeroShot.js';
import {
  call,
  connect,
  currentAccount,
  ensureChain,
  hashSignature,
  hasWallet,
  mintedTokenId,
  onAccountsChanged,
  sendTransaction,
  waitForReceipt,
} from '../wallet.js';

/** Galileo rejects transactions below a minimum tip; wallets estimate under it. */
const GAS_PRICE = 5_000_000_000n;

/** Selectors, derived rather than pasted — see the note in wallet.ts. */
const selector = (signature: string) => hashSignature(signature).slice(0, 10);
const HAS_ADAPTER = selector('hasAdapter(uint256)');
const SIGNER_OF = selector('signerOf(uint256)');
const GET_ADAPTER = selector('getAdapter(uint256)');

const uint256 = (value: bigint) => value.toString(16).padStart(64, '0');

interface ConformanceCheck {
  readonly title: string;
  readonly detail: string;
  readonly passed: boolean;
  readonly severity: string;
}

interface Preflight {
  readonly endpoint: string;
  readonly conformance: { readonly conformant: boolean; readonly results: ConformanceCheck[] };
  readonly schemaRoot: string | null;
  readonly schemaNote: string | null;
  readonly signer: string | null;
}

type Phase = 'form' | 'checking' | 'checked' | 'publishing' | 'done';

interface Progress {
  readonly label: string;
  readonly detail?: string;
  readonly tx?: string;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function PublishPage() {
  const health = useAsync(() => api<Health>('/api/health'), []);

  const [endpoint, setEndpoint] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [signer, setSigner] = useState('');
  const [payTo, setPayTo] = useState('');
  const [price, setPrice] = useState('');
  const [existingId, setExistingId] = useState('');

  const [phase, setPhase] = useState<Phase>('form');
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [steps, setSteps] = useState<Progress[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);

  useEffect(() => {
    void currentAccount().then(setAccount);
    return onAccountsChanged(setAccount);
  }, []);

  const network = health.data?.network;
  const contracts = health.data?.contracts ?? {};
  const registry = contracts['agentAdapterRegistryV2'] ?? null;
  const identity = contracts['identityRegistry'] ?? null;

  const say = (step: Progress) => setSteps((previous) => [...previous, step]);

  async function runPreflight(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setPreflight(null);
    setPhase('checking');
    try {
      const result = await api<Preflight>('/api/publish/preflight', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: endpoint.trim() }),
      });
      setPreflight(result);
      // Offered, never assumed. The publisher is registering the key that will
      // be paid against their name, so it is filled in only when the field is
      // still empty and remains theirs to change.
      if (result.signer !== null && signer === '') setSigner(result.signer);
      setPhase('checked');
    } catch (failure) {
      setError((failure as Error).message);
      setPhase('form');
    }
  }

  /**
   * Reads the current listing's version, so a re-publish increments it.
   *
   * `registerAdapter` reverts with `VersionNotIncreasing` otherwise, and the
   * revert would land after the identity step — an error about versions, shown
   * to someone who was updating an endpoint.
   */
  async function nextVersion(id: bigint): Promise<number> {
    if (registry === null) return 1;
    const exists = await call(registry, `${HAS_ADAPTER}${uint256(id)}`);
    if (BigInt(exists) === 0n) return 1;
    const encoded = await call(registry, `${GET_ADAPTER}${uint256(id)}`);
    // The return is a dynamic tuple: one offset word, then the tuple's ten
    // head words. `version` is the fifth of those, and it is a static field,
    // so it can be read straight out without decoding the strings.
    const body = encoded.replace(/^0x/, '');
    const versionWord = body.slice((1 + 4) * 64, (1 + 5) * 64);
    return Number(BigInt(`0x${versionWord}`)) + 1;
  }

  async function publish() {
    if (preflight === null || network === undefined || registry === null || identity === null) return;
    setError(null);
    setSteps([]);
    setPhase('publishing');

    try {
      const from = account ?? (await connect());
      setAccount(from);

      say({ label: 'Checking the wallet is on the right chain' });
      await ensureChain({
        chainId: network.chainId,
        name: network.name,
        // The RPC the wallet is told to use is the network's own, not this
        // explorer's: a wallet routing a stranger's transactions through a
        // server chosen by a web page is the wrong shape entirely.
        rpcUrl: network.rpcUrl,
        explorerUrl: network.explorer,
        nativeToken: network.nativeToken ?? 'OG',
      });

      // --- identity ------------------------------------------------------
      let id: bigint;
      if (existingId.trim() !== '') {
        id = BigInt(existingId.trim());
        say({ label: `Using identity ${id}`, detail: 'no new token minted' });
      } else {
        say({ label: 'Creating your agent identity', detail: 'approve in your wallet' });
        const tokenURI = registrationTokenURI({
          name: name.trim(),
          description: description.trim(),
          endpoint: preflight.endpoint,
        });
        const hash = await sendTransaction({
          from,
          to: identity,
          data: encodeRegisterIdentity(tokenURI),
          gasPrice: GAS_PRICE,
        });
        say({ label: 'Waiting for the mint to confirm', tx: hash });
        const receipt = await waitForReceipt(hash);
        if (BigInt(receipt.status) !== 1n) throw new Error(`the mint reverted: ${hash}`);
        id = mintedTokenId(receipt, identity, from);
        say({ label: `Minted identity ${id}`, tx: hash });
      }

      // --- listing -------------------------------------------------------
      const version = await nextVersion(id);
      say({
        label: `Listing the agent${version > 1 ? ` (version ${version})` : ''}`,
        detail: 'approve in your wallet',
      });
      const listingTx = await sendTransaction({
        from,
        to: registry,
        data: encodeRegisterAdapter({
          agentId: id,
          kind: 0,
          endpoint: preflight.endpoint,
          schemaRoot: preflight.schemaRoot as `0x${string}`,
          version,
          active: true,
          payTo: (payTo.trim() === '' ? from : payTo.trim()) as `0x${string}`,
          signer: signer.trim() as `0x${string}`,
          pricePerCall: price.trim() === '' ? 0n : BigInt(price.trim()),
          metadataURI: listingMetadataURI({
            name: name.trim(),
            description: description.trim(),
            conformant: preflight.conformance.conformant,
            checks: preflight.conformance.results.length,
          }),
        }),
        gasPrice: GAS_PRICE,
      });
      say({ label: 'Waiting for the listing to confirm', tx: listingTx });
      const listed = await waitForReceipt(listingTx);
      if (BigInt(listed.status) !== 1n) throw new Error(`the listing reverted: ${listingTx}`);

      // --- confirm -------------------------------------------------------
      //
      // §1.3 applies to this page as much as to a run: a successful transaction
      // is not a successful publish. Read the registry back and check it says
      // what was intended, from the chain rather than from the receipt.
      say({ label: 'Reading the listing back from the registry' });
      const registered = await call(registry, `${SIGNER_OF}${uint256(id)}`);
      const onChainSigner = `0x${registered.replace(/^0x/, '').slice(-40)}`;
      if (onChainSigner.toLowerCase() !== signer.trim().toLowerCase()) {
        throw new Error(
          `the registry lists ${onChainSigner} as the signer, not ${signer.trim()}. ` +
            `Outputs signed by your key would not verify, so this is not a working listing.`,
        );
      }

      setAgentId(id.toString());
      setPhase('done');
    } catch (failure) {
      // A wallet rejection is a decision, not a fault, and should not be
      // dressed up as an error the publisher needs to debug.
      const message = (failure as { code?: number; message?: string });
      setError(
        message.code === 4001
          ? 'You rejected the transaction in your wallet. Nothing was published.'
          : (message.message ?? String(failure)),
      );
      setPhase('checked');
    }
  }

  const ready =
    preflight !== null &&
    preflight.conformance.conformant &&
    preflight.schemaRoot !== null &&
    ADDRESS.test(signer.trim()) &&
    (payTo.trim() === '' || ADDRESS.test(payTo.trim())) &&
    name.trim() !== '';

  if (phase === 'done' && agentId !== null) {
    return (
      <Section title="Published">
        <div className="panel ok">
          <h3 style={{ margin: '0 0 10px' }}>Agent {agentId} is live and hireable.</h3>
          <p>
            It is in the directory now and anyone can hire it. One last step: set{' '}
            <code>AGENT_ID={agentId}</code> in your agent&rsquo;s environment and redeploy. Your
            agent includes that number when it signs its work, so until it matches, its signatures
            will not check out.
          </p>
          <p style={{ marginTop: 14 }}>
            <a className="pill" href={`#/agent/${agentId}`}>
              View the listing
            </a>
          </p>
        </div>
        <p className="dim" style={{ marginTop: 16 }}>
          Do not take this page&rsquo;s word for it — run the checks yourself:
        </p>
        <Command>{`npx @0gflow/conform ${preflight?.endpoint ?? ''}`}</Command>
      </Section>
    );
  }

  return (
    <>
      <div className="hero-shot">
        <HeroShot name="publish" />
        <div className="inner">
          <header className="hero enter">
            <h1>
              List your agent. <span className="quiet">Nobody has to approve it.</span>
            </h1>
            <p className="lede">
              Two transactions from your own wallet: one creates your agent&rsquo;s identity, one
              puts it on the market. This page never sees your key. First we call your agent to
              check it behaves the way the marketplace needs — if it does not, you find out before
              anything is created.
            </p>
          </header>
        </div>
      </div>

      <Section title="Your agent">
        <form onSubmit={runPreflight} className="panel" style={{ marginTop: 4 }}>
          <label className="field">
            <span className="label">Endpoint</span>
            <input
              type="url"
              required
              placeholder="https://your-agent.example/agents/audit"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
            />
            <span className="dim">
              Publicly reachable over HTTP. It must answer <code>/health</code>, <code>/schema</code>{' '}
              and <code>/invoke</code>.
            </span>
          </label>

          <button type="submit" className="pill primary" disabled={phase === 'checking'}>
            {phase === 'checking' ? 'Checking the agent…' : 'Check this agent'}
          </button>
        </form>

        {error !== null && (
          <div className="panel bad" style={{ marginTop: 14 }}>
            <p>
              <strong className="bad">{error}</strong>
            </p>
          </div>
        )}

        {!hasWallet() && (
          <div className="panel warn" style={{ marginTop: 14 }}>
            <p>
              No wallet is installed in this browser, so the two transactions cannot be signed here.
              The terminal route does the same thing:
            </p>
            <Command>
              {`ZG_PRIVATE_KEY=0x… npx @0gflow/publish --endpoint ${endpoint || '<url>'} --signer 0x… --name "…"`}
            </Command>
          </div>
        )}
      </Section>

      {preflight !== null && (
        <Section title="Conformance">
          <p className="dim" style={{ marginTop: -4, maxWidth: '68ch' }}>
            Your agent has to answer correctly and predictably, or the jobs it does cannot be
            checked afterwards — and the person hurt by that is whoever hired it. Run these checks
            yourself any time with{' '}
            <code>npx @0gflow/conform {preflight.endpoint}</code>.
          </p>

          <div style={{ margin: '14px 0' }}>
            {preflight.conformance.conformant ? (
              <Chip tone="ok">CONFORMANT · {preflight.conformance.results.length} checks</Chip>
            ) : (
              <Chip tone="bad">NOT CONFORMANT</Chip>
            )}
          </div>

          <div className="checks">
            {preflight.conformance.results.map((check) => (
              <div key={check.title} className={`check ${check.passed ? 'ok' : check.severity}`}>
                <span className="mark">{check.passed ? 'PASS' : check.severity.toUpperCase()}</span>
                <div>
                  <strong>{check.title}</strong>
                  <div className="dim">{check.detail}</div>
                </div>
              </div>
            ))}
          </div>

          {preflight.schemaRoot !== null ? (
            <p style={{ marginTop: 16 }}>
              <span className="label">schema stored at</span>{' '}
              <Copyable text={preflight.schemaRoot} keep={12} />
            </p>
          ) : (
            <div className="panel warn" style={{ marginTop: 16 }}>
              <p>{preflight.schemaNote}</p>
            </div>
          )}
        </Section>
      )}

      {preflight !== null && preflight.conformance.conformant && preflight.schemaRoot !== null && (
        <Section title="The listing">
          <div className="panel">
            <label className="field">
              <span className="label">Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Auditor" />
            </label>

            <label className="field">
              <span className="label">Description</span>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What it does, in one line"
              />
            </label>

            <label className="field">
              <span className="label">Signer address</span>
              <input
                value={signer}
                onChange={(e) => setSigner(e.target.value)}
                placeholder="0x…"
                spellCheck={false}
              />
              <span className="dim">
                The address your agent signs outputs with — not the key that owns this identity, and
                it should hold no funds.{' '}
                {preflight.signer !== null && (
                  <>
                    Your endpoint publishes <code>{preflight.signer}</code> at <code>/health</code>;
                    it is filled in here for convenience, and it is yours to check.
                  </>
                )}
              </span>
            </label>

            <label className="field">
              <span className="label">Paid to (optional)</span>
              <input
                value={payTo}
                onChange={(e) => setPayTo(e.target.value)}
                placeholder="defaults to your wallet address"
                spellCheck={false}
              />
            </label>

            <label className="field">
              <span className="label">Price per call, in wei (optional)</span>
              <input
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="0 — free or negotiated"
                inputMode="numeric"
              />
            </label>

            <label className="field">
              <span className="label">Existing agent id (optional)</span>
              <input
                value={existingId}
                onChange={(e) => setExistingId(e.target.value)}
                placeholder="leave empty to mint a new identity"
                inputMode="numeric"
              />
              <span className="dim">
                Re-listing an agent you already own — a new endpoint, a new key, a new price. The
                registry will refuse if it is not yours.
              </span>
            </label>

            <button
              type="button"
              className="pill primary"
              disabled={!ready || phase === 'publishing'}
              onClick={() => void publish()}
            >
              {phase === 'publishing'
                ? 'Publishing…'
                : account === null
                  ? 'Connect wallet and publish'
                  : `Publish from ${account.slice(0, 6)}…${account.slice(-4)}`}
            </button>
          </div>

          {steps.length > 0 && (
            <ol className="progress">
              {steps.map((step, i) => (
                <li key={i} className={i === steps.length - 1 && phase === 'publishing' ? 'active' : 'done'}>
                  <strong>{step.label}</strong>
                  {step.detail !== undefined && <span className="dim"> — {step.detail}</span>}
                  {step.tx !== undefined && network !== undefined && (
                    <div>
                      <a href={`${network.explorer}/tx/${step.tx}`} target="_blank" rel="noreferrer">
                        <code>{step.tx.slice(0, 18)}…</code>
                      </a>
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </Section>
      )}

      {preflight === null && phase !== 'checking' && (
        <Section title="Or from a terminal">
          <Empty>
            <p>The same two transactions, signed by a key you already hold.</p>
            <Command>
              {`ZG_PRIVATE_KEY=0x… npx @0gflow/publish --endpoint https://your-agent.example --signer 0x… --name "Auditor"`}
            </Command>
          </Empty>
        </Section>
      )}
    </>
  );
}
