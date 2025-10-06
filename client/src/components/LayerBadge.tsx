import type { AssetLayer } from "../../../shared/schema";

interface LayerBadgeProps {
  layer: AssetLayer;
  size?: 'sm' | 'md' | 'lg';
  showIcon?: boolean;
}

const layerConfig = {
  'did:peer': {
    color: 'bg-gray-100 text-gray-700 border-gray-300',
    label: 'Private',
    icon: '🔒',
    description: 'Local, offline asset'
  },
  'did:webvh': {
    color: 'bg-blue-100 text-blue-700 border-blue-300',
    label: 'Published',
    icon: '🌐',
    description: 'Published on the web'
  },
  'did:btco': {
    color: 'bg-orange-100 text-orange-700 border-orange-300',
    label: 'Inscribed',
    icon: '⛓️',
    description: 'Inscribed on Bitcoin'
  }
};

const sizeClasses = {
  sm: 'text-xs px-2 py-0.5',
  md: 'text-sm px-3 py-1',
  lg: 'text-base px-4 py-1.5'
};

export function LayerBadge({ layer, size = 'md', showIcon = true }: LayerBadgeProps) {
  const config = layerConfig[layer];
  
  if (!config) {
    return null;
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-sm border font-medium ${config.color} ${sizeClasses[size]}`}
      title={config.description}
    >
      {showIcon && <span className="text-base leading-none">{config.icon}</span>}
      <span>{config.label}</span>
    </span>
  );
}
