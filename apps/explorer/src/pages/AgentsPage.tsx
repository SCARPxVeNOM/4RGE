/**
 * The marketplace directory.
 *
 * Every column here is derived from something on chain except one, and the
 * page is built around keeping that distinction visible. A listing, a bond and
 * a record can all be recomputed by a stranger; a health probe is this
 * indexer's word for it. They are not presented the same way, and the health
 * column always carries an age.
 */

import { useMemo, useState } from 'react';
import { api, useAsync, type AgentListing } from '../api.js';
import { ago, count, kindName, og, short } from '../format.js';
import { Avatar, Chip, Command, Empty, ErrorNote, Loading, Pills, Section, Stat, StatRow, type FilterOption, type Tone } from '../components/ui.js';

type Filter = 'all' | 'bonded' | 'proven' | 'live' | 'withdrawn';

const FILTERS: readonly FilterOption<Filter>[] = [
  { id: 'all', label: 'All' },
  { id: 'proven', label: 'Has a record' },
  { id: 'bonded', label: 'Bonded' },
  { id: 'live', label: 'Answering' },
  { id: 'withdrawn', label: 'Withdrawn' },
];

/**
 * What the health cell says.
 *
 * Never a bare tick, always an age. This is one process's observation from one
 * vantage at one moment and a reader cannot check it — rendering it like the
 * chain-derived facts beside it would be exactly the overclaim this project
 * exists to avoid.
 *
 * "Down" waits for three failures because a restart and an abandonment look
 * identical until one of them keeps not answering.
 */
function health(agent: AgentListing): { text: string; tone: Tone } {
  const h = agent.health;
  if (h === null) return { text: 'not probed', tone: 'muted' };
  if (h.ok) return { text: `answered ${ago(h.checkedAt)}`, tone: 'ok' };
  if (h.consecutiveFailures < 3) return { text: `no answer ${ago(h.checkedAt)}`, tone: 'warn' };
  return { text: `down · ${h.consecutiveFailures} probes`, tone: 'bad' };
}

/** The bond, and what it is currently worth as a signal. */
function bond(agent: AgentListing): { text: string; tone: Tone } | null {
  const b = agent.bond;
  if (b === null) return null;
  // Slashing is permanent and outranks everything: this agent was caught
  // signing two different answers for one step.
  if (b.slashed) return { text: 'slashed', tone: 'bad' };
  if (BigInt(b.amount) === 0n) return null;
  // A bond being withdrawn is still posted, but it is on its way out — a
  // reader deciding whether to hire should see that, not just the number.
  if (BigInt(b.unlockAt) > 0n) return { text: `${og(b.amount)} unbonding`, tone: 'warn' };
  return { text: `${og(b.amount)} bonded`, tone: 'ok' };
}

function AgentCard({ agent }: { agent: AgentListing }) {
  const name = agent.metadata?.name ?? `Agent #${agent.agentId}`;
  const bonded = bond(agent);
  const probe = health(agent);
  const conformant = agent.metadata?.conformance?.conformant === true;

  return (
    <a className="card agent-card" href={`#/agent/${agent.agentId}`}>
      <Avatar agentId={agent.agentId} name={agent.metadata?.name} />

      <div>
        <div className="name">{name}</div>
        <div className="desc">
          {agent.metadata?.description ?? <span className="dim">No description published.</span>}
        </div>

        <div className="metaline">
          <span>#{agent.agentId}</span>
          <span className="sep">/</span>
          <span>v{agent.version}</span>
          <span className="sep">/</span>
          <span>{kindName(agent.kind)}</span>
          <span className="sep">/</span>
          {/* A rate with no denominator is not a track record. An agent that
              has never run says so rather than showing 0%. */}
          <span>
            {agent.stepCount === 0
              ? 'no runs yet'
              : `${agent.okCount}/${agent.stepCount} steps ok`}
          </span>
        </div>

        <div className="metaline" style={{ marginTop: 8, gap: 6 }}>
          {!agent.active && <Chip tone="muted">withdrawn</Chip>}
          {bonded !== null && <Chip tone={bonded.tone}>{bonded.text}</Chip>}
          {conformant && (
            <Chip tone="info" title="Passed the §6.4 adapter conformance suite when it was published">
              conformant
            </Chip>
          )}
          <Chip tone={probe.tone} title="An observation by the indexer, not a fact you can verify">
            {probe.text}
          </Chip>
        </div>
      </div>

      <div className="price">
        {og(agent.pricePerCall)}
        <span className="unit">per call</span>
      </div>
    </a>
  );
}

export function AgentsPage() {
  const [filter, setFilter] = useState<Filter>('all');
  const { data, error, loading } = useAsync(
    () => api<{ agents: AgentListing[]; registry: string | null }>('/api/agents?limit=100&active=all'),
    [],
  );

  const agents = useMemo(() => data?.agents ?? [], [data]);

  const counts = useMemo(
    () => ({
      all: agents.length,
      proven: agents.filter((a) => a.stepCount > 0).length,
      bonded: agents.filter((a) => a.bond !== null && BigInt(a.bond.amount) > 0n).length,
      live: agents.filter((a) => a.health?.ok === true).length,
      withdrawn: agents.filter((a) => !a.active).length,
    }),
    [agents],
  );

  const shown = useMemo(() => {
    switch (filter) {
      case 'proven':
        return agents.filter((a) => a.stepCount > 0);
      case 'bonded':
        return agents.filter((a) => a.bond !== null && BigInt(a.bond.amount) > 0n);
      case 'live':
        return agents.filter((a) => a.health?.ok === true);
      case 'withdrawn':
        return agents.filter((a) => !a.active);
      default:
        return agents;
    }
  }, [agents, filter]);

  const totalBonded = agents.reduce(
    (sum, a) => sum + (a.bond === null ? 0n : BigInt(a.bond.amount)),
    0n,
  );
  const slashed = agents.filter((a) => a.bond?.slashed === true).length;

  return (
    <>
      <header className="hero enter">
        <h1>
          Hire an agent that can <span className="quiet">prove it did the work.</span>
        </h1>
        <p className="lede">
          Every agent below published itself to the registry on 0G. Its price, its signing key and
          its record are on chain — this page only reads them. Anyone can list one with{' '}
          <code>npx @0gflow/publish</code>.
        </p>

        <StatRow>
          <Stat label="Agents listed" value={count(counts.all)} />
          <Stat label="With a record" value={count(counts.proven)} note="have run at least one step" />
          <Stat
            label="Total bonded"
            value={og(totalBonded)}
            accent={totalBonded > 0n}
            note="at stake against equivocation"
          />
          <Stat
            label="Slashed"
            value={count(slashed)}
            note={slashed > 0 ? 'caught signing two answers' : 'none caught equivocating'}
          />
        </StatRow>
      </header>

      <div className="toolbar enter" style={{ animationDelay: '60ms' }}>
        <Pills
          options={FILTERS.map((f) => ({ ...f, count: counts[f.id] }))}
          value={filter}
          onChange={setFilter}
        />
        <span className="spacer" />
        {data?.registry != null && (
          <span className="label">registry {short(data.registry, 8)}</span>
        )}
      </div>

      {loading && <Loading rows={4} />}
      {error !== null && <ErrorNote what="the agent directory" error={error} />}

      {!loading && error === null && (
        <>
          {shown.length === 0 ? (
            <Empty>
              {agents.length === 0
                ? 'No agents have been published to this registry yet.'
                : 'No agents match that filter.'}
            </Empty>
          ) : (
            <div className="grid two enter" style={{ animationDelay: '110ms' }}>
              {shown.map((agent) => (
                <AgentCard key={agent.agentId} agent={agent} />
              ))}
            </div>
          )}

          <Section title="Publish your own">
            <div className="panel">
              <p className="muted">
                Publishing mints an ERC-8004 identity, stores your JSON Schema on 0G Storage, and
                lists the agent — but only after it passes the adapter conformance suite. An agent
                that mishandles the contract is refused, because a flow that hires one produces
                receipts nobody can verify.
              </p>
              <p style={{ margin: '0 0 16px' }}>
                <a className="pill primary" href="#/publish">
                  Publish from your wallet
                </a>
              </p>
              <p className="dim" style={{ margin: '0 0 10px' }}>
                Or from a terminal, with a key you already hold:
              </p>
              <Command>{`ZG_PRIVATE_KEY=0x… npx @0gflow/publish --endpoint https://your-agent.example --signer 0xYourSigningKey --price 1000000000000000`}</Command>
            </div>
          </Section>
        </>
      )}
    </>
  );
}
