import { useState, useEffect, useRef } from 'react';
import { RpcStub } from 'capnweb';
import { Overseer, ComputerSession } from '@gadgets/workshop-shared/api';

interface ComputerViewProps {
  agentId: string;
  overseer: RpcStub<Overseer>;
  onClose: () => void;
}

export function ComputerView({ agentId, overseer, onClose }: ComputerViewProps) {
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState('about:blank');
  const [currentUrl, setCurrentUrl] = useState('about:blank');
  const sessionRef = useRef<RpcStub<ComputerSession> | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

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
          setError(err instanceof Error ? err.message : 'Failed to initialize computer');
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
    };
  }, [agentId, overseer]);

  async function loadScreenshot(computerSession: RpcStub<ComputerSession>) {
    try {
      setLoading(true);
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
      setLoading(false);
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
    await loadScreenshot(sessionRef.current);
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
      await loadScreenshot(sessionRef.current);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Click failed');
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="flex h-[90vh] w-[90vw] flex-col rounded-lg bg-kumo-elevated shadow-xl">
        <div className="flex items-center justify-between border-b border-kumo-border px-4 py-3">
          <h2 className="text-lg font-semibold text-kumo-default">Agent Computer</h2>
          <button
            onClick={onClose}
            className="rounded px-3 py-1.5 text-sm text-kumo-default hover:bg-kumo-hovered"
          >
            Close
          </button>
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
          {loading && (
            <div className="flex h-full items-center justify-center">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" />
            </div>
          )}
          
          {error && (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <p className="text-sm text-red-500">{error}</p>
                <p className="mt-2 text-xs text-kumo-subtle">
                  Computer sessions require the BROWSER binding to be configured.
                </p>
              </div>
            </div>
          )}
          
          {screenshot && !loading && (
            <div className="flex flex-col items-center gap-2">
              <div className="text-xs text-kumo-subtle">
                Current: {currentUrl}
              </div>
              <canvas
                ref={canvasRef}
                onClick={handleCanvasClick}
                style={{ 
                  backgroundImage: `url(${screenshot})`,
                  backgroundSize: 'contain',
                  backgroundRepeat: 'no-repeat',
                  width: '1280px',
                  height: '720px',
                  maxWidth: '100%',
                  cursor: 'crosshair',
                  border: '1px solid var(--kumo-border)'
                }}
              />
              <div className="text-xs text-kumo-subtle">
                Click on the image to interact
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
