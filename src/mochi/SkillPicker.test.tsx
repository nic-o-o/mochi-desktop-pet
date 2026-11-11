// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReviewSkill } from './agentReviews.ts';
import { SkillPicker } from './AgentRow.tsx';

const SKILLS: ReviewSkill[] = [
  { id: 'default', source: 'default', label: 'Codimango review assistant (default)' },
  { id: 'added:1', source: 'added', label: 'team-check' },
  { id: 'plugin:m:p:a-review', source: 'plugin', label: 'p:a-review' },
  { id: 'plugin:m:p:b-review', source: 'plugin', label: 'p:b-review' },
];

function Harness() {
  const [value, setValue] = useState('default');
  const [starred, setStarred] = useState<string[]>([]);
  return (
    <SkillPicker
      skills={SKILLS}
      value={value}
      starred={starred}
      canAdd
      onPick={setValue}
      onAdd={() => {}}
      onToggleStar={(id) => setStarred((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))}
    />
  );
}

const groupOf = (label: string) => screen.getByText(label).closest('.skill-group') as HTMLElement;

afterEach(cleanup);

describe('SkillPicker', () => {
  it('ends every skill line but the default in an empty star; starring moves it to Starred, yellow', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /Codimango review assistant/ }));
    expect(screen.queryByLabelText('Star Codimango review assistant (default)')).toBeNull();
    const star = screen.getByLabelText('Star p:b-review');
    expect(star.textContent).toBe('☆');
    fireEvent.click(star);
    const starred = groupOf('Starred');
    expect(starred.textContent).toContain('p:b-review');
    expect(groupOf('Plugin review skills').textContent).not.toContain('p:b-review');
    const filled = screen.getByLabelText('Unstar p:b-review');
    expect(filled.textContent).toBe('★');
    expect(filled.className).toContain('is-starred');
  });

  it('marks the chosen skill with a check, searches by name and picks a skill, closing the list', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /Codimango review assistant/ }));
    expect(document.querySelector('[aria-current="true"]')?.textContent).toBe('✓Codimango review assistant (default)');
    fireEvent.change(screen.getByLabelText('Search skills'), { target: { value: 'a-rev' } });
    expect(screen.queryByText('p:b-review')).toBeNull();
    fireEvent.click(screen.getByText('p:a-review'));
    expect(screen.queryByLabelText('Search skills')).toBeNull();
    expect(screen.getByRole('button', { name: /p:a-review/ })).toBeTruthy();
  });
});
