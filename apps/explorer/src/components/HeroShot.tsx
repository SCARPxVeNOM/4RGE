/**
 * The landing hero's photographic backdrop.
 *
 * The picture is decoration, so it must never delay the words. What renders
 * first is a 92-byte blurred copy inlined in the stylesheet; the real file is
 * decoded off the main thread and faded in once it is actually ready. If it
 * never arrives — slow connection, blocked request — the blur stays and the
 * hero still reads, because the scrim above it does not depend on the image.
 *
 * `aria-hidden`, because there is nothing here for a screen reader: everything
 * the picture conveys is said in the headline in front of it.
 */

import { useEffect, useRef } from 'react';
import heroWebp from '../assets/hero.webp';
import heroJpg from '../assets/hero.jpg';

export function HeroShot() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (node === null) return;

    // `decode()` keeps the paint off the main thread, so the fade cannot land
    // in the middle of a frame the browser is already busy with.
    const image = new Image();
    let live = true;
    image.src = supportsWebp() ? heroWebp : heroJpg;
    void image
      .decode()
      .catch(() => {})
      .then(() => {
        if (live) node.classList.add('ready');
      });

    return () => {
      live = false;
    };
  }, []);

  return (
    <>
      <div className="shot" ref={ref} aria-hidden="true" />
      <div className="scrim" aria-hidden="true" />
    </>
  );
}

/**
 * Whether to preload the WebP or the JPEG.
 *
 * The stylesheet picks between them with `image-set`, and this only decides
 * which one to warm the cache with. Getting it wrong costs a duplicate
 * download, so it is worth asking rather than assuming — every browser that
 * supports `image-set` type() also supports WebP, but the two can be disabled
 * independently in hardened builds.
 */
function supportsWebp(): boolean {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  return canvas.toDataURL('image/webp').startsWith('data:image/webp');
}
