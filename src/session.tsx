import { useCallback, useEffect, useState } from 'react';
import { LogOut, UserRound } from 'lucide-react';
import { api, type Me } from './api';

export function useAicooSession() {
  const [me, setMe] = useState<Me | null>(null);

  const reload = useCallback(() => {
    setMe(null);
    api
      .me()
      .then(setMe)
      .catch(() => setMe({ signedIn: false }));
  }, []);

  useEffect(reload, [reload]);
  return { me, reload };
}

export function SessionChip({ me }: { me: Me }) {
  async function logout() {
    await api.logout().catch(() => undefined);
    window.location.replace('/');
  }

  return (
    <div className="session-chip">
      <span className="online-dot" />
      <a
        className="session-profile-link"
        href="/profile"
        aria-current={window.location.pathname === '/profile' ? 'page' : undefined}
        title="Open player record"
      >
        <UserRound size={15} aria-hidden="true" />
        <span className="session-profile-name">
          {me.displayName || me.username || 'Aicoo player'}
        </span>
        <span className="session-profile-action">Record</span>
      </a>
      <small>Aicoo OAuth</small>
      <button type="button" aria-label="Sign out" onClick={logout}>
        <LogOut size={15} />
      </button>
    </div>
  );
}
