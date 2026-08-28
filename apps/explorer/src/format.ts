/**
 * Presentation helpers.
 *
 * Everything here is display-only and must never feed a comparison. A wei
 * amount rendered as `0.001 OG` has lost precision on purpose; deciding
 * anything on that number instead of the bigint it came from is how a
 * marketplace pays the wrong amount.
 */

/** Middle-truncates a hash for display, keeping both ends recognisable. */
export const short = (hex: string, keep = 6): string =>
  hex.length <= keep + 6 ? hex : `${hex.slice(0, keep + 2)}…${hex.slice(-4)}`;

/**
 * Wei as OG, for reading.
 *
 * `free` rather than `0 OG`: a listing at zero is an agent that does not
 * charge, which is a different statement from one that costs nothing to run.
 */
export function og(wei: string | bigint): string {
  const value = Number(wei) / 1e18;
  if (value === 0) return 'free';
  if (value < 0.000001) return '<0.000001 OG';
  return `${value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')} OG`;
}

/** A count with a thin space every three digits, so 11178 reads at a glance. */
export const count = (n: number | string): string =>
  Number(n).toLocaleString('en-US').replace(/,/g, ' ');

/** How long ago, from a unix-ms timestamp. */
export function ago(msSinceEpoch: number | string): string {
  const delta = Date.now() - Number(msSinceEpoch);
  if (delta < 0 || Number.isNaN(delta)) return 'just now';
  const s = Math.round(delta / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Seconds-since-epoch variant, for the on-chain timestamps in receipts. */
export const agoSeconds = (seconds: number | string): string => ago(Number(seconds) * 1000);

/**
 * A rate as a percentage, or an em dash.
 *
 * Null means "no rate exists", never zero. An agent that has never run has no
 * success rate, and showing 0% would be a claim nobody made.
 */
export const pct = (rate: number | null): string =>
  rate === null ? '—' : `${(rate * 100).toFixed(rate === 1 || rate === 0 ? 0 : 1)}%`;

export const KIND_NAMES = ['http', 'contract', '0g-compute', 'flow'] as const;

export const kindName = (kind: number): string => KIND_NAMES[kind] ?? `kind ${kind}`;

/**
 * A deterministic swatch for an agent, derived from its token id.
 *
 * Agents in this directory have no avatars — nobody uploads one, and fetching
 * an image named by a stranger's listing would let any publisher point the
 * explorer at an arbitrary URL. A generated mark is recognisable, costs
 * nothing, and cannot be used to phone home.
 */
export function agentColors(agentId: string): { from: string; to: string } {
  let hash = 0;
  for (const ch of agentId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  return {
    from: `hsl(${hue} 70% 52%)`,
    to: `hsl(${(hue + 48) % 360} 70% 38%)`,
  };
}
