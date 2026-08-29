/**
 * The photographic backdrop behind a page's headline.
 *
 * The picture is decoration, so it must never delay the words. What renders
 * first is a ~100-byte blurred copy inlined in the markup; the real file is
 * decoded off the main thread and faded in once it is genuinely ready. If it
 * never arrives — slow connection, blocked request — the blur stays and the
 * heading still reads, because the scrim above it does not depend on the image.
 *
 * The URLs are passed to CSS as custom properties rather than selected by a
 * per-page stylesheet rule. Vite hashes these filenames at build time, so the
 * final URL is only knowable from the import — hardcoding `hero-verify.webp`
 * in the CSS would break the moment the file changed.
 *
 * `aria-hidden`, because there is nothing here for a screen reader: everything
 * the picture conveys is said in the headline in front of it.
 */

import { useEffect, useRef } from 'react';

import homeWebp from '../assets/hero.webp';
import homeJpg from '../assets/hero.jpg';
import agentsWebp from '../assets/hero-agents.webp';
import agentsJpg from '../assets/hero-agents.jpg';
import jobsWebp from '../assets/hero-jobs.webp';
import jobsJpg from '../assets/hero-jobs.jpg';
import verifyWebp from '../assets/hero-verify.webp';
import verifyJpg from '../assets/hero-verify.jpg';
import publishWebp from '../assets/hero-publish.webp';
import publishJpg from '../assets/hero-publish.jpg';

export type ShotName = 'home' | 'agents' | 'jobs' | 'verify' | 'publish';

interface Shot {
  readonly webp: string;
  readonly jpg: string;
  /** A 24px blurred copy, inlined. Costs no request. */
  readonly tiny: string;
  /**
   * Where to anchor the crop.
   *
   * Not decorative. Several of these photographs have a bright whiteboard or
   * lit poster on the left, which is exactly where the headline sits — pushing
   * the crop right moves that brightness off the text and leaves the dark part
   * of the room underneath it.
   */
  readonly focus: string;
}

const SHOTS: Record<ShotName, Shot> = {
  home: {
    webp: homeWebp,
    jpg: homeJpg,
    tiny: 'data:image/webp;base64,UklGRlQAAABXRUJQVlA4IEgAAACwAwCdASoYAA4APu1iqk2ppaQiMAgBMB2JZQDMHCHe3+3WCE7wQAD+8qBl2BA0/3WFts3ZbJwtHHIRIB/excycD6srg3yAAAA=',
    focus: '62% 46%',
  },
  agents: {
    webp: agentsWebp,
    jpg: agentsJpg,
    tiny: 'data:image/webp;base64,UklGRmYAAABXRUJQVlA4IFoAAAAQBACdASoYAA4APu1mq04ppaQiMAgBMB2JZQAAXJFZs+dff7GhQrW1AAD+9CUEmfqY1tSu45ul2r2Mm6XeaQPzHRaGIE2UegVTZmvnYs3MafgPm5cEvU54AAA=',
    focus: '58% 48%',
  },
  jobs: {
    webp: jobsWebp,
    jpg: jobsJpg,
    // The ØG PROTOCOL whiteboard is bright and sits far left, under the
    // headline. Pushing the crop right moves it past the edge.
    tiny: 'data:image/webp;base64,UklGRlQAAABXRUJQVlA4IEgAAABQAwCdASoYAA4APu1kq04ppaQiMAgBMB2JZwAAW5Bj1p+eAAD+8QxqAGjC7ZpWKsDX3ehwBHhdnR3ITYt/kUe+m1ZpavQAAAA=',
    focus: '76% 46%',
  },
  verify: {
    webp: verifyWebp,
    jpg: verifyJpg,
    tiny: 'data:image/webp;base64,UklGRlgAAABXRUJQVlA4IEwAAACwAwCdASoYAA4APu1iqU2ppaQiMAgBMB2JaQAAXBusIQj8G85cAAD+8QqI7FEyWDLnJgv9UfNMZ6BaFzutiSjfnqiHknyKpFXyjAAA',
    focus: '78% 46%',
  },
  publish: {
    webp: publishWebp,
    jpg: publishJpg,
    tiny: 'data:image/webp;base64,UklGRmIAAABXRUJQVlA4IFYAAACwAwCdASoYAA4APu1iqU2ppaOiMAgBMB2JaQAAXK+GKeepTwuwAAD+8yKrqo1GPt/q15QLUdXDYb3A0qsv1AG5zZqo1nKzXSAq+BJP8pOZwxBgiAAAAA==',
    focus: '60% 50%',
  },
};

export function HeroShot({ name }: { name: ShotName }) {
  const ref = useRef<HTMLDivElement>(null);
  const shot = SHOTS[name];

  useEffect(() => {
    const node = ref.current;
    if (node === null) return;
    node.classList.remove('ready');

    // `decode()` keeps the paint off the main thread, so the fade cannot land
    // in the middle of a frame the browser is already busy with.
    const image = new Image();
    let live = true;
    image.src = supportsWebp() ? shot.webp : shot.jpg;
    void image
      .decode()
      .catch(() => {})
      .then(() => {
        if (live) node.classList.add('ready');
      });

    return () => {
      live = false;
    };
  }, [shot]);

  return (
    <>
      <div
        className="shot"
        ref={ref}
        aria-hidden="true"
        style={
          {
            '--shot': `image-set(url("${shot.webp}") type("image/webp"), url("${shot.jpg}") type("image/jpeg"))`,
            '--shot-tiny': `url("${shot.tiny}")`,
            '--shot-focus': shot.focus,
          } as React.CSSProperties
        }
      />
      <div className="scrim" aria-hidden="true" />
    </>
  );
}

/**
 * Whether to preload the WebP or the JPEG.
 *
 * The stylesheet picks between them with `image-set`, and this only decides
 * which one to warm the cache with. Getting it wrong costs a duplicate
 * download, so it is worth asking rather than assuming.
 */
function supportsWebp(): boolean {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  return canvas.toDataURL('image/webp').startsWith('data:image/webp');
}
