import { Navigate, Route, Routes } from 'react-router-dom';
import AppLayout from './components/AppLayout';
import PhoneFrame from './components/PhoneFrame';
import { useApp } from './context/AppContext';
import type { ReactNode } from 'react';

import Login from './views/Login';
import Register from './views/Register';
import Dashboard from './views/Dashboard';
import CreateGoal from './views/CreateGoal';
import GoalDetail from './views/GoalDetail';
import Profile from './views/Profile';
import Social from './views/Social';
import Friends from './views/Friends';
import InviteFriends from './views/InviteFriends';
import InviteAccept from './views/InviteAccept';
import UserProfile from './views/UserProfile';
import Subscription from './views/Subscription';
import TeamChallenges from './views/TeamChallenges';
import CreateTeamChallenge from './views/CreateTeamChallenge';
import TeamChallengeDetail from './views/TeamChallengeDetail';
import Analytics from './views/Analytics';
import Themes from './views/Themes';
import Verifier from './views/Verifier';
import Recipient from './views/Recipient';
import Terms from './views/Terms';
import Privacy from './views/Privacy';
import FeatureRequests from './views/FeatureRequests';

function Splash() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="h-10 w-10 rounded-full border-2 border-line border-t-accent pulse-ring" />
    </div>
  );
}

function Guard({ children }: { children: ReactNode }) {
  const { user, loading } = useApp();
  if (loading) return <Splash />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function PublicOnly({ children }: { children: ReactNode }) {
  const { user, loading } = useApp();
  if (loading) return <Splash />;
  if (user && !user.isGuest) return <Navigate to="/goals" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <PhoneFrame>
      <Routes>
        <Route path="/login" element={<PublicOnly><Login /></PublicOnly>} />
        <Route path="/register" element={<PublicOnly><Register /></PublicOnly>} />

        {/* Public judge view — clean URLs: /verify/:challengeId/:token */}
        <Route path="/verify/:challengeId/:token" element={<Verifier />} />
        <Route path="/verify" element={<Verifier />} />

        {/* Public recipient consent / manage / unsubscribe page */}
        <Route path="/recipient/:token" element={<Recipient />} />
        <Route path="/recipient" element={<Recipient />} />

        {/* Public "become a judge" invite acceptance page */}
        <Route path="/invite/:token" element={<InviteAccept />} />
        <Route path="/invite" element={<InviteAccept />} />

        <Route path="/terms" element={<Terms />} />
        <Route path="/privacy" element={<Privacy />} />

        <Route element={<Guard><AppLayout /></Guard>}>
          <Route path="/goals" element={<Dashboard />} />
          <Route path="/create" element={<CreateGoal />} />
          <Route path="/goal/:id" element={<GoalDetail />} />
          <Route path="/social" element={<Social />} />
          <Route path="/friends" element={<Friends />} />
          <Route path="/invite-friends" element={<InviteFriends />} />
          <Route path="/u/:userId" element={<UserProfile />} />
          <Route path="/feature-requests" element={<FeatureRequests />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/subscription" element={<Subscription />} />
          {/* Legacy alias */}
          <Route path="/premium" element={<Navigate to="/subscription" replace />} />
          <Route path="/wallet" element={<Navigate to="/subscription" replace />} />
          {/* Team challenges: relay / tug of war between two equal teams */}
          <Route path="/challenges" element={<TeamChallenges />} />
          <Route path="/challenges/new" element={<CreateTeamChallenge />} />
          <Route path="/challenge/:id" element={<TeamChallengeDetail />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/themes" element={<Themes />} />
        </Route>

        <Route path="*" element={<Navigate to="/goals" replace />} />
      </Routes>
    </PhoneFrame>
  );
}
