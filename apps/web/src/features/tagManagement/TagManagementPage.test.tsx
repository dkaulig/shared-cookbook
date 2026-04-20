import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { TagManagementPage } from './TagManagementPage'

/**
 * BUG-020 — `TagManagementPage` is now a Navigate-style redirect into
 * `/groups/:groupId/settings#tags`. The actual tag-CRUD UI lives in
 * `<GroupTagsPanel />`, mounted as the last section of the settings
 * page (covered by `GroupSettingsPage.test.tsx`).
 */

function LocationProbe() {
  const loc = useLocation()
  return (
    <div data-testid="location-probe">
      {loc.pathname}
      {loc.hash}
    </div>
  )
}

function renderRoute(initial: string) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/groups/:groupId/tags" element={<TagManagementPage />} />
        <Route
          path="/groups/:groupId/settings"
          element={
            <>
              <div data-testid="settings-page">settings</div>
              <LocationProbe />
            </>
          }
        />
        <Route
          path="/groups"
          element={
            <>
              <div data-testid="groups-list">groups</div>
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  )
}

describe('TagManagementPage redirect (BUG-020)', () => {
  it('redirects /groups/:id/tags to /groups/:id/settings#tags', () => {
    renderRoute('/groups/g1/tags')
    expect(screen.getByTestId('settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('location-probe')).toHaveTextContent(
      '/groups/g1/settings#tags',
    )
  })

  it('encodes the groupId path-param verbatim into the redirect target', () => {
    renderRoute('/groups/abc-123/tags')
    expect(screen.getByTestId('location-probe')).toHaveTextContent(
      '/groups/abc-123/settings#tags',
    )
  })
})
