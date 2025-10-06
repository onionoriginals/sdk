import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import type { AssetLayer } from "../../../shared/schema";

interface LayerFilterProps {
  value: AssetLayer | 'all';
  onChange: (layer: AssetLayer | 'all') => void;
}

const filterOptions: Array<{ value: AssetLayer | 'all'; label: string; icon: string }> = [
  { value: 'all', label: 'All Assets', icon: '📦' },
  { value: 'did:peer', label: 'Private (did:peer)', icon: '🔒' },
  { value: 'did:webvh', label: 'Published (did:webvh)', icon: '🌐' },
  { value: 'did:btco', label: 'Inscribed (did:btco)', icon: '⛓️' }
];

export function LayerFilter({ value, onChange }: LayerFilterProps) {
  return (
    <div className="w-full sm:w-64">
      <Select value={value} onValueChange={(val) => onChange(val as AssetLayer | 'all')}>
        <SelectTrigger className="border-gray-200 focus:border-gray-400 rounded-sm">
          <SelectValue placeholder="Filter by layer" />
        </SelectTrigger>
        <SelectContent>
          {filterOptions.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              <span className="flex items-center gap-2">
                <span>{option.icon}</span>
                <span>{option.label}</span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
