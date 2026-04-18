import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { LoginPage } from '@/features/auth/LoginPage'
import { SignupPage } from '@/features/auth/SignupPage'
import { ForgotPasswordPage } from '@/features/auth/ForgotPasswordPage'
import { ResetPasswordPage } from '@/features/auth/ResetPasswordPage'
import { ProtectedRoute } from '@/features/auth/ProtectedRoute'
import { HomePage } from '@/features/home/HomePage'
import { GroupsPage } from '@/features/groups/GroupsPage'
import { GroupDetailPage } from '@/features/groups/GroupDetailPage'
import { RecipeDetailPage } from '@/features/recipes/RecipeDetailPage'
import { RecipeFormPage } from '@/features/recipes/RecipeFormPage'
import { TagManagementPage } from '@/features/tagManagement/TagManagementPage'

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <HomePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/groups"
          element={
            <ProtectedRoute>
              <GroupsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/groups/:id"
          element={
            <ProtectedRoute>
              <GroupDetailPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/groups/:groupId/tags"
          element={
            <ProtectedRoute>
              <TagManagementPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/groups/:groupId/recipes/new"
          element={
            <ProtectedRoute>
              <RecipeFormPage mode="create" />
            </ProtectedRoute>
          }
        />
        <Route
          path="/groups/:groupId/recipes/:recipeId"
          element={
            <ProtectedRoute>
              <RecipeDetailPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/groups/:groupId/recipes/:recipeId/edit"
          element={
            <ProtectedRoute>
              <RecipeFormPage mode="edit" />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  )
}
