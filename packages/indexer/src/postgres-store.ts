/**
 * Postgres 16 Store — spec §3.1, §8.1.
 *
 * Held to the same test suite as MemoryStore, so a behavioural difference
 * between the two shows up as a failing test rather than as a production-only
 * surprise.
 *
 * Every insert is an upsert keyed on the natural identity of the row
 * ((run_id, step_index), run_id, flow_id). Re-scanning a range is normal —
 * after a restart, or after a reorg rewind — and duplicate rows would inflate
 * step counts and make a run appear not to fold.
 *
 * bigints are stored as NUMERIC rather than BIGINT: block numbers and uint64
 * timestamps are fine, but agent ids are uint256 token ids and would overflow.
 */

import pg from 'pg';
import { StepStatus, ZERO_BYTES32, type Hex } from '@0gflow/core';
import type {
  AgentHealthRow,
  AgentListingFilter,
  AgentListingRow,
  AgentRow,
  FlowRow,
  RunRow,
  SealInput,
  StepRow,
  Store,
} from './store.js';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS indexer_state (
  id            INT PRIMARY KEY DEFAULT 1,
  cursor_block  NUMERIC NOT NULL DEFAULT 0,
  CONSTRAINT indexer_state_singleton CHECK (id = 1)
);
INSERT INTO indexer_state (id, cursor_block) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

-- Block hashes we indexed, so a reorg can be detected and undone.
CREATE TABLE IF NOT EXISTS blocks (
  block_number NUMERIC PRIMARY KEY,
  block_hash   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS steps (
  run_id          TEXT    NOT NULL,
  step_index      INT     NOT NULL,
  flow_id         TEXT    NOT NULL,
  agent_id        NUMERIC NOT NULL,
  input_hash      TEXT    NOT NULL,
  output_hash     TEXT    NOT NULL,
  trace_root      TEXT    NOT NULL,
  attestation_ref TEXT    NOT NULL,
  started_at      NUMERIC NOT NULL,
  ended_at        NUMERIC NOT NULL,
  status          SMALLINT NOT NULL,
  tx_hash         TEXT    NOT NULL,
  block_number    NUMERIC NOT NULL,
  block_hash      TEXT    NOT NULL,
  log_index       INT     NOT NULL,
  PRIMARY KEY (run_id, step_index)
);
CREATE INDEX IF NOT EXISTS steps_block   ON steps (block_number);
CREATE INDEX IF NOT EXISTS steps_agent   ON steps (agent_id);
CREATE INDEX IF NOT EXISTS steps_flow    ON steps (flow_id);

CREATE TABLE IF NOT EXISTS seals (
  run_id       TEXT PRIMARY KEY,
  chain_root   TEXT    NOT NULL,
  step_count   INT     NOT NULL,
  outcome      SMALLINT NOT NULL,
  tx_hash      TEXT    NOT NULL,
  block_number NUMERIC NOT NULL,
  block_hash   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS seals_block ON seals (block_number);

CREATE TABLE IF NOT EXISTS flows (
  flow_id      TEXT PRIMARY KEY,
  name         TEXT    NOT NULL,
  owner        TEXT    NOT NULL,
  spec_root    TEXT    NOT NULL,
  published_at NUMERIC NOT NULL,
  block_number NUMERIC NOT NULL,
  block_hash   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS flows_block ON flows (block_number);

-- Marketplace listings, as published in AgentAdapterRegistryV2.
--
-- Deliberately separate from the derived per-agent statistics: a freshly
-- published agent has a listing and no statistics at all, and merging the two
-- would make it invisible until someone had already hired it.
--
-- agent_id is NUMERIC, not BIGINT. Token ids are uint256 and a BIGINT would
-- silently overflow on any id above 2^63, which is a perfectly ordinary token
-- id for a registry that hashes something into it.
CREATE TABLE IF NOT EXISTS agent_listings (
  agent_id       NUMERIC PRIMARY KEY,
  owner          TEXT     NOT NULL,
  kind           SMALLINT NOT NULL,
  endpoint       TEXT     NOT NULL,
  schema_root    TEXT     NOT NULL,
  version        BIGINT   NOT NULL,
  active         BOOLEAN  NOT NULL,
  pay_to         TEXT     NOT NULL,
  signer         TEXT     NOT NULL,
  price_per_call NUMERIC  NOT NULL,
  metadata_uri   TEXT     NOT NULL,
  block_number   NUMERIC  NOT NULL,
  block_hash     TEXT     NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_listings_block  ON agent_listings (block_number);
CREATE INDEX IF NOT EXISTS agent_listings_active ON agent_listings (active);

-- What a prober observed when it last called a listed agent.
--
-- Deliberately NOT rolled back on a reorg, unlike every other table here.
-- Those rows describe a chain that no longer exists; this one describes
-- whether an HTTP endpoint answered, which no chain reorganisation changes.
CREATE TABLE IF NOT EXISTS agent_health (
  agent_id             NUMERIC PRIMARY KEY,
  checked_at           NUMERIC NOT NULL,
  ok                   BOOLEAN NOT NULL,
  latency_ms           INT,
  consecutive_failures INT     NOT NULL,
  last_error           TEXT
);
`;

/** Aggregates a run from its steps and seal, mirroring MemoryStore exactly. */
const RUN_SELECT = `
SELECT
  r.run_id,
  COALESCE(MAX(s.flow_id), '${ZERO_BYTES32}')          AS flow_id,
  COUNT(s.step_index)::INT                              AS step_count,
  BOOL_OR(sl.run_id IS NOT NULL)                        AS sealed,
  MAX(sl.chain_root)                                    AS chain_root,
  MAX(sl.outcome)::INT                                  AS outcome,
  MIN(LEAST(s.block_number, COALESCE(sl.block_number, s.block_number))) AS first_block,
  MAX(GREATEST(COALESCE(s.block_number, 0), COALESCE(sl.block_number, 0))) AS last_block
FROM (
  SELECT run_id FROM steps
  UNION
  SELECT run_id FROM seals
) r
LEFT JOIN steps s  ON s.run_id  = r.run_id
LEFT JOIN seals sl ON sl.run_id = r.run_id
GROUP BY r.run_id
`;

export class PostgresStore implements Store {
  private readonly pool: pg.Pool;

  /**
   * @param schema Postgres schema to use. Defaults to `public`. Tests pass a
   * dedicated schema so a suite pointed at a real database cannot overwrite
   * indexed data — which is exactly what happened once, leaving a fake receipt
   * and a cursor below the deployment block behind.
   */
  constructor(
    private readonly connectionString: string,
    private readonly schema = 'public',
  ) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
      throw new Error(`unsafe schema name: ${schema}`);
    }
    // search_path is set as a connection option rather than by querying each
    // new client: doing it in an 'connect' handler races with whatever query
    // opened the connection, which pg warns about and will reject in pg@9.
    this.pool = new pg.Pool({
      connectionString,
      max: 4,
      options: `-c search_path=${schema}`,
    });
  }

  async migrate(): Promise<void> {
    // The schema has to exist before search_path can resolve to it, and a
    // pooled connection may already be pinned to a missing one.
    const bootstrap = new pg.Client({ connectionString: this.connectionString });
    await bootstrap.connect();
    try {
      await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
    } finally {
      await bootstrap.end();
    }
    await this.pool.query(SCHEMA);
  }

  /** Drops the schema entirely. Intended for test teardown. */
  async dropSchema(): Promise<void> {
    await this.pool.query(`DROP SCHEMA IF EXISTS ${this.schema} CASCADE`);
  }

  async getCursor(): Promise<bigint> {
    const { rows } = await this.pool.query<{ cursor_block: string }>(
      'SELECT cursor_block FROM indexer_state WHERE id = 1',
    );
    return BigInt(rows[0]?.cursor_block ?? '0');
  }

  async setCursor(block: bigint): Promise<void> {
    await this.pool.query('UPDATE indexer_state SET cursor_block = $1 WHERE id = 1', [
      block.toString(),
    ]);
  }

  async getIndexedBlockHash(blockNumber: bigint): Promise<string | null> {
    const { rows } = await this.pool.query<{ block_hash: string }>(
      'SELECT block_hash FROM blocks WHERE block_number = $1',
      [blockNumber.toString()],
    );
    return rows[0]?.block_hash ?? null;
  }

  async recordBlock(blockNumber: bigint, blockHash: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO blocks (block_number, block_hash) VALUES ($1, $2)
       ON CONFLICT (block_number) DO UPDATE SET block_hash = EXCLUDED.block_hash`,
      [blockNumber.toString(), blockHash],
    );
  }

  async rollbackFrom(blockNumber: bigint): Promise<void> {
    const b = blockNumber.toString();
    const client = await this.pool.connect();
    try {
      // One transaction: a partial rollback would leave rows describing a
      // chain that no longer exists.
      await client.query('BEGIN');
      await client.query('DELETE FROM steps  WHERE block_number >= $1', [b]);
      await client.query('DELETE FROM seals  WHERE block_number >= $1', [b]);
      await client.query('DELETE FROM flows  WHERE block_number >= $1', [b]);
      await client.query('DELETE FROM agent_listings WHERE block_number >= $1', [b]);
      await client.query('DELETE FROM blocks WHERE block_number >= $1', [b]);
      await client.query(
        'UPDATE indexer_state SET cursor_block = GREATEST($1::NUMERIC - 1, 0) WHERE id = 1 AND cursor_block >= $1',
        [b],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async upsertStep(s: StepRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO steps (run_id, step_index, flow_id, agent_id, input_hash, output_hash,
                          trace_root, attestation_ref, started_at, ended_at, status,
                          tx_hash, block_number, block_hash, log_index)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (run_id, step_index) DO UPDATE SET
         flow_id = EXCLUDED.flow_id, agent_id = EXCLUDED.agent_id,
         input_hash = EXCLUDED.input_hash, output_hash = EXCLUDED.output_hash,
         trace_root = EXCLUDED.trace_root, attestation_ref = EXCLUDED.attestation_ref,
         started_at = EXCLUDED.started_at, ended_at = EXCLUDED.ended_at,
         status = EXCLUDED.status, tx_hash = EXCLUDED.tx_hash,
         block_number = EXCLUDED.block_number, block_hash = EXCLUDED.block_hash,
         log_index = EXCLUDED.log_index`,
      [
        s.runId.toLowerCase(), s.stepIndex, s.flowId.toLowerCase(), s.agentId.toString(),
        s.inputHash, s.outputHash, s.traceRoot, s.attestationRef,
        s.startedAt.toString(), s.endedAt.toString(), s.status,
        s.txHash, s.blockNumber.toString(), s.blockHash, s.logIndex,
      ],
    );
  }

  async upsertSeal(seal: SealInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO seals (run_id, chain_root, step_count, outcome, tx_hash, block_number, block_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (run_id) DO UPDATE SET
         chain_root = EXCLUDED.chain_root, step_count = EXCLUDED.step_count,
         outcome = EXCLUDED.outcome, tx_hash = EXCLUDED.tx_hash,
         block_number = EXCLUDED.block_number, block_hash = EXCLUDED.block_hash`,
      [
        seal.runId.toLowerCase(), seal.chainRoot, seal.stepCount, seal.outcome,
        seal.txHash, seal.blockNumber.toString(), seal.blockHash,
      ],
    );
  }

  async upsertFlow(f: FlowRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO flows (flow_id, name, owner, spec_root, published_at, block_number, block_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (flow_id) DO UPDATE SET
         name = EXCLUDED.name, owner = EXCLUDED.owner, spec_root = EXCLUDED.spec_root,
         published_at = EXCLUDED.published_at, block_number = EXCLUDED.block_number,
         block_hash = EXCLUDED.block_hash`,
      [
        f.flowId.toLowerCase(), f.name, f.owner, f.specRoot,
        f.publishedAt.toString(), f.blockNumber.toString(), f.blockHash,
      ],
    );
  }

  async upsertAgentListing(a: AgentListingRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_listings
         (agent_id, owner, kind, endpoint, schema_root, version, active,
          pay_to, signer, price_per_call, metadata_uri, block_number, block_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (agent_id) DO UPDATE SET
         owner = EXCLUDED.owner, kind = EXCLUDED.kind, endpoint = EXCLUDED.endpoint,
         schema_root = EXCLUDED.schema_root, version = EXCLUDED.version,
         active = EXCLUDED.active, pay_to = EXCLUDED.pay_to, signer = EXCLUDED.signer,
         price_per_call = EXCLUDED.price_per_call, metadata_uri = EXCLUDED.metadata_uri,
         block_number = EXCLUDED.block_number, block_hash = EXCLUDED.block_hash
       -- Versions only move forward in the registry, so a lower one means a
       -- log arrived out of order. Taking it would point the directory at an
       -- endpoint the agent has already left. Mirrors MemoryStore exactly.
       WHERE agent_listings.version <= EXCLUDED.version`,
      [
        a.agentId.toString(), a.owner.toLowerCase(), a.kind, a.endpoint,
        a.schemaRoot.toLowerCase(), a.version, a.active, a.payTo.toLowerCase(),
        a.signer.toLowerCase(), a.pricePerCall.toString(), a.metadataURI,
        a.blockNumber.toString(), a.blockHash,
      ],
    );
  }

  async deactivateAgentListing(agentId: bigint, blockNumber: bigint): Promise<void> {
    // No-op for an agent never seen, exactly as in MemoryStore: the indexer
    // may be scanning a window that starts after the registration.
    await this.pool.query(
      'UPDATE agent_listings SET active = FALSE, block_number = $2 WHERE agent_id = $1',
      [agentId.toString(), blockNumber.toString()],
    );
  }

  async recordAgentHealth(
    agentId: bigint,
    result: { ok: boolean; latencyMs: number | null; error: string | null; checkedAt: bigint },
  ): Promise<void> {
    // The streak is carried forward in SQL rather than read-then-written, so
    // two probers racing cannot both read zero and both write one.
    await this.pool.query(
      `INSERT INTO agent_health
         (agent_id, checked_at, ok, latency_ms, consecutive_failures, last_error)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (agent_id) DO UPDATE SET
         checked_at = EXCLUDED.checked_at,
         ok = EXCLUDED.ok,
         latency_ms = EXCLUDED.latency_ms,
         consecutive_failures = CASE
           WHEN EXCLUDED.ok THEN 0
           ELSE agent_health.consecutive_failures + 1
         END,
         last_error = EXCLUDED.last_error`,
      [
        agentId.toString(),
        result.checkedAt.toString(),
        result.ok,
        result.latencyMs,
        result.ok ? 0 : 1,
        result.error,
      ],
    );
  }

  async getAgentHealth(agentId: bigint): Promise<AgentHealthRow | null> {
    const { rows } = await this.pool.query('SELECT * FROM agent_health WHERE agent_id = $1', [
      agentId.toString(),
    ]);
    const row = rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return {
      agentId: BigInt(String(row['agent_id'])),
      checkedAt: BigInt(String(row['checked_at'])),
      ok: Boolean(row['ok']),
      latencyMs: row['latency_ms'] === null ? null : Number(row['latency_ms']),
      consecutiveFailures: Number(row['consecutive_failures']),
      lastError: row['last_error'] === null ? null : String(row['last_error']),
    };
  }

  async getAgentListing(agentId: bigint): Promise<AgentListingRow | null> {
    const { rows } = await this.pool.query('SELECT * FROM agent_listings WHERE agent_id = $1', [
      agentId.toString(),
    ]);
    return rows[0] === undefined ? null : PostgresStore.toListing(rows[0] as Record<string, unknown>);
  }

  async listAgentListings(
    limit: number,
    offset: number,
    filter?: AgentListingFilter,
  ): Promise<AgentListingRow[]> {
    const where: string[] = [];
    const params: unknown[] = [limit, offset];
    if (filter?.activeOnly === true) where.push('active = TRUE');
    if (filter?.kind !== undefined) {
      params.push(filter.kind);
      where.push(`kind = $${params.length}`);
    }

    const { rows } = await this.pool.query(
      `SELECT * FROM agent_listings
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY block_number DESC, agent_id DESC
       LIMIT $1 OFFSET $2`,
      params,
    );
    return rows.map((r) => PostgresStore.toListing(r as Record<string, unknown>));
  }

  private static toListing(row: Record<string, unknown>): AgentListingRow {
    return {
      agentId: BigInt(String(row['agent_id'])),
      owner: row['owner'] as Hex,
      kind: Number(row['kind']),
      endpoint: String(row['endpoint']),
      schemaRoot: row['schema_root'] as Hex,
      version: Number(row['version']),
      active: Boolean(row['active']),
      payTo: row['pay_to'] as Hex,
      signer: row['signer'] as Hex,
      pricePerCall: BigInt(String(row['price_per_call'])),
      metadataURI: String(row['metadata_uri']),
      blockNumber: BigInt(String(row['block_number'])),
      blockHash: String(row['block_hash']),
    };
  }

  private static toRun(row: Record<string, unknown>): RunRow {
    return {
      runId: row['run_id'] as Hex,
      flowId: row['flow_id'] as Hex,
      stepCount: Number(row['step_count']),
      sealed: row['sealed'] === true,
      chainRoot: (row['chain_root'] as Hex | null) ?? null,
      outcome: row['outcome'] === null ? null : Number(row['outcome']),
      firstBlock: BigInt(String(row['first_block'] ?? '0')),
      lastBlock: BigInt(String(row['last_block'] ?? '0')),
    };
  }

  private static toStep(row: Record<string, unknown>): StepRow {
    return {
      runId: row['run_id'] as Hex,
      flowId: row['flow_id'] as Hex,
      stepIndex: Number(row['step_index']),
      agentId: BigInt(String(row['agent_id'])),
      inputHash: row['input_hash'] as Hex,
      outputHash: row['output_hash'] as Hex,
      traceRoot: row['trace_root'] as Hex,
      attestationRef: row['attestation_ref'] as Hex,
      startedAt: BigInt(String(row['started_at'])),
      endedAt: BigInt(String(row['ended_at'])),
      status: Number(row['status']) as StepStatus,
      txHash: row['tx_hash'] as Hex,
      blockNumber: BigInt(String(row['block_number'])),
      blockHash: row['block_hash'] as string,
      logIndex: Number(row['log_index']),
    };
  }

  async getRun(runId: Hex): Promise<RunRow | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM (${RUN_SELECT}) q WHERE q.run_id = $1`,
      [runId.toLowerCase()],
    );
    return rows[0] === undefined ? null : PostgresStore.toRun(rows[0] as Record<string, unknown>);
  }

  async getSteps(runId: Hex): Promise<StepRow[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM steps WHERE run_id = $1 ORDER BY step_index',
      [runId.toLowerCase()],
    );
    return rows.map((r) => PostgresStore.toStep(r as Record<string, unknown>));
  }

  async listRuns(limit: number, offset: number): Promise<RunRow[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM (${RUN_SELECT}) q ORDER BY q.last_block DESC LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return rows.map((r) => PostgresStore.toRun(r as Record<string, unknown>));
  }

  async getFlow(flowId: Hex): Promise<FlowRow | null> {
    const { rows } = await this.pool.query('SELECT * FROM flows WHERE flow_id = $1', [
      flowId.toLowerCase(),
    ]);
    const row = rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return {
      flowId: row['flow_id'] as Hex,
      name: row['name'] as string,
      owner: row['owner'] as Hex,
      specRoot: row['spec_root'] as Hex,
      publishedAt: BigInt(String(row['published_at'])),
      blockNumber: BigInt(String(row['block_number'])),
      blockHash: row['block_hash'] as string,
    };
  }

  async listRunsForFlow(flowId: Hex, limit: number): Promise<RunRow[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM (${RUN_SELECT}) q WHERE q.flow_id = $1 ORDER BY q.last_block DESC LIMIT $2`,
      [flowId.toLowerCase(), limit],
    );
    return rows.map((r) => PostgresStore.toRun(r as Record<string, unknown>));
  }

  async getAgent(agentId: bigint): Promise<AgentRow | null> {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::INT AS step_count,
              COUNT(*) FILTER (WHERE status = 0)::INT AS ok_count,
              COUNT(*) FILTER (WHERE attestation_ref <> $2)::INT AS attested_count,
              COUNT(DISTINCT run_id)::INT AS run_count
       FROM steps WHERE agent_id = $1`,
      [agentId.toString(), ZERO_BYTES32],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    if (row === undefined || Number(row['step_count']) === 0) return null;
    return {
      agentId,
      stepCount: Number(row['step_count']),
      okCount: Number(row['ok_count']),
      attestedCount: Number(row['attested_count']),
      runCount: Number(row['run_count']),
    };
  }

  async listRunsForAgent(agentId: bigint, limit: number): Promise<RunRow[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM (${RUN_SELECT}) q
       WHERE q.run_id IN (SELECT run_id FROM steps WHERE agent_id = $1)
       ORDER BY q.last_block DESC LIMIT $2`,
      [agentId.toString(), limit],
    );
    return rows.map((r) => PostgresStore.toRun(r as Record<string, unknown>));
  }

  async stats() {
    const { rows } = await this.pool.query(
      `SELECT (SELECT COUNT(*) FROM (SELECT run_id FROM steps UNION SELECT run_id FROM seals) r)::INT AS runs,
              (SELECT COUNT(*) FROM steps)::INT AS steps,
              (SELECT COUNT(*) FROM flows)::INT AS flows,
              (SELECT COUNT(DISTINCT agent_id) FROM steps)::INT AS agents`,
    );
    const row = rows[0] as Record<string, unknown>;
    return {
      runs: Number(row['runs']),
      steps: Number(row['steps']),
      flows: Number(row['flows']),
      agents: Number(row['agents']),
      cursor: await this.getCursor(),
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
