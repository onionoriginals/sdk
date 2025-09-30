import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { type SpreadsheetColumn } from "./columns";

type SpreadsheetViewProps<T extends { id: string }> = {
  columns: SpreadsheetColumn<T>[];
  rows: T[];
  className?: string;
  onRowClick?: (row: T) => void;
};

export function SpreadsheetView<T extends { id: string }>({ columns, rows, className, onRowClick }: SpreadsheetViewProps<T>) {
  return (
    <div className={cn("bg-white border border-gray-200 rounded-sm", className)}>
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((col) => (
              <TableHead key={col.key} className={cn(col.align === 'right' && 'text-right', col.align === 'center' && 'text-center')} style={{ width: col.width }}>
                {col.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={columns.length} className="text-center text-gray-500">
                No assets
              </TableCell>
            </TableRow>
          )}
          {rows.map((row) => (
            <TableRow key={row.id} className={cn(onRowClick && 'cursor-pointer')} onClick={() => onRowClick?.(row)}>
              {columns.map((col) => (
                <TableCell key={col.key} className={cn(col.align === 'right' && 'text-right', col.align === 'center' && 'text-center')}>
                  {col.accessor ? col.accessor(row) : (col.field ? (row as any)[col.field] : null)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export default SpreadsheetView;


