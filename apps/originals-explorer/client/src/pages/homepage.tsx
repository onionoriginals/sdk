import { DualPaneExplorer } from "@/components/explorer";

export default function Homepage() {
  return (
    <div className="h-[calc(100vh-4rem)] w-full">
      <DualPaneExplorer />
    </div>
  );
}