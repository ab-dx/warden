import {
  CellStyleModule,
  ClientSideRowModelModule,
  type ColDef,
  ModuleRegistry,
  PaginationModule,
  QuickFilterModule,
  TextFilterModule,
  themeQuartz,
} from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useState } from 'react';
import type { Call } from './api.js';
import { ago, checkName, money, STATUS, toolName } from './format.js';

ModuleRegistry.registerModules([
  ClientSideRowModelModule,
  TextFilterModule,
  QuickFilterModule,
  PaginationModule,
  CellStyleModule,
]);

// the dashboard's paper and ink, so the grid reads as part of the page
const theme = themeQuartz.withParams({
  fontFamily: 'inherit',
  fontSize: 15,
  backgroundColor: '#f6f8f2',
  chromeBackgroundColor: '#e6ece3',
  foregroundColor: '#1b2440',
  headerTextColor: '#56607a',
  borderColor: '#b9c6bc',
  accentColor: '#23407a',
  rowHoverColor: '#edf1e8',
  borderRadius: 0,
  wrapperBorderRadius: 0,
  wrapperBorder: false,
  headerFontWeight: 400,
});

// cents from a two-decimal money string, so sorting never goes through floats
const cents = (c?: Call) => (c?.amount ? BigInt(c.amount.value.replace('.', '')) : -1n);
const statusLabel = (c: Call) =>
  c.status === 'received' && (c.tier === 'TIER_READ' || c.tier === 'TIER_WRITE')
    ? 'Passed through'
    : (STATUS[c.status]?.label ?? c.status);
const layers = (c: Call) =>
  [...new Set((c.reasons ?? []).map((r) => checkName(r.check)))].join(', ');

// rows undefined while loading, so the grid shows its loading overlay rather than "no calls"
export function ActivityGrid({
  rows,
  open,
}: {
  rows: Call[] | undefined;
  open: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const cols: ColDef<Call>[] = [
    {
      headerName: 'When',
      flex: 1,
      minWidth: 90,
      valueGetter: ({ data }) => data?.receivedAt ?? data?.updatedAt ?? '',
      cellRenderer: ({ value }: { value: string }) => ago(value),
      sort: 'desc',
      filter: false,
    },
    {
      headerName: 'Action',
      flex: 1,
      minWidth: 120,
      valueGetter: ({ data }) => toolName(data?.tool ?? 'unknown'),
      cellRenderer: ({ value, data }: { value: string; data?: Call }) => (
        <button
          type="button"
          onClick={() => data && open(data.callId)}
          className="text-blue underline-offset-2 hover:underline"
        >
          {value}
        </button>
      ),
    },
    { headerName: 'Agent', hide: true, flex: 1, minWidth: 105, field: 'agentId' },
    { headerName: 'Payee or reference', flex: 3, minWidth: 170, field: 'counterparty' },
    {
      headerName: 'Amount',
      flex: 1,
      minWidth: 100,
      valueGetter: ({ data }) => (data?.amount ? money(data.amount) : ''),
      comparator: (_a, _b, x, y) => {
        const d = cents(x.data) - cents(y.data);
        return d > 0n ? 1 : d < 0n ? -1 : 0;
      },
      type: 'rightAligned',
    },
    {
      headerName: 'Result',
      flex: 1,
      minWidth: 140,
      valueGetter: ({ data }) => (data ? statusLabel(data) : ''),
      cellRenderer: ({ value, data }: { value: string; data?: Call }) => (
        <span className={`font-medium ${STATUS[data?.status ?? '']?.tone ?? 'text-ink-soft'}`}>
          {value}
        </span>
      ),
    },
    {
      headerName: 'Stopped by',
      flex: 2,
      minWidth: 150,
      valueGetter: ({ data }) => (data ? layers(data) : ''),
    },
    {
      headerName: 'Reason codes',
      hide: true,
      flex: 2,
      minWidth: 150,
      valueGetter: ({ data }) => (data?.reasons ?? []).map((r) => r.code).join(' '),
    },
  ];
  return (
    <div className="space-y-3">
      <label className="block max-w-sm text-sm text-ink-soft">
        Search
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Payee, reason code or check"
          className="mt-1 w-full border border-rule bg-sheet px-3 py-2 text-ink"
        />
      </label>
      <AgGridReact<Call>
        theme={theme}
        rowData={rows ?? null}
        loading={rows === undefined}
        columnDefs={cols}
        defaultColDef={{ filter: 'agTextColumnFilter', sortable: true, resizable: true }}
        getRowId={({ data }) => data.callId}
        quickFilterText={search}
        // agent and reason codes stay out of the way but are still found by search
        includeHiddenColumnsInQuickFilter
        domLayout="autoHeight"
        pagination
        paginationPageSize={20}
        paginationPageSizeSelector={false}
        suppressCellFocus
        overlayNoRowsTemplate="No calls yet."
      />
    </div>
  );
}
