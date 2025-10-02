import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";

type PropertyType = "text" | "number" | "boolean" | "date" | "select";

type AssetProperty = {
  id: string;
  key: string;
  label: string;
  type: PropertyType;
  required?: boolean;
  options?: string[]; // for select
};

type AssetTypeConfig = {
  id: string;
  name: string;
  description?: string;
  properties: AssetProperty[];
};

const STORAGE_KEY = "originals-asset-types";

function readConfigs(): AssetTypeConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeConfigs(configs: AssetTypeConfig[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(configs));
  window.dispatchEvent(new CustomEvent("originals-asset-types-updated"));
}

export default function Setup() {
  const [configs, setConfigs] = useState<AssetTypeConfig[]>(() => readConfigs());
  const [selectedTypeId, setSelectedTypeId] = useState<string | null>(configs[0]?.id || null);

  useEffect(() => {
    const handle = () => setConfigs(readConfigs());
    window.addEventListener("storage", handle);
    window.addEventListener("originals-asset-types-updated", handle as EventListener);
    return () => {
      window.removeEventListener("storage", handle);
      window.removeEventListener("originals-asset-types-updated", handle as EventListener);
    };
  }, []);

  const selected = useMemo(() => configs.find(c => c.id === selectedTypeId) || null, [configs, selectedTypeId]);

  const addAssetType = () => {
    const id = `type_${Date.now()}`;
    const next: AssetTypeConfig = { id, name: "New Type", description: "", properties: [] };
    const updated = [next, ...configs];
    setConfigs(updated);
    writeConfigs(updated);
    setSelectedTypeId(id);
  };

  const removeAssetType = (id: string) => {
    const updated = configs.filter(c => c.id !== id);
    setConfigs(updated);
    writeConfigs(updated);
    if (selectedTypeId === id) {
      setSelectedTypeId(null);
    }
  };

  const updateSelected = (updates: Partial<AssetTypeConfig>) => {
    if (!selected) return;
    const updated = configs.map(c => (c.id === selected.id ? { ...c, ...updates } : c));
    setConfigs(updated);
    writeConfigs(updated);
  };

  const addProperty = () => {
    if (!selected) return;
    const prop: AssetProperty = {
      id: `prop_${Date.now()}`,
      key: `prop_${selected.properties.length + 1}`,
      label: "New Property",
      type: "text",
      required: false,
      options: [],
    };
    updateSelected({ properties: [prop, ...selected.properties] });
  };

  const updateProperty = (propId: string, updates: Partial<AssetProperty>) => {
    if (!selected) return;
    const properties = selected.properties.map(p => (p.id === propId ? { ...p, ...updates } : p));
    updateSelected({ properties });
  };

  const removeProperty = (propId: string) => {
    if (!selected) return;
    updateSelected({ properties: selected.properties.filter(p => p.id !== propId) });
  };

  return (
    <main className="max-w-6xl mx-auto px-8 py-8">
      <div className="mb-6">
        <h1 className="page-title">Setup</h1>
        <p className="text-gray-500 text-sm">Configure asset types and their properties</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-1">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Asset Types</CardTitle>
            <Button size="sm" onClick={addAssetType}>Add</Button>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {configs.length === 0 && (
                <div className="text-sm text-gray-500">No types yet. Create one to begin.</div>
              )}
              {configs.map((c) => (
                <div key={c.id} className={`flex items-center justify-between border rounded px-3 py-2 ${selectedTypeId === c.id ? 'border-gray-900' : 'border-gray-200'}`}>
                  <button className="text-left flex-1 mr-2 truncate" onClick={() => setSelectedTypeId(c.id)}>
                    <div className="text-sm font-medium truncate">{c.name || 'Untitled'}</div>
                    <div className="text-xs text-gray-500 truncate">{c.description || '—'}</div>
                  </button>
                  <Button variant="outline" size="sm" onClick={() => removeAssetType(c.id)}>Delete</Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <div className="lg:col-span-2">
          {!selected ? (
            <Card>
              <CardHeader>
                <CardTitle>Details</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-sm text-gray-500">Select an asset type to edit its details.</div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Type Details</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <Label htmlFor="name">Name</Label>
                      <Input id="name" value={selected.name} onChange={(e) => updateSelected({ name: e.target.value })} placeholder="e.g., Original, Migrated, Artwork" />
                    </div>
                    <div>
                      <Label htmlFor="description">Description</Label>
                      <Input id="description" value={selected.description || ''} onChange={(e) => updateSelected({ description: e.target.value })} placeholder="Optional" />
                    </div>
                  </div>

                  <Separator />

                  <div className="flex items-center justify-between">
                    <div className="font-medium">Properties</div>
                    <Button size="sm" onClick={addProperty}>Add Property</Button>
                  </div>

                  <div className="space-y-3">
                    {selected.properties.length === 0 && (
                      <div className="text-sm text-gray-500">No properties yet. Add one to capture metadata.</div>
                    )}

                    {selected.properties.map((p) => (
                      <div key={p.id} className="border rounded p-3">
                        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
                          <div>
                            <Label htmlFor={`label_${p.id}`}>Label</Label>
                            <Input id={`label_${p.id}`} value={p.label} onChange={(e) => updateProperty(p.id, { label: e.target.value })} placeholder="e.g., Edition" />
                          </div>
                          <div>
                            <Label htmlFor={`key_${p.id}`}>Key</Label>
                            <Input id={`key_${p.id}`} value={p.key} onChange={(e) => updateProperty(p.id, { key: e.target.value })} placeholder="e.g., edition" />
                          </div>
                          <div>
                            <Label>Type</Label>
                            <Select value={p.type} onValueChange={(v) => updateProperty(p.id, { type: v as PropertyType })}>
                              <SelectTrigger>
                                <SelectValue placeholder="Select type" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="text">Text</SelectItem>
                                <SelectItem value="number">Number</SelectItem>
                                <SelectItem value="boolean">Boolean</SelectItem>
                                <SelectItem value="date">Date</SelectItem>
                                <SelectItem value="select">Select</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="flex gap-2">
                            <Button variant="outline" className="w-full" onClick={() => updateProperty(p.id, { required: !p.required })}>{p.required ? 'Required' : 'Optional'}</Button>
                            <Button variant="outline" className="w-full" onClick={() => removeProperty(p.id)}>Remove</Button>
                          </div>
                        </div>

                        {p.type === "select" && (
                          <div className="mt-3">
                            <Label>Options (comma separated)</Label>
                            <Input value={(p.options || []).join(", ")} onChange={(e) => updateProperty(p.id, { options: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })} placeholder="e.g., Small, Medium, Large" />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </main>
  );
}


