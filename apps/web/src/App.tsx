import { BrowserRouter, Outlet, Route, Routes } from 'react-router-dom'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { NotFoundPage } from '@/components/NotFoundPage'
import { AppLayout } from '@/components/layout/AppLayout'
import { AuthLayout } from '@/features/auth/AuthLayout'
import { LoginPage } from '@/features/auth/LoginPage'
import { SignupPage } from '@/features/auth/SignupPage'
import { ForgotPasswordPage } from '@/features/auth/ForgotPasswordPage'
import { ResetPasswordPage } from '@/features/auth/ResetPasswordPage'
import { ProtectedRoute } from '@/features/auth/ProtectedRoute'
import { HomePage } from '@/features/home/HomePage'
import { GroupsPage } from '@/features/groups/GroupsPage'
import { GroupDetailPage } from '@/features/groups/GroupDetailPage'
import { GroupSettingsPage } from '@/features/groups/GroupSettingsPage'
import { RecipeDetailPage } from '@/features/recipes/RecipeDetailPage'
import { CookModePage } from '@/features/recipes/cook/CookModePage'
import { RecipeFormPage } from '@/features/recipes/RecipeFormPage'
import { ImportListPage } from '@/features/imports/ImportListPage'
import { ImportUrlPage } from '@/features/imports/ImportUrlPage'
import { ImportPhotosPage } from '@/features/imports/ImportPhotosPage'
import { ImportProgressPage } from '@/features/imports/ImportProgressPage'
import { ChatPage } from '@/features/chat/ChatPage'
import { ChatIndexRedirect } from '@/features/chat/ChatIndexRedirect'
import { ChatRouteOutlet } from '@/features/chat/ChatRouteOutlet'
import { TagManagementPage } from '@/features/tagManagement/TagManagementPage'
import { MealPlanPage } from '@/features/mealplanning/MealPlanPage'
import { ShoppingListPage } from '@/features/shoppinglist/ShoppingListPage'
import { WochenplanStub } from '@/features/stubs/WochenplanStub'
import { ProfilStub } from '@/features/stubs/ProfilStub'
import { AiUsagePage } from '@/features/admin/AiUsagePage'

/**
 * Route table.
 *
 * - `AuthLayout` wraps the four unauthenticated pages; it owns the
 *   parchment dotted background scoped to auth flows only.
 * - `AppLayout` (DS3) wraps every protected page; it owns TopNav +
 *   BottomNav so Home, Gruppen, Rezepte, Wochenplan, Profil all share
 *   the shell without each page having to import the nav components.
 * - `ProtectedRoute` still guards the auth gate; the layout itself is
 *   dumb and just draws chrome.
 */
export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          <Route element={<AuthLayout />}>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/signup" element={<SignupPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
          </Route>

          <Route
            element={
              <ProtectedRoute>
                <AppLayout />
              </ProtectedRoute>
            }
          >
            <Route path="/" element={<HomePage />} />
            <Route path="/groups" element={<GroupsPage />} />
            {/*
              TABLET-1 — `GroupDetailPage` now owns the nested
              recipes/:recipeId child route so the detail view can
              render inside its split-pane right column at `md:+`.
              The `/recipes/new` and `/recipes/:recipeId/edit` flows
              stay as flat sibling routes because those are full-page
              forms with their own top bar — they should replace
              `<main>` entirely, not dock inside the split.
            */}
            <Route path="/groups/:id" element={<GroupDetailPage />}>
              <Route
                path="recipes/:recipeId"
                element={<RecipeDetailPage />}
              />
            </Route>
            <Route path="/groups/:groupId/settings" element={<GroupSettingsPage />} />
            <Route path="/groups/:groupId/tags" element={<TagManagementPage />} />
            <Route
              path="/groups/:groupId/mealplan/:weekStart/shopping-list"
              element={<ShoppingListPage />}
            />
            <Route
              path="/groups/:groupId/mealplan/:weekStart"
              element={<MealPlanPage />}
            />
            <Route path="/groups/:groupId/mealplan" element={<MealPlanPage />} />
            <Route
              path="/groups/:groupId/recipes/new"
              element={<RecipeFormPage mode="create" />}
            />
            <Route
              path="/groups/:groupId/recipes/:recipeId/edit"
              element={<RecipeFormPage mode="edit" />}
            />
            {/* BUG-010 — dashboard of the caller's recent imports. Must be
                registered BEFORE `/rezepte/import/:importId` so the static
                "" / "url" / "photos" paths do not get captured as the
                dynamic `:importId` route. */}
            <Route path="/rezepte/import" element={<ImportListPage />} />
            <Route path="/rezepte/import/url" element={<ImportUrlPage />} />
            <Route path="/rezepte/import/photos" element={<ImportPhotosPage />} />
            <Route
              path="/rezepte/import/:importId"
              element={<ImportProgressPage />}
            />
            {/* CR3 — /chat routes share a sessions-sidebar shell.
                `/chat` itself redirects to the newest session (or mints
                a fresh one when the user has none), and
                `/chat/:sessionId` is the actual chat surface. Both
                mount inside <ChatRouteOutlet /> which owns the
                <ChatSessionsShell>. */}
            <Route path="/chat" element={<ChatRouteOutlet />}>
              <Route index element={<ChatIndexRedirect />} />
              <Route path=":sessionId" element={<ChatPage />} />
            </Route>
            <Route path="/wochenplan" element={<WochenplanStub />} />
            <Route path="/profil" element={<ProfilStub />} />
          </Route>

          {/*
            COOK-0 — "Jetzt kochen"-Modus lives OUTSIDE <AppLayout /> so
            the shared TopNav + BottomNav don't render on top of the
            immersive cook stage. The page still needs auth + group
            membership, so we wrap it in <ProtectedRoute> directly. The
            CookModePage provides its own `fixed inset-0 flex flex-col`
            scaffold.
          */}
          <Route
            element={
              <ProtectedRoute>
                <Outlet />
              </ProtectedRoute>
            }
          >
            <Route
              path="/groups/:groupId/recipes/:recipeId/cook"
              element={<CookModePage />}
            />
          </Route>

          {/*
            Admin-only KI-Verbrauch dashboard. Non-admin authenticated
            visitors redirect to `/` via ProtectedRoute requireAdmin;
            anonymous visitors still bounce to /login.
          */}
          <Route
            element={
              <ProtectedRoute requireAdmin>
                <AppLayout />
              </ProtectedRoute>
            }
          >
            <Route path="/admin/ai-usage" element={<AiUsagePage />} />
          </Route>

          {/*
            DS7: the catch-all now renders a real 404 page. Previously
            it silently redirected to `/`, which hid typos in deep-links
            that had been shared in chat. A dedicated page tells the
            user something went wrong and offers a clear route home.
          */}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  )
}
