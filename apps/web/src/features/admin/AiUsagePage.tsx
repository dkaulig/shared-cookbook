import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import type { AiUsageGroupBy, AiUsageSummary } from '@shared-cookbook/shared'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { fetchAiUsage } from './aiUsageApi'

/**
 * Admin dashboard — `/admin/ai-usage`. Admin-only (guarded at the
 * route level via `ProtectedRoute requireAdmin`).
 *
 * Surface:
 * - Period picker (last 7d / 30d / 90d / custom).
 * - Grand totals card (prompt / completion / cached tokens, EUR).
 * - Per-model breakdown table (by default).
 * - Per-user breakdown via the groupBy picker.
 * - Raw CSS horizontal bars next to each row for a quick visual
 *   comparison — we deliberately avoid pulling recharts in since it's
 *   not already a dependency and a stacked bar over a 1-axis
 *   breakdown is easily rendered with `width: N%` on a div.
 */

type PeriodKey = '7d' | '30d' | '90d' | 'custom'

interface PeriodRange {
  /** ISO UTC-Z timestamp, inclusive lower bound. `undefined` = no
   * lower bound (send no `from=` query param). */
  from?: string
  /** ISO UTC-Z timestamp, inclusive upper bound. */
  to?: string
}

export function AiUsagePage() {
  const { t } = useTranslation()
  const [period, setPeriod] = useState<PeriodKey>('30d')
  const [groupBy, setGroupBy] = useState<AiUsageGroupBy>('model')
  const [customFrom, setCustomFrom] = useState<string>('')
  const [customTo, setCustomTo] = useState<string>('')

  const range = useMemo<PeriodRange>(
    () => resolveRange(period, customFrom, customTo),
    [period, customFrom, customTo],
  )

  const query = useQuery<AiUsageSummary>({
    queryKey: ['admin-ai-usage', range.from, range.to, groupBy] as const,
    queryFn: () =>
      fetchAiUsage({
        from: range.from,
        to: range.to,
        groupBy,
      }),
  })

  return (
    <section
      className="mx-auto w-full max-w-5xl px-5 py-10 md:px-8 md:py-14"
      aria-labelledby="ai-usage-heading"
    >
      <header className="mb-6">
        <h1
          id="ai-usage-heading"
          className="font-serif text-[clamp(30px,7vw,40px)] font-semibold leading-[1.05] tracking-[-0.015em]"
        >
          {t('admin.aiUsage.heading')}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t('admin.aiUsage.description')}
        </p>
      </header>

      <PeriodPicker
        period={period}
        onPeriodChange={setPeriod}
        customFrom={customFrom}
        customTo={customTo}
        onCustomFromChange={setCustomFrom}
        onCustomToChange={setCustomTo}
      />

      <GroupByPicker value={groupBy} onChange={setGroupBy} />

      {query.isLoading && (
        <p
          role="status"
          aria-live="polite"
          className="mt-6 text-sm text-muted-foreground"
        >
          {t('admin.aiUsage.loading')}
        </p>
      )}

      {query.isError && (
        <p
          role="alert"
          className="mt-6 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
        >
          {t('admin.aiUsage.loadError')}
        </p>
      )}

      {query.data && <TotalsCard summary={query.data} />}
      {query.data && <BreakdownCard summary={query.data} />}
    </section>
  )
}

// ── Period picker ───────────────────────────────────────────────────

interface PeriodPickerProps {
  period: PeriodKey
  onPeriodChange: (p: PeriodKey) => void
  customFrom: string
  customTo: string
  onCustomFromChange: (v: string) => void
  onCustomToChange: (v: string) => void
}

function PeriodPicker({
  period,
  onPeriodChange,
  customFrom,
  customTo,
  onCustomFromChange,
  onCustomToChange,
}: PeriodPickerProps) {
  const { t } = useTranslation()
  return (
    <div
      role="group"
      aria-label={t('admin.aiUsage.periodGroupAria')}
      className="mb-4 flex flex-wrap items-center gap-2"
    >
      {(['7d', '30d', '90d', 'custom'] as const).map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onPeriodChange(p)}
          aria-pressed={period === p}
          className={[
            'rounded-md border px-3 py-1.5 text-sm transition-colors',
            period === p
              ? 'border-foreground bg-foreground text-background'
              : 'border-input bg-background hover:bg-accent',
          ].join(' ')}
        >
          {periodLabel(t, p)}
        </button>
      ))}
      {period === 'custom' && (
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <label className="flex items-center gap-2 text-sm">
            {t('admin.aiUsage.periodFrom')}
            <input
              type="date"
              value={customFrom}
              onChange={(e) => onCustomFromChange(e.target.value)}
              className="rounded-md border border-input bg-background px-2 py-1 text-sm"
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            {t('admin.aiUsage.periodTo')}
            <input
              type="date"
              value={customTo}
              onChange={(e) => onCustomToChange(e.target.value)}
              className="rounded-md border border-input bg-background px-2 py-1 text-sm"
            />
          </label>
        </div>
      )}
    </div>
  )
}

type TFn = ReturnType<typeof useTranslation>['t']

function periodLabel(t: TFn, p: PeriodKey): string {
  switch (p) {
    case '7d':
      return t('admin.aiUsage.period7d')
    case '30d':
      return t('admin.aiUsage.period30d')
    case '90d':
      return t('admin.aiUsage.period90d')
    case 'custom':
      return t('admin.aiUsage.periodCustom')
  }
}

// ── GroupBy picker ──────────────────────────────────────────────────

function GroupByPicker({
  value,
  onChange,
}: {
  value: AiUsageGroupBy
  onChange: (g: AiUsageGroupBy) => void
}) {
  const { t } = useTranslation()
  return (
    <div
      role="group"
      aria-label={t('admin.aiUsage.groupByAria')}
      className="mb-6 flex items-center gap-2"
    >
      <span className="text-sm text-muted-foreground">
        {t('admin.aiUsage.groupByLabel')}
      </span>
      {(['model', 'user', 'day'] as const).map((g) => (
        <button
          key={g}
          type="button"
          onClick={() => onChange(g)}
          aria-pressed={value === g}
          className={[
            'rounded-md border px-3 py-1 text-sm transition-colors',
            value === g
              ? 'border-foreground bg-foreground text-background'
              : 'border-input bg-background hover:bg-accent',
          ].join(' ')}
        >
          {groupByLabel(t, g)}
        </button>
      ))}
    </div>
  )
}

function groupByLabel(t: TFn, g: AiUsageGroupBy): string {
  switch (g) {
    case 'model':
      return t('admin.aiUsage.groupByModel')
    case 'user':
      return t('admin.aiUsage.groupByUser')
    case 'day':
      return t('admin.aiUsage.groupByDay')
  }
}

// ── Totals card ─────────────────────────────────────────────────────

function TotalsCard({ summary }: { summary: AiUsageSummary }) {
  const { t } = useTranslation()
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>{t('admin.aiUsage.totalsTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <Stat
            label={t('admin.aiUsage.promptTokens')}
            value={formatInt(summary.totalPromptTokens)}
          />
          <Stat
            label={t('admin.aiUsage.completionTokens')}
            value={formatInt(summary.totalCompletionTokens)}
          />
          <Stat
            label={t('admin.aiUsage.cachedTokens')}
            value={formatInt(summary.totalCachedTokens)}
          />
          <Stat
            label={t('admin.aiUsage.costEur')}
            value={formatCurrencyEur(summary.totalEur)}
          />
        </dl>
      </CardContent>
    </Card>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-serif text-xl font-semibold">{value}</dd>
    </div>
  )
}

// ── Breakdown card ──────────────────────────────────────────────────

function BreakdownCard({ summary }: { summary: AiUsageSummary }) {
  const { t } = useTranslation()
  const maxEur = summary.groups.reduce((m, row) => Math.max(m, row.eur), 0)
  const byLabel = groupByLabel(t, summary.groupBy)

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {t('admin.aiUsage.breakdownTitleTemplate', { by: byLabel })}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {summary.groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('admin.aiUsage.breakdownEmpty')}
          </p>
        ) : (
          <table
            className="w-full text-sm"
            aria-label={t('admin.aiUsage.breakdownAriaTemplate', {
              by: byLabel,
            })}
          >
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th scope="col" className="py-2 pr-3 font-medium">
                  {byLabel}
                </th>
                <th scope="col" className="py-2 pr-3 font-medium text-right">
                  {t('admin.aiUsage.colPrompt')}
                </th>
                <th scope="col" className="py-2 pr-3 font-medium text-right">
                  {t('admin.aiUsage.colCompletion')}
                </th>
                <th scope="col" className="py-2 pr-3 font-medium text-right">
                  {t('admin.aiUsage.colEur')}
                </th>
                <th scope="col" className="py-2 font-medium text-right">
                  {t('admin.aiUsage.colShare')}
                </th>
              </tr>
            </thead>
            <tbody>
              {summary.groups.map((row) => (
                <tr key={row.key} className="border-b last:border-0">
                  <td className="py-2 pr-3 font-medium">{row.key}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {formatInt(row.promptTokens)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {formatInt(row.completionTokens)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {formatCurrencyEur(row.eur)}
                  </td>
                  <td className="py-2" aria-hidden="true">
                    <div
                      className="h-2 rounded bg-stone-200"
                      style={{ minWidth: '40px' }}
                    >
                      <div
                        className="h-full rounded bg-foreground"
                        style={{
                          width: `${maxEur > 0 ? Math.round((row.eur / maxEur) * 100) : 0}%`,
                        }}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  )
}

// ── Range resolution ────────────────────────────────────────────────

function resolveRange(
  period: PeriodKey,
  customFrom: string,
  customTo: string,
): PeriodRange {
  if (period === 'custom') {
    return {
      // `<input type="date">` yields `YYYY-MM-DD`; extend to the full day
      // boundary so "from 2026-04-01 to 2026-04-01" includes that day.
      from: customFrom ? `${customFrom}T00:00:00Z` : undefined,
      to: customTo ? `${customTo}T23:59:59Z` : undefined,
    }
  }
  const days = period === '7d' ? 7 : period === '30d' ? 30 : 90
  const now = new Date()
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  return {
    from: from.toISOString(),
    to: now.toISOString(),
  }
}

// ── Formatters ──────────────────────────────────────────────────────

function formatInt(n: number): string {
  return new Intl.NumberFormat('de-DE').format(n)
}

function formatCurrencyEur(n: number): string {
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 2,
  }).format(n)
}
