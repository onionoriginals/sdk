/**
 * Query Client Configuration - Turnkey Migration
 * Uses HTTP-only cookies for authentication (no client-side token management)
 * Cookies are automatically sent with all requests via credentials: 'include'
 */

import { QueryClient, QueryFunction } from "@tanstack/react-query";

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

/**
 * API Request Helper
 * CRITICAL PR #102: Uses credentials: 'include' to send HTTP-only cookies
 * No Authorization header needed - cookies sent automatically!
 */
export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  // Check if data is FormData to handle file uploads
  const isFormData = data instanceof FormData;

  const headers: Record<string, string> = {
    // Don't set Content-Type for FormData (browser will set it with boundary)
    ...(data && !isFormData ? { "Content-Type": "application/json" } : {}),
  };

  const res = await fetch(url, {
    method,
    headers,
    // Don't JSON.stringify FormData
    body: data ? (isFormData ? data as FormData : JSON.stringify(data)) : undefined,
    credentials: "include", // CRITICAL: Sends HTTP-only cookies!
  });

  await throwIfResNotOk(res);
  return res;
}

/**
 * Query Function Generator
 * CRITICAL PR #102: Uses credentials: 'include' to send HTTP-only cookies
 */
type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(queryKey.join("/") as string, {
      credentials: "include", // CRITICAL: Sends HTTP-only cookies!
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
