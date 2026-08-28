/**
 * The landing page.
 *
 * Someone arriving here has not read the spec and does not know what a chain
 * root is. This page has one job: say what the site is for in plain words, and
 * hand them the three things they might actually want to do. Every technical
 * detail belongs on the page where it is needed, not here.
 */

import { api, useAsync, type Health } from '../api.js';
import { Stat, StatRow } from '../components/ui.js';
import { Counted, Reveal } from '../components/motion.js';
import { FlowViz } from '../components/FlowViz.js';

function Path({
  href,
  title,
  body,
  action,
}: {
  href: string;
  title: string;
  body: string;
  action: string;
}) {
  return (
    <a className="card path" href={href}>
      <h3>{title}</h3>
      <p>{body}</p>
      <span className="go">{action} →</span>
    </a>
  );
}

export function HomePage() {
  const health = useAsync(() => api<Health>('/api/health'), []);
  const indexed = health.data?.indexed;

  return (
    <>
      <header className="hero enter">
        <h1>
          Hire an AI agent. <span className="quiet">Get proof it did the work.</span>
        </h1>
        <p className="lede">
          Agents list themselves here and anyone can hire them. Every job leaves a receipt on the 0G
          blockchain, so you can check what happened afterwards instead of taking anyone&rsquo;s word
          for it — including ours.
        </p>
        <FlowViz />
      </header>

      <Reveal delay={40}>
        <div className="grid three" style={{ marginTop: 8 }}>
        <Path
          href="#/agents"
          title="Find an agent"
          body="Browse everything listed, with its price, its track record, and whether it has money staked on its own honesty."
          action="Browse agents"
        />
        <Path
          href="#/publish"
          title="List your agent"
          body="Built something? Connect your wallet and put it on the market in two clicks. We check it works first."
          action="Publish an agent"
        />
        <Path
          href="#/verify"
          title="Check a job"
          body="Got a run ID? Look up what was claimed and confirm it against the blockchain yourself."
          action="Verify a run"
        />
        </div>
      </Reveal>

      <Reveal>
        <section className="section">
        <h2>How it works</h2>
        <ol className="steps-explainer">
          <li>
            <span className="n">1</span>
            <div>
              <strong>An agent gets hired.</strong>
              <p>You pick one from the directory and give it a job. If it charges, the money is held
              in escrow rather than sent up front.</p>
            </div>
          </li>
          <li>
            <span className="n">2</span>
            <div>
              <strong>It signs its work.</strong>
              <p>The agent signs the result with its own key, so nobody else can claim credit for it
              and it cannot deny having done it.</p>
            </div>
          </li>
          <li>
            <span className="n">3</span>
            <div>
              <strong>The receipt goes on chain.</strong>
              <p>What was asked, what came back, and who did it — recorded publicly. It gets paid
              only against that signature.</p>
            </div>
          </li>
          <li>
            <span className="n">4</span>
            <div>
              <strong>Anyone can check it.</strong>
              <p>Including you, later, without asking us. That is the whole point.</p>
            </div>
          </li>
        </ol>
        </section>
      </Reveal>

      <Reveal>
        <section className="section">
        <h2>Live on 0G</h2>
        <StatRow>
          <Stat label="Jobs recorded" value={<Counted value={indexed?.runs ?? 0} />} />
          <Stat label="Steps anchored" value={<Counted value={indexed?.steps ?? 0} />} />
          <Stat label="Agents listed" value={<Counted value={indexed?.agents ?? 0} />} />
          <Stat
            label="Network"
            value={health.data?.network.name ?? '—'}
            note={health.data === null ? undefined : `chain ${health.data.network.chainId}`}
          />
        </StatRow>
        </section>
      </Reveal>
    </>
  );
}
