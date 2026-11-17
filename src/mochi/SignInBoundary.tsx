import { Component } from 'react';
import type { ReactNode } from 'react';

/* If Clerk fails to load or throws, say so in the panel instead of taking the whole pet down. */
export class SignInBoundary extends Component<{ fallback: (message: string) => ReactNode; children: ReactNode }, { message: string | null }> {
  state = { message: null as string | null };

  static getDerivedStateFromError(err: unknown) {
    return { message: err instanceof Error ? err.message : String(err) };
  }

  componentDidCatch(err: unknown) {
    console.error('Customize sign-in failed', err);
  }

  render() {
    return this.state.message === null ? this.props.children : this.props.fallback(this.state.message);
  }
}
