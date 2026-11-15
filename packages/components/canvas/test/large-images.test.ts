// The decision behind very large pictures (P13b, amendment 11, AD-P13-07): when the canvas shows a smaller copy, and how big it is.
// The copy itself (createImageBitmap, an OffscreenCanvas) is checked in a real browser: test/e2e/large-image.spec.ts.
import { describe, expect, it } from 'vitest';
import { copyPlan, COPY_FACTOR, LARGE_IMAGE_SIDE } from '../src/large-images.ts';

describe('copyPlan', () => {
  it('leaves a picture of 4000 px or less on a side alone, whatever its shown width', () => {
    expect(copyPlan({ width: 4000, height: 3000 }, 300, 'a.png')).toBeNull();
    expect(copyPlan({ width: 3000, height: 4000 }, 300, 'a.png')).toBeNull();
    expect(copyPlan({ width: 1200, height: 800 }, 100, 'a.jpg')).toBeNull();
  });

  it('makes a copy at most twice the shown width for a picture over 4000 px, keeping the ratio', () => {
    const plan = copyPlan({ width: 8000, height: 6000 }, 600, 'big.png');
    expect(plan).toEqual({ width: 600 * COPY_FACTOR, height: 900, mime: 'image/webp' });
    expect(plan!.width).toBeLessThanOrEqual(2 * 600);
  });

  it('is decided by the longer side: a tall picture over 4000 px high gets a copy too', () => {
    const plan = copyPlan({ width: 3000, height: 9000 }, 400, 'tall.png');
    expect(plan).toEqual({ width: 800, height: 2400, mime: 'image/webp' });
    expect(LARGE_IMAGE_SIDE).toBe(4000);
  });

  it('keeps JPEG as JPEG and turns everything else into WebP (it keeps transparency)', () => {
    expect(copyPlan({ width: 5000, height: 4000 }, 500, 'photo.JPG')?.mime).toBe('image/jpeg');
    expect(copyPlan({ width: 5000, height: 4000 }, 500, 'photo.jpeg?v=3')?.mime).toBe('image/jpeg');
    expect(copyPlan({ width: 5000, height: 4000 }, 500, 'shot.png')?.mime).toBe('image/webp');
    expect(copyPlan({ width: 5000, height: 4000 }, 500, 'anim.gif')?.mime).toBe('image/webp');
  });

  it('never makes a copy that is not smaller than the picture, or one for a vector picture', () => {
    expect(copyPlan({ width: 4100, height: 4100 }, 3000, 'a.png')).toBeNull(); // 2 x 3000 is more than the picture has
    expect(copyPlan({ width: 9000, height: 9000 }, 500, 'drawing.svg')).toBeNull();
    expect(copyPlan({ width: 9000, height: 9000 }, 500, 'drawing.svg?v=2')).toBeNull();
    expect(copyPlan({ width: 9000, height: 9000 }, 500, 'data:image/svg+xml;base64,AAAA')).toBeNull();
  });

  it('assumes a page-wide picture when it is not laid out yet (shown width 0: the Code view), and ignores a picture with no size', () => {
    expect(copyPlan({ width: 8000, height: 4000 }, 0, 'a.png')).toEqual({ width: 1600, height: 800, mime: 'image/webp' });
    expect(copyPlan({ width: 0, height: 0 }, 300, 'a.png')).toBeNull();
    expect(copyPlan({ width: Number.NaN, height: 5000 }, 300, 'a.png')).toBeNull();
  });
});
