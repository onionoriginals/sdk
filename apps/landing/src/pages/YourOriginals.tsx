import { library as copy } from '../content';
import { useEffect, useState } from 'react';
import { useAuth } from '../auth/useAuth';
import { navigate } from '../router';
import { BrowserOriginalsStore } from '../sdk/browser-store';
import { listLibrary, type LibraryItem } from '../sdk/library';
import { Demo } from '../components/Demo';
import './your-originals.css';

export function YourOriginals() {
  const { user, isLoading, bitcoin } = useAuth();
  if (isLoading) return <main className="section container"><p>{copy.loadingAccount}</p></main>;
  return <AccountLibrary key={user?.subOrgId ?? 'guest'} account={user?.subOrgId} fundingAddress={bitcoin?.fundingAddress} />;
}

function AccountLibrary({ account, fundingAddress }: { account?: string; fundingAddress?: string }) {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(true);
  const [hasDraft, setHasDraft] = useState(false);
  const [revision, setRevision] = useState(0);
  const path = location.pathname.slice('/me/'.length);
  let openDid: string | undefined;
  try { if (location.pathname.startsWith('/me/')) openDid = decodeURIComponent(path); } catch { /* list remains usable */ }
  useEffect(() => {
    let live = true;
    setBusy(true);
    void new BrowserOriginalsStore(account).getForm('new').then((v) => { if (live) setHasDraft(!!v); }).catch(() => { if (live) setError(copy.listError); });
    void listLibrary(account, fundingAddress).then((r) => { if (live) { setItems(r.items); setError(r.warning); } })
      .catch(() => { if (live) setError(copy.listError); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [account, fundingAddress, revision, openDid]);

  const importFile = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    setError(undefined);
    try {
      if (file.size > 96 * 1024 * 1024) throw new Error(copy.tooLarge);
      const { DemoEngine } = await import('../sdk/engine');
      const engine = new DemoEngine({ authed: !!account, subOrgId: account, store: new BrowserOriginalsStore(account) });
      const state = await engine.importEvidence(new Uint8Array(await file.arrayBuffer()));
      setRevision((v) => v + 1);
      navigate(`/me/${encodeURIComponent(state.did)}`);
    } catch (e) { setError(`${copy.importError} ${(e as Error).message}`); }
    finally { setBusy(false); }
  };
  return <main>
    <section className="section originals-library"><div className="container">
      <p className="eyebrow">{copy.eyebrow}</p>
      <h1>{copy.title}</h1>
      <p>{account ? copy.accountIntro : copy.guestIntro}</p>
      <p>{copy.durability}</p>
      <div className="library-actions">
        <a className="btn btn-primary" href="/#demo" onClick={(e) => { e.preventDefault(); navigate('/'); requestAnimationFrame(() => document.getElementById('demo')?.scrollIntoView()); }}>{copy.create}</a>
        <label className="btn">{copy.import}<input aria-label={copy.import} type="file" accept=".zip,application/zip" disabled={busy} onChange={(e) => { void importFile(e.target.files?.[0]); e.target.value = ''; }} /></label>
        <button className="btn" disabled={busy} onClick={() => setRevision((v) => v + 1)}>{copy.refresh}</button>
      </div>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">{copy.reading}</p>}
      {!busy && !items.length && <p>{copy.empty}</p>}
      {hasDraft && <p><a href="/#demo" onClick={(e) => { e.preventDefault(); navigate('/'); }}>{copy.draft}</a> · {copy.draftNote}</p>}
      <ul className="library-list">{items.map((item) => <li key={item.did}>
        <a href={`/me/${encodeURIComponent(item.did)}`} onClick={(e) => { e.preventDefault(); navigate(`/me/${encodeURIComponent(item.did)}`); }}>{item.title}</a>
        <p>{[item.local && copy.browser, item.server && copy.account, item.pending && copy.pending, item.bitcoin && copy.bitcoinUnchecked].filter(Boolean).join(' · ') || copy.incomplete}</p>
        <small>{item.did}</small>
        {item.problem && <p>{item.problem}</p>}
      </li>)}</ul>
    </div></section>
    {openDid && <Demo key={`${account ?? 'guest'}:${openDid}`} openDid={openDid} />}
  </main>;
}
