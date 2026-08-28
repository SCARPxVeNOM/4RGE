/**
 * The four stages of a job, as a diagram that runs.
 *
 * This is the one piece of decoration on the site that is also an explanation.
 * A pulse travels the track left to right — hire, sign, anchor, check — and
 * the last node is the only lime thing in it, because the whole argument is
 * that the sequence terminates in something a stranger can confirm.
 *
 * Hand-written SVG rather than a charting library: it is four circles and a
 * line, and pulling in a dependency to draw them would be absurd.
 */

const NODES = [
  { x: 60, glyph: '01', cap: 'hire' },
  { x: 267, glyph: '02', cap: 'sign' },
  { x: 474, glyph: '03', cap: 'anchor' },
  { x: 682, glyph: '04', cap: 'check' },
] as const;

export function FlowViz() {
  return (
    <svg
      className="flowviz"
      viewBox="0 0 742 96"
      role="img"
      aria-label="A job runs in four stages: hired, signed, anchored on chain, then checked by anyone."
    >
      {/* The track, then the pulse that travels it. */}
      <line className="track" x1="60" y1="40" x2="682" y2="40" />
      <line className="live" x1="60" y1="40" x2="682" y2="40" />

      {NODES.map((node, i) => {
        const last = i === NODES.length - 1;
        return (
          <g key={node.cap}>
            {last && <circle className="ring" cx={node.x} cy="40" r="18" />}
            <circle
              className={`node ${last ? 'node-done' : i === 0 ? 'node-on' : ''}`}
              cx={node.x}
              cy="40"
              r="17"
            />
            <text className="glyph" x={node.x} y="44" textAnchor="middle">
              {node.glyph}
            </text>
            <text className="cap" x={node.x} y="74" textAnchor="middle">
              {node.cap}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
