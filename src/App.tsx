import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider } from './contexts/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import OwnerRoute from './components/OwnerRoute'
import Home from './pages/Home'
import Login from './pages/Login'
import Signup from './pages/Signup'
import Dashboard from './pages/Dashboard'
import Invite from './pages/Invite'
import Chat from './pages/Chat'
import AvatarSelect from './pages/AvatarSelect'
import Settings from './pages/Settings'
import Status from './pages/Status'
import AuthCallback from './pages/AuthCallback'
import VideoCall from './pages/VideoCall'
import Perception from './pages/Perception'
import ExtendedPerception from './pages/ExtendedPerception'
import MeetingLobby from './pages/MeetingLobby'
import MeetingHost from './pages/MeetingHost'

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/invite/:token" element={<Invite />} />
          <Route path="/status" element={<Status />} />
          <Route path="/meeting/:token" element={<MeetingLobby />} />
          <Route path="/chat/:conversationId" element={<Chat />} />
          <Route path="/video-call" element={<VideoCall />} />
          <Route path="/video-call/:conversationId" element={<VideoCall />} />
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
            path="/perception"
            element={
              <ProtectedRoute>
                <Perception />
              </ProtectedRoute>
            }
          />
          <Route
            path="/perception/extended"
            element={
              <ProtectedRoute>
                <ExtendedPerception />
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
              <ProtectedRoute>
                <MeetingHost />
              </ProtectedRoute>
            }
          />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}
