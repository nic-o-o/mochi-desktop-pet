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
import { ClerkFailed, ClerkLoading, ClerkProvider, SignIn, useAuth, useOrganizationList, useUser } from '@clerk/electron/react';
import { CLERK_PUBLISHABLE_KEY, MOCHI_ORG_ID } from './clerkConfig.ts';


type Render = (getToken: () => Promise<string | null>) => ReactNode;
/** Wraps the gate's own screens (loading, sign-in, not a tester) in the Customize Mochi panel. */
type Frame = (body: ReactNode) => ReactNode;

/* Clerk's card, flattened to fit the panel. */
const APPEARANCE = { elements: { rootBox: { width: '100%' }, cardBox: { width: '100%', boxShadow: 'none' } } };

/*
 * Mochi's window never leaves its page. Clerk's sign-in steps move between
 * hashes on it; anything else (such as going to "/" after signing in) would
 * reload the window without its desktop-pet flag, so it is ignored: the gate
 * follows the sign-in state instead.
 */
function stayOnPage(to: string) {
  const next = new URL(to, window.location.href);
  const here = window.location;
  if (next.origin === here.origin && next.pathname === here.pathname && next.search === here.search) here.hash = next.hash;
}

export function SignInGate({ children, frame }: { children: Render; frame: Frame }) {
  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} appearance={APPEARANCE} routerPush={stayOnPage} routerReplace={stayOnPage}>
      <Gate frame={frame}>{children}</Gate>
    </ClerkProvider>
  );
}

function Gate({ children, frame }: { children: Render; frame: Frame }) {
  const { isLoaded, isSignedIn, getToken, signOut } = useAuth();
  const { user } = useUser();
  const orgs = useOrganizationList({ userMemberships: true });
  if (!isLoaded) {
    // A failed load never becomes "loaded", so say so instead of loading forever.
    return frame(
      <>
        <ClerkLoading>
          <p className="customize-signin muted small">Loading sign-in…</p>
        </ClerkLoading>
        <ClerkFailed>
          <p className="customize-error" role="alert">
            Sign-in couldn't start. Close Customize and try again; if it keeps failing, report a problem.
          </p>
        </ClerkFailed>
      </>,
    );
  }
  if (!isSignedIn) {
    return frame(
      <div className="customize-signin">
        <p className="small">Sign in with your @meta.com email to draw pets. Mochi emails you a code; nothing else changes.</p>
        {/* Sign in, or create the account on first use (the allowlist decides who may). */}
        <SignIn routing="hash" withSignUp />
      </div>
    );
  }
  const memberships = orgs.isLoaded ? orgs.userMemberships.data : undefined;
  if (memberships && !memberships.some((m) => m.organization.id === MOCHI_ORG_ID)) {
    return frame(
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
