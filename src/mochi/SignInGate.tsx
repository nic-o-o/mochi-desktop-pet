/* Sign-in for Customize Mochi when drawings go through Mochi's draw server.
 *
 * Labs policy: the draw server trusts only Clerk sign-ins. Mochi shares the
 * Ember lab's Clerk application; its testers are members of the "Codimango
 * Companion" organization, and the server accepts only tokens issued for it.
 * Email codes only (no passwords or social sign-in while dogfooding). This
 * sign-in is only for drawing: Codimango data still comes from the codimango
 * CLI on this Mac, under the person's own login, which never leaves it.
 */
import type { ReactNode } from 'react';
import { ClerkProvider, SignIn, useAuth, useOrganizationList, useUser } from '@clerk/electron/react';
import { CLERK_PUBLISHABLE_KEY, MOCHI_ORG_ID } from './clerkConfig.ts';


type Render = (getToken: () => Promise<string | null>) => ReactNode;

export function SignInGate({ children }: { children: Render }) {
  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY}>
      <Gate>{children}</Gate>
    </ClerkProvider>
  );
}

function Gate({ children }: { children: Render }) {
  const { isLoaded, isSignedIn, getToken, signOut } = useAuth();
  const { user } = useUser();
  const orgs = useOrganizationList({ userMemberships: true });
  if (!isLoaded) return <p className="customize-signin muted small">Loading sign-in…</p>;
  if (!isSignedIn) {
    return (
      <div className="customize-signin">
        <p className="small">Sign in with your @meta.com email to draw pets. Mochi emails you a code; nothing else changes.</p>
        <SignIn routing="hash" />
      </div>
    );
  }
  const memberships = orgs.isLoaded ? orgs.userMemberships.data : undefined;
  if (memberships && !memberships.some((m) => m.organization.id === MOCHI_ORG_ID)) {
    return (
      <div className="customize-signin">
        <p className="small">
          You're signed in as {user?.primaryEmailAddress?.emailAddress ?? 'this account'}, but you're not on Mochi's tester list yet. Ask the
          Mochi team to add you.
        </p>
        <button type="button" className="btn-link" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    );
  }
  // A token for Mochi's organization, which is what the draw server accepts.
  return <>{children(() => getToken({ organizationId: MOCHI_ORG_ID }))}</>;
}
