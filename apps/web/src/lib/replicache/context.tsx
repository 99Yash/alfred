import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { authClient } from '~/lib/auth-client';
import { createReplicache, type AlfredReplicache } from './client';

interface ReplicacheContextValue {
  rep: AlfredReplicache | null;
}

const ReplicacheContext = createContext<ReplicacheContextValue>({ rep: null });

export function ReplicacheProvider({ children }: { children: React.ReactNode }) {
  const { data: session } = authClient.useSession();
  const [rep, setRep] = useState<AlfredReplicache | null>(null);
  const closeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const userId = session?.user?.id;
    if (!userId) {
      closeRef.current?.();
      closeRef.current = null;
      setRep(null);
      return;
    }

    const { rep: newRep, close } = createReplicache(userId);
    closeRef.current = close;
    setRep(newRep);

    return () => {
      close();
      closeRef.current = null;
    };
  }, [session?.user?.id]);

  return (
    <ReplicacheContext.Provider value={{ rep }}>
      {children}
    </ReplicacheContext.Provider>
  );
}

export function useReplicache(): AlfredReplicache | null {
  return useContext(ReplicacheContext).rep;
}
