/**
 * One agent: what it published, what it has at stake, and what it has done.
 *
 * The three are separated on purpose, because they are three different kinds
 * of claim. The listing is what the agent says about itself. The bond is what
 * it has put behind that. The record is what actually happened, and only the
 * last two are worth anything without the first being true.
 */

import { api, useAsync, type AgentDetail, type RunSummary } from '../api.js';
import { ago, count, kindName, og, pct, short } from '../format.js';
import {
  Avatar,
  Chip,
  Command,
  Copyable,
  Empty,
  ErrorNote,
  Loading,
  Section,
  Stat,
  StatRow,
  type Tone,
} from '../components/ui.js';

function RunLine({ run }: { run: RunSummary }) {
  const tone: Tone = run.succeeded ? 'ok' : run.sealed ? 'bad' : 'muted';
  return (
    <tr>
      <td>
        <a href={`#/run/${run.runId}`}>
          <code>{short(run.runId, 14)}</code>
        </a>
      </td>
      <td className="num">{run.stepCount}</td>
      <td>
        <Chip tone={tone}>{run.sealed ? (run.outcomeName ?? 'sealed') : 'unsealed'}</Chip>
      </td>
      <td className="num dim">{run.lastBlock}</td>
    </tr>
  );
}

/**
 * The bond panel.
 *
 * Slashing is stated in full rather than as a badge. It is the one thing on
 * this page that accuses someone, and it deserves the sentence explaining
 * exactly what was proven — signing two different answers for one step — so a
 * reader is not left guessing what the agent actually did.
 */
function BondPanel({ bond }: { bond: AgentDetail['bond'] }) {
  if (bond === null) {
    return (
      <div className="panel">
        <p className="muted">
          This agent has posted no bond. A record alone does not survive an agent discarding its
          identity and minting a fresh one, so a flow can require a bond as well as a history.
        </p>
      </div>
    );
  }

  if (bond.slashed) {
    return (
      <div className="panel bad">
        <p>
          <strong className="bad">Slashed for equivocation.</strong>
        </p>
        <p className="muted">
          Someone proved on chain that this agent's own registered key signed two different outputs
          for the same step of the same run. A step has one answer, so signing two means telling
          different parties different things about the same work. Its bond was taken — half to
          whoever proved it, half destroyed — and the mark is permanent.
        </p>
      </div>
    );
  }

  const amount = BigInt(bond.amount);
  const unbonding = BigInt(bond.unlockAt) > 0n;

  if (amount === 0n) {
    return (
      <div className="panel">
        <p className="muted">The bond has been withdrawn. Nothing is currently at stake.</p>
      </div>
    );
  }

  return (
    <div className={`panel ${unbonding ? 'warn' : 'ok'}`}>
      <p>
        <strong className={unbonding ? 'warn' : 'ok'}>
          {og(bond.amount)} bonded{unbonding ? ', and being withdrawn' : ''}.
        </strong>
      </p>
      <p className="muted">
        {unbonding
          ? 'A withdrawal has been requested, so this bond is on its way out. It is still posted until the cooldown elapses.'
          : 'Slashable only if this agent is caught signing two different outputs for one step. It is a cost to discarding this identity and a deterrent against equivocation — not a guarantee of quality, which nothing on chain can judge.'}
      </p>
    </div>
  );
}

export function AgentPage({ agentId }: { agentId: string }) {
  const { data, error, loading } = useAsync(
    () => api<AgentDetail>(`/api/agents/${agentId}`),
    [agentId],
  );

  if (loading) return <Loading rows={3} />;
  if (error !== null) return <ErrorNote what="this agent" error={error} />;

  const { listing, agent, bond, health, runs } = data!;
  const name = listing?.metadata?.name ?? `Agent #${agentId}`;

  return (
    <>
      <header className="hero enter" style={{ paddingBottom: 8 }}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          <Avatar agentId={agentId} name={listing?.metadata?.name} />
          <div>
            <div className="label" style={{ marginBottom: 6 }}>
              Agent #{agentId}
            </div>
            <h1 style={{ fontSize: 30, margin: '0 0 8px' }}>{name}</h1>
            <p className="lede" style={{ fontSize: 13 }}>
              {listing?.metadata?.description ?? (
                <span className="dim">
                  This agent has anchored steps but is not listed in the adapter registry, so there
                  is nothing published about what it does.
                </span>
              )}
            </p>
            <div className="metaline" style={{ marginTop: 10, gap: 6 }}>
              {listing !== null && !listing.active && <Chip tone="muted">withdrawn</Chip>}
              {bond?.slashed === true && <Chip tone="bad">slashed</Chip>}
              {listing?.metadata?.conformance?.conformant === true && (
                <Chip tone="info">conformant</Chip>
              )}
              {health !== null && (
                <Chip tone={health.ok ? 'ok' : 'warn'} title="An observation, not a verifiable fact">
                  {health.ok ? `answered ${ago(health.checkedAt)}` : `no answer ${ago(health.checkedAt)}`}
                </Chip>
              )}
            </div>
          </div>
        </div>

        <StatRow>
          {/* Rates always with their denominator: "100% ok" over one step is
              not the same claim as over a hundred. */}
          <Stat
            label="Steps ok"
            value={pct(agent.successRate)}
            accent={agent.successRate === 1 && agent.stepCount > 0}
            note={`${count(agent.okCount)}/${count(agent.stepCount)} anchored`}
          />
          <Stat label="Runs" value={count(agent.runCount)} />
          {/* "0%" would read as a failure when in fact no step of these runs
              asked for an attestation. Say which it is. */}
          <Stat
            label="Attested"
            value={agent.attestedCount === 0 ? 'none' : pct(agent.attestationRate)}
            note={
              agent.attestedCount === 0
                ? 'no step anchored one'
                : `${count(agent.attestedCount)}/${count(agent.stepCount)} steps`
            }
          />
          {/* `og(0)` says "free", which is the right word for a price and the
              wrong one for a stake: an agent with nothing bonded has not
              generously waived a fee. */}
          <Stat
            label="Bonded"
            value={
              bond === null || BigInt(bond.amount) === 0n ? 'none' : og(bond.amount)
            }
            accent={bond !== null && !bond.slashed && BigInt(bond.amount) > 0n}
            note={bond?.slashed === true ? 'taken when it was slashed' : undefined}
          />
        </StatRow>
      </header>

      <Section title="Stake">
        <BondPanel bond={bond} />
      </Section>

      {listing !== null && (
        <Section title="What it published">
          <div className="panel">
            <dl className="kv">
              <dt>Endpoint</dt>
              <dd>
                <a href={listing.endpoint} target="_blank" rel="noreferrer">
                  {listing.endpoint}
                </a>
              </dd>
              <dt>Price</dt>
              <dd>{og(listing.pricePerCall)} per call</dd>
              <dt>Kind</dt>
              <dd>{kindName(listing.kind)}</dd>
              <dt>Version</dt>
              <dd>v{listing.version}</dd>
              <dt title="The key whose signature counts as this agent's">Signer</dt>
              <dd>
                <Copyable text={listing.signer} keep={18} />
              </dd>
              <dt title="Where the escrow sends payment">Pays to</dt>
              <dd>
                <Copyable text={listing.payTo} keep={18} />
              </dd>
              <dt>Owner</dt>
              <dd>
                <Copyable text={listing.owner} keep={18} />
              </dd>
              <dt title="The JSON Schema this agent committed to, on 0G Storage">Schema</dt>
              <dd>
                <Copyable text={listing.schemaRoot} keep={18} />
              </dd>
            </dl>
            <p className="dim" style={{ fontSize: 12, marginTop: 14 }}>
              The signer is deliberately not the owner. The owner is a cold key holding an NFT; the
              signer is a hot key inside a running service, and requiring the owner to sign every
              output would put it on whatever machine serves traffic.
            </p>
          </div>
        </Section>
      )}

      <Section title={`Runs (${runs.length})`}>
        {runs.length === 0 ? (
          <Empty>This agent has not appeared in any indexed run yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Run</th>
                  <th className="num">Steps</th>
                  <th>Outcome</th>
                  <th className="num">Block</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <RunLine key={run.runId} run={run} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Hire it">
        <div className="panel">
          <p className="muted">
            Name this agent in a flow step. The executor resolves its endpoint from the registry, so
            nothing about where it runs needs to be configured — and{' '}
            <code>requireSignedOutput</code> makes it prove the work was its own.
          </p>
          <Command>{`{ "id": "audit", "agent": "${agentId}", "input": { … }, "requireSignedOutput": true }`}</Command>
        </div>
      </Section>
    </>
  );
}
