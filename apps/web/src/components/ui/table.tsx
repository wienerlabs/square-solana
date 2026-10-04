import type { ReactNode } from 'react';

export interface Column<Row> {
  key: string;
  header: string;
  cell: (row: Row) => ReactNode;
  align?: 'left' | 'right';
}

export interface TableProps<Row> {
  /** Tablonun adı: ekran okuyucuya `caption`, kaydırma bölgesine etiket olur. */
  caption: string;
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  /** Satır yokken gösterilen metin. */
  empty: ReactNode;
}

export function Table<Row>({ caption, columns, rows, rowKey, empty }: TableProps<Row>) {
  const align = (column: Column<Row>) => (column.align === 'right' ? 'text-right' : 'text-left');
  return (
    // Dar ekranda yatay kaydırılır; klavyeyle kaydırılabilmesi için bölge odaklanabilir.
    <div role="region" aria-label={caption} tabIndex={0} className="overflow-x-auto rounded-card border border-border">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-surface-muted">
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={`px-4 py-2.5 font-medium text-muted ${align(column)}`}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr className="border-t border-border">
              <td colSpan={columns.length} className="px-4 py-6 text-center text-muted">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={rowKey(row)} className="border-t border-border">
                {columns.map((column) => (
                  <td key={column.key} className={`px-4 py-2.5 ${align(column)}`}>
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
