import { useState, useEffect } from 'react';
import { useAuthenticatedApi } from '../AuthContext';

interface ComputerViewProps {
  agentId: string;
  onClose: () => void;
}

export function ComputerView({ agentId, onClose }: ComputerViewProps) {
  const { authenticatedApi } = useAuthenticatedApi();
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    async function loadScreenshot() {
      try {
        setLoading(true);
        setError(null);
        const overseer = await authenticatedApi.openGadget(agentId);
        const imageData = await overseer.computerScreenshot(agentId);
        if (mounted) {
          const blob = new Blob([imageData], { type: 'image/png' });
          const url = URL.createObjectURL(blob);
          setScreenshot(url);
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Failed to load computer');
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }

    loadScreenshot();

    return () => {
      mounted = false;
      if (screenshot) {
        URL.revokeObjectURL(screenshot);
      }
    };
  }, [agentId, authenticatedApi]);

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
            <div className="flex justify-center">
              <img src={screenshot} alt="Computer screenshot" className="max-w-full rounded border border-kumo-border" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
