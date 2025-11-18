/**
 * Top bar for the dual-pane explorer
 * Contains breadcrumbs, search, and action buttons
 */

import { useState } from 'react';
import { useLocation } from 'wouter';
import {
  Search,
  RefreshCw,
  FolderPlus,
  Upload,
  LayoutGrid,
  LayoutList,
  SlidersHorizontal,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import { ViewMode, SortField, SortOrder } from './types';

interface ExplorerTopBarProps {
  currentPath: string[];
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  onRefresh: () => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  sortField: SortField;
  sortOrder: SortOrder;
  onSortChange: (field: SortField, order: SortOrder) => void;
}

export function ExplorerTopBar({
  currentPath,
  viewMode,
  onViewModeChange,
  onRefresh,
  searchQuery,
  onSearchChange,
  sortField,
  sortOrder,
  onSortChange,
}: ExplorerTopBarProps) {
  const [, navigate] = useLocation();

  return (
    <div className="border-b bg-background">
      {/* Main toolbar */}
      <div className="flex items-center gap-2 px-4 py-2">
        {/* Breadcrumbs */}
        <Breadcrumb className="flex-1">
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/" className="text-sm">
                Home
              </BreadcrumbLink>
            </BreadcrumbItem>
            {currentPath.map((segment, index) => (
              <div key={index} className="flex items-center gap-2">
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  {index === currentPath.length - 1 ? (
                    <BreadcrumbPage className="text-sm">{segment}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink href="#" className="text-sm">
                      {segment}
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              </div>
            ))}
          </BreadcrumbList>
        </Breadcrumb>

        {/* Search */}
        <div className="relative w-64">
          <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search assets..."
            className="pl-8 h-9"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>

        <Separator orientation="vertical" className="h-6" />

        {/* View mode toggle */}
        <div className="flex items-center gap-1 rounded-md border p-1">
          <Button
            variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => onViewModeChange('grid')}
          >
            <LayoutGrid className="h-4 w-4" />
          </Button>
          <Button
            variant={viewMode === 'list' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => onViewModeChange('list')}
          >
            <LayoutList className="h-4 w-4" />
          </Button>
        </div>

        {/* Sort dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-9">
              <SlidersHorizontal className="h-4 w-4 mr-2" />
              Sort
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel>Sort by</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onSortChange('title', sortOrder)}
              className={sortField === 'title' ? 'bg-accent' : ''}
            >
              Name {sortField === 'title' && (sortOrder === 'asc' ? '↑' : '↓')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => onSortChange('updatedAt', sortOrder)}
              className={sortField === 'updatedAt' ? 'bg-accent' : ''}
            >
              Date Modified {sortField === 'updatedAt' && (sortOrder === 'asc' ? '↑' : '↓')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => onSortChange('type', sortOrder)}
              className={sortField === 'type' ? 'bg-accent' : ''}
            >
              Type {sortField === 'type' && (sortOrder === 'asc' ? '↑' : '↓')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onSortChange(sortField, sortOrder === 'asc' ? 'desc' : 'asc')}
            >
              {sortOrder === 'asc' ? 'Descending' : 'Ascending'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Separator orientation="vertical" className="h-6" />

        {/* Action buttons */}
        <Button variant="ghost" size="sm" className="h-9" onClick={onRefresh}>
          <RefreshCw className="h-4 w-4" />
        </Button>

        <Button
          variant="outline"
          size="sm"
          className="h-9"
          onClick={() => navigate('/create')}
        >
          <FolderPlus className="h-4 w-4 mr-2" />
          New Asset
        </Button>

        <Button
          variant="outline"
          size="sm"
          className="h-9"
          onClick={() => navigate('/upload-assets')}
        >
          <Upload className="h-4 w-4 mr-2" />
          Upload
        </Button>
      </div>
    </div>
  );
}
