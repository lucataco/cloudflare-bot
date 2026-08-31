import { useState, useEffect, useRef } from 'react';
import { RpcStub } from 'capnweb';
import { Overseer, ComputerSession, AiChatMessage } from '@gadgets/workshop-shared/api';

interface ComputerViewProps {
  agentId: string;
  overseer: RpcStub<Overseer>;
  onClose: () => void;
  pendingTakeoverRequest?: AiChatMessage & { type: "computerHumanTakeover" };
  onApproveTakeover?: (requestId: string) => Promise<void>;
  isProcessingTakeover?: (requestId: string) => boolean;
}

export function ComputerView({ agentId, overseer, onClose, pendingTakeoverRequest, onApproveTakeover, isProcessingTakeover }: ComputerViewProps) {
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState('about:blank');
  const [currentUrl, setCurrentUrl] = useState('about:blank');
  const sessionRef = useRef<RpcStub<ComputerSession> | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollDebounceRef = useRef<number | null>(null);
  const [approvingTakeover, setApprovingTakeover] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function initSession() {
      try {
        const computerSession = await overseer.getComputerSession(agentId);
        if (mounted) {
          sessionRef.current = computerSession;
          loadScreenshot(computerSession);
        }
      } catch (err) {
        if (mounted) {
          let errorMsg = 'Failed to initialize computer';
          if (err instanceof Error) {
            if (err.message.includes('BROWSER binding')) {
              errorMsg = 'Computer sessions require the BROWSER binding to be configured.';
            } else if (!err.message.includes('Proxy could not be serialized')) {
              errorMsg = err.message;
            }
          }
          setError(errorMsg);
        }
      }
    }

    initSession();

    return () => {
      mounted = false;
      if (screenshot) {
        URL.revokeObjectURL(screenshot);
      }
      if (sessionRef.current) {
        sessionRef.current[Symbol.dispose]();
      }
      if (scrollDebounceRef.current !== null) {
        clearTimeout(scrollDebounceRef.current);
      }
    };
  }, [agentId, overseer]);

  async function loadScreenshot(computerSession: RpcStub<ComputerSession>, showSpinner = true) {
    try {
      if (showSpinner) {
        setLoading(true);
      }
      setError(null);
      const imageData = await computerSession.screenshot();
      const blob = new Blob([imageData as unknown as BlobPart], { type: 'image/png' });
      const url = URL.createObjectURL(blob);
      if (screenshot) {
        URL.revokeObjectURL(screenshot);
      }
      setScreenshot(url);
      
      const state = await computerSession.getState();
      setCurrentUrl(state.currentUrl || 'about:blank');
      setUrl(state.currentUrl || 'about:blank');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load computer');
    } finally {
      if (showSpinner) {
        setLoading(false);
      }
    }
  }

  async function handleNavigate() {
    if (!sessionRef.current) return;
    try {
      setLoading(true);
      setError(null);
      await sessionRef.current.navigate(url);
      await loadScreenshot(sessionRef.current);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Navigation failed');
      setLoading(false);
    }
  }

  async function handleRefresh() {
    if (!sessionRef.current) return;
    await loadScreenshot(sessionRef.current, false);
  }

  async function handleCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!sessionRef.current || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const scaleX = 1280 / rect.width;
    const scaleY = 720 / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    
    try {
      await sessionRef.current.click(Math.round(x), Math.round(y));
      await loadScreenshot(sessionRef.current, false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Click failed');
    }
  }

  async function handleCanvasWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    e.preventDefault();
    if (!sessionRef.current) return;
    
    try {
      await sessionRef.current.scroll(e.deltaX, e.deltaY);
      
      if (scrollDebounceRef.current !== null) {
        clearTimeout(scrollDebounceRef.current);
      }
      
      scrollDebounceRef.current = window.setTimeout(async () => {
        if (sessionRef.current) {
          await loadScreenshot(sessionRef.current, false);
        }
      }, 150);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scroll failed');
    }
  }

  async function handleCanvasKeyDown(e: React.KeyboardEvent<HTMLCanvasElement>) {
    if (!sessionRef.current) return;

    const specialKeys = ['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    
    if (specialKeys.includes(e.key)) {
      e.preventDefault();
      try {
        await sessionRef.current.key(e.key);
        await loadScreenshot(sessionRef.current, false);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Key failed');
      }
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      try {
        await sessionRef.current.type(e.key);
        await loadScreenshot(sessionRef.current, false);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Type failed');
      }
    }
  }

  async function handleApproveTakeover() {
    if (!pendingTakeoverRequest || !onApproveTakeover) return;
    setApprovingTakeover(true);
    try {
      await onApproveTakeover(pendingTakeoverRequest.requestId);
    } finally {
      setApprovingTakeover(false);
    }
  }

  const hasPendingTakeover = pendingTakeoverRequest && pendingTakeoverRequest.state === 'pending';
  const isProcessing = hasPendingTakeover && isProcessingTakeover?.(pendingTakeoverRequest.requestId);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="flex h-[90vh] w-[90vw] flex-col rounded-lg bg-kumo-elevated shadow-xl">
        <div className="flex items-center justify-between border-b border-kumo-border px-4 py-3">
          <h2 className="text-lg font-semibold text-kumo-default">Agent Computer</h2>
          <div className="flex gap-2">
            {hasPendingTakeover && onApproveTakeover && (
              <button
                onClick={handleApproveTakeover}
                disabled={isProcessing || approvingTakeover}
                className="rounded bg-kumo-brand px-3 py-1.5 text-sm text-white hover:bg-kumo-brand-hover disabled:opacity-50"
              >
                Done
              </button>
            )}
            <button
              onClick={onClose}
              className="rounded px-3 py-1.5 text-sm text-kumo-default hover:bg-kumo-hovered"
            >
              Close
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 border-b border-kumo-border px-4 py-2">
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleNavigate()}
            placeholder="Enter URL"
            className="flex-1 rounded border border-kumo-border bg-kumo-base px-3 py-1.5 text-sm text-kumo-default focus:border-kumo-brand focus:outline-none"
          />
          <button
            onClick={handleNavigate}
            disabled={loading}
            className="rounded bg-kumo-brand px-4 py-1.5 text-sm text-white hover:bg-kumo-brand-hover disabled:opacity-50"
          >
            Go
          </button>
          <button
            onClick={handleRefresh}
            disabled={loading}
            className="rounded border border-kumo-border px-3 py-1.5 text-sm text-kumo-default hover:bg-kumo-hovered disabled:opacity-50"
          >
            Refresh
          </button>
        </div>
        
        <div className="flex-1 overflow-auto p-4">
          {loading && !screenshot && (
            <div className="flex h-full items-center justify-center">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" />
            </div>
          )}
          
          {error && !screenshot && (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <p className="text-sm text-red-500">{error}</p>
              </div>
            </div>
          )}
          
          {screenshot && (
            <div className="flex flex-col items-center gap-2">
              <div className="text-xs text-kumo-subtle">
                Current: {currentUrl}
              </div>
              <canvas
                ref={canvasRef}
                onClick={handleCanvasClick}
                onWheel={handleCanvasWheel}
                onKeyDown={handleCanvasKeyDown}
                tabIndex={0}
                style={{ 
                  backgroundImage: `url(${screenshot})`,
                  backgroundSize: 'contain',
                  backgroundRepeat: 'no-repeat',
                  width: '1280px',
                  height: '720px',
                  maxWidth: '100%',
                  cursor: 'crosshair',
                  border: '1px solid var(--kumo-border)',
                  outline: 'none'
                }}
              />
              <div className="text-xs text-kumo-subtle">
                Click, scroll, or type to interact
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
