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
  backgroundColor: '#f8faf8',
  chromeBackgroundColor: '#edf1ee',
  foregroundColor: '#1d2a3a',
  headerTextColor: '#5a6977',
  borderColor: '#c7d1cc',
  accentColor: '#2445a0',
  rowHoverColor: '#e6ece8',
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

export function ActivityGrid({ rows, open }: { rows: Call[]; open: (id: string) => void }) {
  const [search, setSearch] = useState('');
  const cols: ColDef<Call>[] = [
    {
      headerName: 'When',
      flex: 1,
      minWidth: 95,
      valueGetter: ({ data }) => data?.receivedAt ?? data?.updatedAt ?? '',
      cellRenderer: ({ value }: { value: string }) => ago(value),
      sort: 'desc',
      filter: false,
    },
    {
      headerName: 'Action',
      flex: 1,
      minWidth: 95,
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
    { headerName: 'Payee or reference', flex: 3, minWidth: 180, field: 'counterparty' },
    {
      headerName: 'Amount',
      flex: 1,
      minWidth: 105,
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
      minWidth: 105,
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
        Search every column
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="a payee, a reason code, Provenance…"
          className="mt-1 w-full rounded-sm border border-rule bg-sheet px-3 py-2 text-ink"
        />
      </label>
      <AgGridReact<Call>
        theme={theme}
        rowData={rows}
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
        overlayNoRowsTemplate="Your agent hasn't made any calls yet."
      />
    </div>
  );
}
