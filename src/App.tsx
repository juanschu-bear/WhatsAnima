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
          <Route path="/chat/:conversationId" element={<Chat />} />
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
            path="/settings"
            element={
              <OwnerRoute>
                <Settings />
              </OwnerRoute>
            }
          />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}
