import { useState, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { Dialog } from '@cloudflare/kumo';
import type { RpcStub } from 'capnweb';
import type { Overseer, ComputerSession, ComputerControlMode, GadgetMetadata, AiChatMessage } from '@gadgets/workshop-shared/api';
import { WorkshopButton } from './WorkshopControls';
import ChromeSessionImport from './ChromeSessionImport';
import SecretRequestInput from './SecretRequestInput';
import ComputerWorkspacePane from './ComputerWorkspacePane';

interface ComputerViewProps {
  agentId: string;
  overseer: RpcStub<Overseer>;
  onClose: () => void;
  pendingTakeoverRequest?: AiChatMessage & { type: 'computerHumanTakeover' };
  onApproveTakeover?: (requestId: string) => Promise<void>;
  isProcessingTakeover?: (requestId: string) => boolean;
  embedded?: boolean;
}

export function ComputerView(props: ComputerViewProps) {
  const [metadata, setMetadata] = useState<{ overseer: RpcStub<Overseer>; value: GadgetMetadata }>();
  const [failed, setFailed] = useState(false);
  const pauseGeneration = useRef(0);
  useEffect(() => {
    let active = true;
    let subscription: RpcStub<{}> | undefined;
    setFailed(false);
    void (async () => {
      try {
        const result = await props.overseer.subscribeToMetadata(value => {
          if (!active) return;
          // React may batch pause/resume into one render; invalidate intent on every pause notice.
          if (value.automationPaused) pauseGeneration.current++;
          setMetadata({ overseer: props.overseer, value });
        });
        if (active) subscription = result;
        else result[Symbol.dispose]();
      } catch {
        if (active) setFailed(true);
      }
    })();
    return () => {
      active = false;
      subscription?.[Symbol.dispose]();
    };
  }, [props.overseer]);

  const current = metadata?.overseer === props.overseer ? metadata.value : undefined;
  const owner = current && !current.owner && current.role !== 'use';
  const body = <>
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-kumo-line px-3 py-2">
      <h2 className="text-sm font-medium text-kumo-default">Browser</h2>
      <WorkshopButton onClick={props.onClose}>Close view</WorkshopButton>
      <p className="w-full text-xs text-kumo-subtle">Closing this view only hides it. Use Disable browser access to revoke access.</p>
    </div>
    {failed ? <p role="alert" className="p-4">Could not verify browser permissions. Close and reopen this view to check again.</p>
      : !current ? <p role="status" className="p-4">Checking browser permissions...</p>
      : !owner ? <p className="p-4 text-sm text-kumo-subtle">Only the workspace owner can view or control this browser.</p>
      : <OwnerComputerView key={props.agentId} {...props} automationPaused={current.automationPaused === true} pauseGeneration={pauseGeneration} />}
  </>;
  return props.embedded
    ? <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-kumo-base">{body}</div>
    : <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="flex h-[90dvh] w-[94vw] flex-col overflow-y-auto rounded-lg bg-kumo-base shadow-xl">{body}</div>
    </div>;
}

function OwnerComputerView({ agentId, overseer, pendingTakeoverRequest, onApproveTakeover, isProcessingTakeover, automationPaused, pauseGeneration }: ComputerViewProps & { automationPaused: boolean; pauseGeneration: RefObject<number> }) {
  const [workspaceTab, setWorkspaceTab] = useState(false);
  const [mode, setMode] = useState<ComputerControlMode | null>(null);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [url, setUrl] = useState('about:blank');
  const [currentUrl, setCurrentUrl] = useState('about:blank');
  const [busy, setBusy] = useState(false);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [consent, setConsent] = useState<{ requestId?: string } | null>(null);
  const pendingId = pendingTakeoverRequest?.state === 'pending' ? pendingTakeoverRequest.requestId : undefined;
  const previousPendingId = useRef(pendingId);
  const processing = pendingId !== undefined && isProcessingTakeover?.(pendingId);
  const latest = useRef({ pendingId, automationPaused, onApproveTakeover, processing });
  useLayoutEffect(() => { latest.current = { pendingId, automationPaused, onApproveTakeover, processing }; });

  // Each async operation holds this scope and a revision. Revoking/changing grants invalidates
  // reads immediately, including session acquisitions that have not returned yet.
  const [scope] = useState(() => ({
    active: false, revision: 0, changing: false, busy: false,
    mode: null as ComputerControlMode | null,
    session: null as RpcStub<ComputerSession> | null,
    image: null as string | null,
  }));

  function releaseSession() {
    scope.revision++;
    scope.session?.[Symbol.dispose]();
    scope.session = null;
    if (scope.image) URL.revokeObjectURL(scope.image);
    scope.image = null;
    scope.busy = false;
  }

  useEffect(() => {
    scope.active = true;
    void checkMode(true);
    return () => {
      scope.active = false;
      releaseSession();
    };
  }, [scope, overseer, agentId]);

  useEffect(() => {
    setConsent(null);
    // The bot's takeover request itself changes the persisted mode to human.
    if (pendingId && pendingId !== previousPendingId.current && !scope.changing) void checkMode(true);
    previousPendingId.current = pendingId;
  }, [pendingId]);
  useEffect(() => { setConsent(null); }, [automationPaused]);

  async function checkMode(openSession: boolean) {
    if (!scope.active || scope.changing) return;
    releaseSession();
    const revision = scope.revision;
    scope.mode = null;
    setMode(null);
    setScreenshot(null);
    setBusy(true);
    try {
      const next = await overseer.getComputerControl(agentId);
      if (!scope.active || revision !== scope.revision) return;
      scope.mode = next;
      setMode(next);
      if (openSession && next !== 'disabled') await readBrowser();
    } catch {
      if (scope.active && revision === scope.revision) setError('Could not read browser access. Check access again before continuing.');
    } finally {
      if (scope.active && revision === scope.revision) setBusy(false);
    }
  }

  async function readBrowser(action?: (session: RpcStub<ComputerSession>) => PromiseLike<void>) {
    if (!scope.active || scope.changing || scope.busy || !scope.mode || scope.mode === 'disabled') return;
    if (action && scope.mode !== 'human') return;
    const revision = scope.revision;
    const valid = () => scope.active && revision === scope.revision;
    scope.busy = true;
    setBusy(true);
    try {
      if (!scope.session) {
        const result = await overseer.getComputerSession(agentId);
        if (!valid()) { result[Symbol.dispose](); return; }
        scope.session = result;
      }
      const session = scope.session;
      if (action) await action(session);
      if (!valid()) return;
      const [image, state] = await Promise.all([session.screenshot(), session.getState()]);
      if (!valid()) return;
      const imageUrl = URL.createObjectURL(new Blob([new Uint8Array(image)], { type: 'image/png' }));
      if (scope.image) URL.revokeObjectURL(scope.image);
      scope.image = imageUrl;
      setScreenshot(imageUrl);
      setCurrentUrl(state.currentUrl || 'about:blank');
      setUrl(state.currentUrl || 'about:blank');
    } catch {
      if (valid()) {
        // Never echo browser inputs or provider errors, which may contain typed text.
        setError('Browser operation failed. It may have completed; it was not retried. Check the current access and screenshot before continuing.');
        await checkMode(false);
      }
    } finally {
      if (valid()) {
        scope.busy = false;
        setBusy(false);
      }
    }
  }

  async function changeMode(next: ComputerControlMode, requestId?: string) {
    if (!scope.active || scope.changing) return;
    if (next === 'agent' && (latest.current.automationPaused || latest.current.processing ||
        requestId !== latest.current.pendingId)) return;
    const generation = pauseGeneration.current;
    scope.changing = true;
    releaseSession();
    scope.mode = null;
    setMode(null);
    setScreenshot(null);
    setChanging(true);
    setBusy(false);
    setConsent(null);
    setError(null);
    let succeeded = false;
    try {
      // Do not pipeline approval: the explicit grant must succeed first.
      await overseer.setComputerControl(agentId, next);
      if (!scope.active) return;
      if (requestId !== undefined) {
        if (pauseGeneration.current !== generation) {
          setError('Automation was paused while granting browser control. Confirm again to continue this request. Your current browser access is shown below.');
          return;
        }
        if (latest.current.pendingId !== requestId || latest.current.automationPaused) {
          throw new Error('Takeover changed');
        }
        if (latest.current.onApproveTakeover) await latest.current.onApproveTakeover(requestId);
        else await overseer.approveComputerHumanTakeover(requestId);
      }
      succeeded = true;
    } catch (caught) {
      if (scope.active) setError(caught instanceof Error && caught.message.includes('observed sensitive data')
        ? 'Bot browser control is blocked because this workspace has observed sensitive data. You can still use human control.'
        : 'Could not confirm the browser control change. It may have taken effect; it was not retried. Current access is checked below.');
    } finally {
      scope.changing = false;
      if (scope.active) {
        setChanging(false);
        await checkMode(succeeded);
      }
    }
  }

  const manual = mode === 'human' && !busy && !changing;
  const readable = (mode === 'human' || mode === 'agent') && !busy && !changing;
  return <>
    <div className="space-y-3 border-b border-kumo-line p-3 text-sm text-kumo-subtle">
      <p role="status" className="font-medium text-kumo-default">
        {mode === 'disabled' ? 'Browser access is disabled' : mode === 'human' ? 'You control the browser' : mode === 'agent' ? 'Bot control allowed - owner view is read-only' : 'Checking browser access...'}
      </p>
      <p>Stored website sessions persist when access is disabled. Disabling does not erase cookies or sign you out of websites.</p>
      {automationPaused && <p>Automation is paused. You can still use the browser yourself; bot access is blocked until automation resumes.</p>}
      {pendingId && <p>Human interaction requested. Complete the step yourself, then explicitly allow bot control to continue this request.</p>}
      <div className="flex flex-wrap gap-2">
        {mode === 'disabled' && <WorkshopButton onClick={() => void changeMode('human')} disabled={changing}>Start browser for me</WorkshopButton>}
        {mode === 'agent' && <WorkshopButton onClick={() => void changeMode('human')} disabled={changing}>Take control</WorkshopButton>}
        {mode !== null && (mode !== 'agent' || pendingId) && <WorkshopButton
          disabled={changing || automationPaused || processing}
          onClick={() => setConsent({ requestId: pendingId })}
        >{pendingId ? 'Allow bot control and continue...' : 'Allow bot control...'}</WorkshopButton>}
        {mode !== 'disabled' && <WorkshopButton disabled={changing} onClick={() => void changeMode('disabled')}>Disable browser access</WorkshopButton>}
        <WorkshopButton disabled={changing || busy} onClick={() => void checkMode(false)}>Check access</WorkshopButton>
      </div>
      {mode === 'human' && <ChromeSessionImport overseer={overseer} agentId={agentId} disabled={!manual} />}
      {mode === 'human' && pendingId && pendingTakeoverRequest?.secretInput && <SecretRequestInput key={pendingId}
        overseer={overseer} requestId={pendingId} submitted={pendingTakeoverRequest.secretInput.submitted} />}
      {error && <p role="alert" className="text-kumo-danger">{error}</p>}
      <div className="flex gap-3"><button aria-pressed={!workspaceTab} onClick={() => setWorkspaceTab(false)}>Browser</button><button aria-pressed={workspaceTab} onClick={() => setWorkspaceTab(true)}>Shell & files</button></div>
    </div>

    {workspaceTab && <ComputerWorkspacePane key={agentId} overseer={overseer} agentId={agentId} humanControl={mode === 'human'} />}
    {!workspaceTab && mode !== null && mode !== 'disabled' && <>
      <div className="flex flex-wrap gap-2 border-b border-kumo-line p-3">
        <input aria-label="Browser URL" value={url} disabled={!manual}
          onChange={event => setUrl(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && manual) void readBrowser(session => session.navigate(url)); }}
          className="min-w-0 flex-1 rounded border border-kumo-line bg-kumo-base px-2 text-sm text-kumo-default disabled:opacity-50" />
        <WorkshopButton disabled={!manual} onClick={() => void readBrowser(session => session.navigate(url))}>Go</WorkshopButton>
        <WorkshopButton disabled={!readable} onClick={() => void readBrowser()}>Refresh screenshot</WorkshopButton>
      </div>
      <div className="min-h-0 flex-1 p-3">
        {busy && <p role="status">Loading browser...</p>}
        {screenshot && <>
          <p className="mb-2 break-all text-xs text-kumo-subtle">Current: {currentUrl}</p>
          <canvas aria-label="Browser screenshot" role="img" aria-disabled={!manual} tabIndex={manual ? 0 : -1}
            width={1280} height={720}
            onClick={event => {
              if (!manual) return;
              const rect = event.currentTarget.getBoundingClientRect();
              if (!rect.width || !rect.height) return;
              const x = Math.round((event.clientX - rect.left) * 1280 / rect.width);
              const y = Math.round((event.clientY - rect.top) * 720 / rect.height);
              void readBrowser(session => session.click(x, y));
            }}
            onWheel={event => {
              if (!manual) return;
              event.preventDefault();
              void readBrowser(session => session.scroll(event.deltaX, event.deltaY));
            }}
            onKeyDown={event => {
              if (!manual) return;
              const keys = ['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
              if (keys.includes(event.key)) {
                event.preventDefault();
                void readBrowser(session => session.key(event.key));
              } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
                event.preventDefault();
                void readBrowser(session => session.type(event.key));
              }
            }}
            className="block h-auto w-full border border-kumo-line focus-visible:outline-2 focus-visible:outline-kumo-ring"
            style={{ backgroundImage: `url(${screenshot})`, backgroundSize: '100% 100%', cursor: manual ? 'crosshair' : 'default' }} />
          <p className="mt-2 text-xs text-kumo-subtle">{mode === 'human' ? 'Click, scroll, or type to interact.' : 'Read-only screenshot. Take control before interacting.'}</p>
        </>}
      </div>
    </>}

    <Dialog.Root open={consent !== null && !automationPaused} onOpenChange={open => { if (!open) setConsent(null); }}>
      <Dialog size="sm" className="responsive-dialog !z-[1000] !top-[clamp(28px,10vh,96px)] !w-[min(460px,calc(100vw-32px))] !-translate-y-0 !max-h-[min(80vh,calc(var(--app-height)-32px))] overflow-y-auto bg-kumo-base p-5">
        <Dialog.Title className="text-base font-medium text-kumo-default">Allow bot control of this browser?</Dialog.Title>
        <Dialog.Description className="mt-3 text-sm text-kumo-subtle">
          This grants full browser reads and writes, including signed-in websites and their stored sessions.
          The bot can take consequential actions without per-action or per-origin approvals.
        </Dialog.Description>
        <p className="mt-3 text-sm text-kumo-subtle">Access continues until you take control or disable browser access. Closing this view does not revoke it. Stored website sessions persist after disabling.</p>
        {consent?.requestId && <p className="mt-3 text-sm text-kumo-subtle">This also approves the pending human interaction request and lets the bot continue.</p>}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <WorkshopButton onClick={() => setConsent(null)}>Cancel</WorkshopButton>
          <WorkshopButton tone="primary" disabled={changing || automationPaused || processing}
            onClick={() => { if (consent) void changeMode('agent', consent.requestId); }}>Allow bot control</WorkshopButton>
        </div>
      </Dialog>
    </Dialog.Root>
  </>;
}
