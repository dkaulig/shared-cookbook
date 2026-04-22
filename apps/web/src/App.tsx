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
import { MealPlanSlotDetailPage } from '@/features/mealplanning/MealPlanSlotDetailPage'
import { ShoppingListPage } from '@/features/shoppinglist/ShoppingListPage'
import { SearchPage } from '@/features/search/SearchPage'
import { WochenplanStub } from '@/features/stubs/WochenplanStub'
import { ProfilStub } from '@/features/stubs/ProfilStub'
import { AiUsagePage } from '@/features/admin/AiUsagePage'
import { ExtractorConfigPage } from '@/features/admin/ExtractorConfigPage'
import { ShareTargetPage } from '@/features/share/ShareTargetPage'

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
            {/* 2026-04-22 nav-bug fix — parent route renamed from
                `:id` to `:groupId` so the nested `recipes/:recipeId`
                child's `useParams<{ groupId: string; recipeId: string }>()`
                actually sees the group id. Without this rename the child
                read `params.groupId = undefined`, coerced to empty
                string, and the header's Zurück-button fired
                `navigate("/groups/" + "")` which resolved to `/groups`
                (the groups-list) instead of `/groups/:g` (the group's
                recipe list). */}
            <Route path="/groups/:groupId" element={<GroupDetailPage />}>
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
            {/*
              TABLET-2 — MealPlan now owns a nested `slots/:slotId` child
              that renders inside the SplitPane's right column at md:+.
              The flat `/mealplan` (no weekStart) route has NO nested
              children because it immediately <Navigate>s to the current
              Monday, so there's no point in mounting an empty Outlet
              for a URL the user never actually sees.
            */}
            <Route
              path="/groups/:groupId/mealplan/:weekStart"
              element={<MealPlanPage />}
            >
              <Route
                path="slots/:slotId"
                element={<MealPlanSlotDetailPage />}
              />
            </Route>
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
            <Route path="/suche" element={<SearchPage />} />
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
            <Route
              path="/admin/extractor"
              element={<ExtractorConfigPage />}
            />
          </Route>

          {/*
            SHARE-0 — iOS PWA Web Share Target entry point. MUST stay
            OUTSIDE the ProtectedRoute wrapper so the page itself can
            craft a `/login?next=/share-target?…` redirect that
            preserves the original share payload across login. The page
            calls `useSession()` on mount to rehydrate silent-refresh,
            then either bounces to `/login?next=…`, redirects to the
            `/rezepte/import/url` flow with the extracted URL, or
            renders a German empty-state when no usable link was in
            the payload.
          */}
          <Route path="/share-target" element={<ShareTargetPage />} />

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
