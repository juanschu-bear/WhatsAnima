import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider } from './contexts/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import OwnerRoute from './components/OwnerRoute'
import Home from './pages/Home'
import Login from './pages/Login'
import Signup from './pages/Signup'
import Dashboard from './pages/Dashboard'
import Invite from './pages/Invite'
import InviteAccept from './pages/InviteAccept'
import Onboarding from './pages/Onboarding'
import Chat from './pages/Chat'
import AvatarSelect from './pages/AvatarSelect'
import Settings from './pages/Settings'
import Status from './pages/Status'
import AuthCallback from './pages/AuthCallback'
import AuthResetPassword from './pages/AuthResetPassword'
import VideoCall from './pages/VideoCall'
import Perception from './pages/Perception'
import MeetingLobby from './pages/MeetingLobby'
import MeetingHost from './pages/MeetingHost'
import OPMPerceptionPanelPreviewScreen from './screens/OPMPerceptionPanelPreviewScreen'
import EcosystemConsole from './pages/EcosystemConsole'
import {
  DiaryEntryRoute,
  DiarySelectRoute,
  DiaryAvatarRoute,
} from './pages/Diary'
import ReadoutsPage from './pages/Readouts'
import IncomingCallOverlay from './components/IncomingCallOverlay'

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route path="/auth/reset-password" element={<AuthResetPassword />} />
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/invite/:inviteCode" element={<InviteAccept />} />
          <Route
            path="/onboarding"
            element={
              <ProtectedRoute>
                <Onboarding />
              </ProtectedRoute>
            }
          />
          <Route path="/status" element={<Status />} />
          <Route path="/meeting/:token" element={<MeetingLobby />} />
          <Route path="/chat/:conversationId" element={<Chat />} />
          <Route path="/video-call" element={<VideoCall />} />
          <Route path="/video-call/:conversationId" element={<VideoCall />} />
          <Route path="/opm-monitor" element={<OPMPerceptionPanelPreviewScreen />} />
          <Route path="/diary" element={<DiaryEntryRoute />} />
          <Route path="/readouts" element={<ReadoutsPage />} />
          <Route path="/diary/select" element={<DiarySelectRoute />} />
          <Route path="/diary/:agentId" element={<DiaryAvatarRoute />} />
          <Route
            path="/console"
            element={<EcosystemConsole />}
          />
          <Route
            path="/avatars"
            element={
              <ProtectedRoute>
                <AvatarSelect />
              </ProtectedRoute>
            }
          />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Home />
              </ProtectedRoute>
            }
          />
          <Route
            path="/dashboard"
            element={
              <OwnerRoute>
                <Dashboard />
              </OwnerRoute>
            }
          />
          <Route
            path="/invite"
            element={
              <OwnerRoute>
                <Invite />
              </OwnerRoute>
            }
          />
          <Route
            path="/perception"
            element={
              <ProtectedRoute>
                <Perception />
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings"
            element={
              <OwnerRoute>
                <Settings />
              </OwnerRoute>
            }
          />
          <Route
            path="/meeting-host"
            element={
              <OwnerRoute>
                <MeetingHost />
              </OwnerRoute>
            }
          />
        </Routes>
        <IncomingCallOverlay />
      </AuthProvider>
    </BrowserRouter>
  )
}
