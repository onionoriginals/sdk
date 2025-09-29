import { QueryClient, QueryFunction } from "@tanstack/react-query";

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

// Global variable to store getAccessToken function
let globalGetAccessToken: (() => Promise<string>) | null = null;

export function setGlobalGetAccessToken(fn: () => Promise<string>) {
  globalGetAccessToken = fn;
}

// Get auth token from Privy
async function getAuthToken(): Promise<string | null> {
  if (!globalGetAccessToken) {
    return null;
  }
  
  try {
    return await globalGetAccessToken();
  } catch (error) {
    console.warn('Failed to get access token:', error);
    return null;
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const token = await getAuthToken();
  const headers: Record<string, string> = {
    ...(data ? { "Content-Type": "application/json" } : {}),
    ...(token ? { "Authorization": `Bearer ${token}` } : {}),
  };

  const res = await fetch(url, {
    method,
    headers,
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const token = await getAuthToken();
    const headers: Record<string, string> = {
      ...(token ? { "Authorization": `Bearer ${token}` } : {}),
    };

    const res = await fetch(queryKey.join("/") as string, {
      headers,
      credentials: "include",
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
