import { useEffect, useState } from 'react';

export type SetupKind = 'cli_missing' | 'login_required';

export const ALACARTE_URL =
  'https://www.internalfb.com/alacarte?device_key=JRRQJ7M9NL%3A%3Aprod&q=%5B%7B%22field%22%3A%22keyword%22%2C%22operator%22%3A%22contains%22%2C%22value%22%3A%7B%22type%22%3A%22string%22%2C%22value%22%3A%22devfeature_codimango%22%7D%7D%5D';
export const AUTH_SETUP_COMMAND = 'codimango auth setup';
const COPIED_MS = 2000;

/**
 * Shown in the glance panel instead of the rings and task lists until Mochi
 * can read Codimango: install the CLI (Alacarte), then sign in once.
 */
export function SetupCard({
  kind,
  checking,
  hint,
  onCheck,
  onOpenAlacarte,
}: {
  kind: SetupKind;
  checking: boolean;
  hint: boolean;
  onCheck: () => void;
  onOpenAlacarte: () => void;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(id);
  }, [copied]);

  function copyCommand() {
    navigator.clipboard
      ?.writeText(AUTH_SETUP_COMMAND)
      .then(() => setCopied(true))
      .catch(() => {
        /* clipboard blocked — the command stays selectable */
      });
  }

  const missing = kind === 'cli_missing';
  return (
    <div className="setup-card" role="status">
      <div className="setup-head">
        <span className="setup-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width={22} height={22} fill="none" stroke="currentColor" strokeWidth={1.8}>
            <rect x={3} y={4} width={18} height={16} rx={3} />
            <path d="M7.5 9.5l3 2.5-3 2.5M12.5 15h4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <div>
          <p className="setup-eyebrow">{missing ? 'Setup required' : 'Sign-in required'}</p>
          <h3 className="setup-title">{missing ? 'Codimango is not connected' : 'Codimango sign-in expired'}</h3>
        </div>
      </div>

      <p className="setup-body">
        {missing ? (
          <>
            Please open Alacarte to install Codimango (<code>devfeature_codimango</code>), then run the
            command below once in Terminal to sign in.
          </>
        ) : (
          <>Run the command below once in Terminal to sign in to Codimango again.</>
        )}
      </p>

      {missing && (
        <button type="button" className="setup-primary" onClick={onOpenAlacarte}>
          Open Alacarte <span aria-hidden="true">↗</span>
        </button>
      )}

      <div className="setup-command">
        <code>{AUTH_SETUP_COMMAND}</code>
        <button type="button" className="setup-copy" onClick={copyCommand}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <button type="button" className="setup-check" onClick={onCheck} disabled={checking}>
        {checking ? 'Checking…' : 'Check connection'}
      </button>

      {hint && (
        <p className="setup-hint" role="alert">
          {missing ? (
            <>
              Still not connected — make sure Codimango is installed from Alacarte and you've run{' '}
              <code>codimango auth setup</code> in Terminal, then check again.
            </>
          ) : (
            <>
              Still not connected — run <code>codimango auth setup</code> in Terminal to refresh your
              sign-in, then check again.
            </>
          )}
        </p>
      )}

      <p className="setup-foot">Once connected, Mochi will fetch the latest Codimango data automatically.</p>
    </div>
  );
}
