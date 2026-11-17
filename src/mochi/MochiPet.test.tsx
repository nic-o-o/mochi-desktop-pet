// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MochiPet } from './MochiPet.tsx';

const LOOK = 'data:image/png;base64,iVBORw0KGgo=';

describe('MochiPet with a drawn look', () => {
  it('poses and moves the picture for each mood, with that mood’s effect', () => {
    const effects = { chilling: null, happy: '.look-sparkles', sleepy: '.look-zz', nervous: '.look-sweat', focused: '.look-focus' } as const;
    for (const [state, effect] of Object.entries(effects)) {
      const { container, unmount } = render(<MochiPet state={state as keyof typeof effects} reviewFrac={0} subFrac={0} look={LOOK} />);
      const svg = container.querySelector('svg')!;
      expect(svg.classList).toContain('mochi-look');
      expect(svg.classList).toContain(`mochi-${state}`);
      expect(container.querySelector('.look-pose .look-motion image')?.getAttribute('href')).toBe(LOOK);
      expect(container.querySelectorAll('.look-effect')).toHaveLength(effect ? 1 : 0);
      if (effect) expect(container.querySelector(effect)).not.toBeNull();
      unmount();
    }
  });

  it('leaves the classic Mochi as it was', () => {
    const { container } = render(<MochiPet state="happy" reviewFrac={0} subFrac={0} />);
    expect(container.querySelector('svg')!.classList).not.toContain('mochi-look');
    expect(container.querySelector('.look-pose')).toBeNull();
  });
});
