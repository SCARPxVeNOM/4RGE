/**
 * The two bits of motion that need to know something the CSS cannot.
 *
 * Everything else on this site animates in the stylesheet, which is where
 * animation belongs. These two need state: one needs to know when an element
 * has been scrolled to, the other needs to know the number it is counting
 * towards. Both check `prefers-reduced-motion` and do nothing if it is set —
 * not a reduced version, nothing, with the final state rendered immediately.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Fades a block in the first time it is scrolled into view.
 *
 * Once only. A section that re-animates every time it scrolls past turns
 * reading the page into a light show, and the reader is here to read numbers.
 */
export function Reveal({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (node === null) return;
    if (prefersReducedMotion()) {
      node.classList.add('shown');
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('shown');
          observer.unobserve(entry.target);
        }
      },
      // A little before it reaches the viewport, so it has finished arriving
      // by the time it is actually being looked at.
      { rootMargin: '0px 0px -12% 0px', threshold: 0.05 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} data-reveal="" style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

/**
 * A number that counts up to its value.
 *
 * Eased rather than linear, and short: 900ms. The figure is the content, so
 * the animation has to be over well before anyone has finished reading the
 * label beside it.
 *
 * It renders the final value on the first frame when motion is reduced, and
 * whenever the value is small enough that counting would be silly.
 */
export function Counted({ value }: { value: number }) {
  const [shown, setShown] = useState(() =>
    prefersReducedMotion() || value <= 3 ? value : 0,
  );

  useEffect(() => {
    if (prefersReducedMotion() || value <= 3) {
      setShown(value);
      return;
    }

    let frame = 0;
    const start = performance.now();
    const DURATION = 900;

    const tick = (now: number) => {
      const t = Math.min((now - start) / DURATION, 1);
      // easeOutExpo: fast enough to feel instant, with a settle at the end.
      const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
      setShown(Math.round(value * eased));
      if (t < 1) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);

  return <>{shown.toLocaleString('en-GB').replace(/,/g, ' ')}</>;
}
