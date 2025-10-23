import { ReactNode } from "react";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { OriginalsSidebar } from "./originals-sidebar";

interface OriginalsLayoutProps {
  children: ReactNode;
}

export function OriginalsLayout({ children }: OriginalsLayoutProps) {
  return (
    <SidebarProvider defaultOpen={true}>
      <div className="flex min-h-screen w-full">
        <OriginalsSidebar />
        <SidebarInset className="flex-1">
          <div className="flex flex-col h-full">
            {children}
          </div>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
