import { useEffect } from 'react';
import { DesignPage, HomePage, NotFoundPage } from './platform';
import { ProfilePage } from './profile';
import { resolveWorldRoute, type WorldRoute } from './routes';
import { WorldPage } from './world';

const ROUTE_TITLES: Record<WorldRoute, string> = {
  home: 'Virtual N1 World',
  world: 'Agent Fights · Virtual N1 World',
  fights: 'Agent Fights · Virtual N1 World',
  profile: 'Player Record · Virtual N1 World',
  design: 'Design Panel · Virtual N1 World',
  'not-found': 'Room not found · Virtual N1 World',
};

function App() {
  const route = resolveWorldRoute(window.location.pathname);

  useEffect(() => {
    document.title = ROUTE_TITLES[route];
  }, [route]);

  switch (route) {
    case 'home':
      return <HomePage />;
    case 'world':
    case 'fights':
      return <WorldPage />;
    case 'profile':
      return <ProfilePage />;
    case 'design':
      return <DesignPage />;
    default:
      return <NotFoundPage />;
  }
}

export default App;
