/* Which Clerk instance and organization Customize Mochi's sign-in uses. Both are public by design.
 * Default: the Ember lab's Clerk Development instance (Mochi shares the lab's Clerk app) and
 * Mochi's "Codimango Companion" organization in it. Override at build time with
 * VITE_CLERK_PUBLISHABLE_KEY / VITE_MOCHI_ORG_ID (e.g. the Production instance later). */
export const CLERK_PUBLISHABLE_KEY: string =
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY || 'pk_test_cGlja2VkLWJ1bGxkb2ctODg4OC5jbGVyay5hY2NvdW50cy5kZXYk';
export const MOCHI_ORG_ID: string = import.meta.env.VITE_MOCHI_ORG_ID || 'org_3MDK53AuMTJALY1oggNVDkqFndl';
