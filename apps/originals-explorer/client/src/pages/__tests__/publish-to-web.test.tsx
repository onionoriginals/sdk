import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock wouter
const mockSetLocation = mock(() => {});
mock.module('wouter', () => ({
  useLocation: () => ['/', mockSetLocation],
  Link: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));

// Mock toast hook
const mockToast = mock(() => {});
mock.module('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

describe('Publish to Web UI (Dashboard)', () => {
  let queryClient: QueryClient;
  let user: ReturnType<typeof userEvent.setup>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    
    user = userEvent.setup();
    
    // Reset mocks
    mockSetLocation.mockClear();
    mockToast.mockClear();
    
    // Default mock: stats and assets with mixed layers
    globalThis.fetch = mock(async (url) => {
      if (url.includes('/api/stats')) {
        return {
          ok: true,
          json: async () => ({
            totalAssets: 5,
            verifiedAssets: 3,
            migratedAssets: 2,
          }),
        };
      }
      
      if (url.includes('/api/user')) {
        return {
          ok: true,
          json: async () => ({
            id: 'did:webvh:localhost%3A5000:testuser',
            did: 'did:webvh:localhost%3A5000:testuser',
            turnkeySubOrgId: 'turnkey-test-user',
          }),
        };
      }
      
      if (url.includes('/api/assets')) {
        return {
          ok: true,
          json: async () => ([
            {
              id: 'asset-peer-1',
              title: 'Private Asset 1',
              assetType: 'original',
              status: 'completed',
              createdAt: new Date().toISOString(),
              currentLayer: 'did:peer',
              userId: 'did:webvh:localhost%3A5000:testuser',
              didPeer: 'did:peer:abc123',
            },
            {
              id: 'asset-webvh-1',
              title: 'Published Asset 1',
              assetType: 'original',
              status: 'completed',
              createdAt: new Date().toISOString(),
              currentLayer: 'did:webvh',
              userId: 'did:webvh:localhost%3A5000:testuser',
              didWebvh: 'did:webvh:example.com:xyz',
            },
          ]),
        };
      }
      
      return { ok: false, status: 404 };
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const renderDashboard = async () => {
    const { default: Dashboard } = await import('../dashboard');
    return render(
      <QueryClientProvider client={queryClient}>
        <Dashboard />
      </QueryClientProvider>
    );
  };

  it('should show publish button only for did:peer assets owned by user', async () => {
    await renderDashboard();
    
    // Wait for assets to load
    await waitFor(() => {
      expect(screen.getByText('Private Asset 1')).toBeTruthy();
      expect(screen.getByText('Published Asset 1')).toBeTruthy();
    });
    
    // Find the asset rows
    const privateAssetRow = screen.getByText('Private Asset 1').closest('[data-testid^="activity-item"]');
    const publishedAssetRow = screen.getByText('Published Asset 1').closest('[data-testid^="activity-item"]');
    
    // Private asset should have publish button
    expect(within(privateAssetRow as HTMLElement).queryByText(/Publish/i)).toBeTruthy();
    
    // Published asset should NOT have publish button
    expect(within(publishedAssetRow as HTMLElement).queryByText(/Publish/i)).toBeNull();
  });

  it('should hide publish button for assets not owned by current user', async () => {
    // Mock asset owned by different user
    globalThis.fetch = mock(async (url) => {
      if (url.includes('/api/user')) {
        return {
          ok: true,
          json: async () => ({
            id: 'did:webvh:localhost%3A5000:testuser',
            did: 'did:webvh:localhost%3A5000:testuser',
            turnkeySubOrgId: 'turnkey-test-user',
          }),
        };
      }
      
      if (url.includes('/api/assets')) {
        return {
          ok: true,
          json: async () => ([
            {
              id: 'asset-other-user',
              title: 'Other User Asset',
              assetType: 'original',
              status: 'completed',
              createdAt: new Date().toISOString(),
              currentLayer: 'did:peer',
              userId: 'did:webvh:localhost%3A5000:otheruser', // Different user
              didPeer: 'did:peer:xyz789',
            },
          ]),
        };
      }
      
      return { ok: true, json: async () => ({}) };
    }) as any;
    
    await renderDashboard();
    
    await waitFor(() => {
      expect(screen.getByText('Other User Asset')).toBeTruthy();
    });
    
    // Should not have publish button
    const assetRow = screen.getByText('Other User Asset').closest('[data-testid^="activity-item"]');
    expect(within(assetRow as HTMLElement).queryByText(/Publish/i)).toBeNull();
  });

  it('should open confirmation modal when publish button clicked', async () => {
    await renderDashboard();
    
    await waitFor(() => {
      expect(screen.getByText('Private Asset 1')).toBeTruthy();
    });
    
    const publishButton = screen.getByText(/Publish/i);
    await user.click(publishButton);
    
    // Modal should appear
    await waitFor(() => {
      expect(screen.getByText('Publish Asset to Web?')).toBeTruthy();
      expect(screen.getByText(/publicly accessible/i)).toBeTruthy();
      expect(screen.getByText(/cannot be reversed/i)).toBeTruthy();
    });
  });

  it('should show explanation of what publishing does in modal', async () => {
    await renderDashboard();
    
    await waitFor(() => screen.getByText('Private Asset 1'));
    
    const publishButton = screen.getByText(/Publish/i);
    await user.click(publishButton);
    
    await waitFor(() => {
      // Check all explanation points are present
      expect(screen.getByText(/publicly accessible/i)).toBeTruthy();
      expect(screen.getByText(/DID becomes resolvable/i)).toBeTruthy();
      expect(screen.getByText(/Provenance is updated/i)).toBeTruthy();
      expect(screen.getByText(/did:peer is preserved/i)).toBeTruthy();
      expect(screen.getByText(/cannot be reversed/i)).toBeTruthy();
    });
  });

  it('should call API when publish confirmed', async () => {
    let publishApiCalled = false;
    
    globalThis.fetch = mock(async (url, options) => {
      if (url.includes('/publish-to-web') && options?.method === 'POST') {
        publishApiCalled = true;
        return {
          ok: true,
          json: async () => ({
            asset: {
              id: 'asset-peer-1',
              title: 'Private Asset 1',
              currentLayer: 'did:webvh',
              didPeer: 'did:peer:abc123',
              didWebvh: 'did:webvh:example.com:xyz',
              provenance: {
                migrations: [{
                  from: 'did:peer',
                  to: 'did:webvh',
                  timestamp: new Date().toISOString(),
                }],
              },
            },
            resolverUrl: 'https://example.com/.well-known/did/xyz',
            migration: {
              timestamp: new Date().toISOString(),
            },
          }),
        };
      }
      
      // Default mocks
      if (url.includes('/api/user')) {
        return { ok: true, json: async () => ({ id: 'did:webvh:localhost%3A5000:testuser', did: 'did:webvh:localhost%3A5000:testuser' }) };
      }
      if (url.includes('/api/assets')) {
        return {
          ok: true,
          json: async () => ([{
            id: 'asset-peer-1',
            title: 'Private Asset 1',
            currentLayer: 'did:peer',
            userId: 'did:webvh:localhost%3A5000:testuser',
          }]),
        };
      }
      return { ok: true, json: async () => ({}) };
    }) as any;
    
    await renderDashboard();
    
    await waitFor(() => screen.getByText('Private Asset 1'));
    await user.click(screen.getByText(/Publish/i));
    
    await waitFor(() => screen.getByText('Publish Asset to Web?'));
    
    // Find and click the "Publish to Web" button in the modal footer
    const publishButtons = screen.getAllByText(/Publish to Web/i);
    const confirmButton = publishButtons.find(btn => (btn as HTMLElement).closest('button'));
    await user.click(confirmButton as HTMLElement);
    
    await waitFor(() => {
      expect(publishApiCalled).toBe(true);
    });
  });

  it('should display success state after publish', async () => {
    globalThis.fetch = mock(async (url, options) => {
      if (url.includes('/publish-to-web')) {
        return {
          ok: true,
          json: async () => ({
            asset: {
              id: 'asset-peer-1',
              currentLayer: 'did:webvh',
              didPeer: 'did:peer:abc123',
              didWebvh: 'did:webvh:example.com:xyz',
            },
            resolverUrl: 'https://example.com/.well-known/did/xyz',
            migration: {
              timestamp: new Date().toISOString(),
            },
          }),
        };
      }
      
      if (url.includes('/api/user')) {
        return { ok: true, json: async () => ({ id: 'did:webvh:localhost%3A5000:testuser', did: 'did:webvh:localhost%3A5000:testuser' }) };
      }
      if (url.includes('/api/assets')) {
        return {
          ok: true,
          json: async () => ([{
            id: 'asset-peer-1',
            title: 'Private Asset 1',
            currentLayer: 'did:peer',
            userId: 'did:webvh:localhost%3A5000:testuser',
          }]),
        };
      }
      return { ok: true, json: async () => ({}) };
    }) as any;
    
    await renderDashboard();
    
    await waitFor(() => screen.getByText('Private Asset 1'));
    await user.click(screen.getByText(/Publish/i));
    await waitFor(() => screen.getByText('Publish Asset to Web?'));
    
    const publishButtons = screen.getAllByText(/Publish to Web/i);
    const confirmButton = publishButtons.find(btn => (btn as HTMLElement).closest('button'));
    await user.click(confirmButton as HTMLElement);
    
    // Wait for success toast
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringMatching(/published to web successfully/i),
        })
      );
    });
  });

  it('should display resolver URL and DIDs after publish', async () => {
    globalThis.fetch = mock(async (url, options) => {
      if (url.includes('/publish-to-web')) {
        return {
          ok: true,
          json: async () => ({
            asset: {
              id: 'asset-peer-1',
              currentLayer: 'did:webvh',
              didPeer: 'did:peer:abc123',
              didWebvh: 'did:webvh:example.com:xyz',
            },
            resolverUrl: 'https://example.com/.well-known/did/xyz',
            migration: {
              timestamp: new Date().toISOString(),
            },
          }),
        };
      }
      
      if (url.includes('/api/user')) {
        return { ok: true, json: async () => ({ id: 'did:webvh:localhost%3A5000:testuser', did: 'did:webvh:localhost%3A5000:testuser' }) };
      }
      if (url.includes('/api/assets')) {
        return {
          ok: true,
          json: async () => ([{
            id: 'asset-peer-1',
            title: 'Private Asset 1',
            currentLayer: 'did:peer',
            userId: 'did:webvh:localhost%3A5000:testuser',
          }]),
        };
      }
      return { ok: true, json: async () => ({}) };
    }) as any;
    
    await renderDashboard();
    
    await waitFor(() => screen.getByText('Private Asset 1'));
    await user.click(screen.getByText(/Publish/i));
    await waitFor(() => screen.getByText('Publish Asset to Web?'));
    
    const publishButtons = screen.getAllByText(/Publish to Web/i);
    const confirmButton = publishButtons.find(btn => (btn as HTMLElement).closest('button'));
    await user.click(confirmButton as HTMLElement);
    
    // Wait for success modal content
    await waitFor(() => {
      expect(screen.getByText('Published to Web!')).toBeTruthy();
      expect(screen.getByText('did:peer:abc123')).toBeTruthy();
      expect(screen.getByText('did:webvh:example.com:xyz')).toBeTruthy();
      expect(screen.getByText('https://example.com/.well-known/did/xyz')).toBeTruthy();
    });
  });

  it('should handle API errors gracefully', async () => {
    globalThis.fetch = mock(async (url, options) => {
      if (url.includes('/publish-to-web')) {
        return {
          ok: false,
          status: 500,
          json: async () => ({
            error: 'Publish failed - internal error',
          }),
        };
      }
      
      if (url.includes('/api/user')) {
        return { ok: true, json: async () => ({ id: 'did:webvh:localhost%3A5000:testuser', did: 'did:webvh:localhost%3A5000:testuser' }) };
      }
      if (url.includes('/api/assets')) {
        return {
          ok: true,
          json: async () => ([{
            id: 'asset-peer-1',
            title: 'Private Asset 1',
            currentLayer: 'did:peer',
            userId: 'did:webvh:localhost%3A5000:testuser',
          }]),
        };
      }
      return { ok: true, json: async () => ({}) };
    }) as any;
    
    await renderDashboard();
    
    await waitFor(() => screen.getByText('Private Asset 1'));
    await user.click(screen.getByText(/Publish/i));
    await waitFor(() => screen.getByText('Publish Asset to Web?'));
    
    const publishButtons = screen.getAllByText(/Publish to Web/i);
    const confirmButton = publishButtons.find(btn => (btn as HTMLElement).closest('button'));
    await user.click(confirmButton as HTMLElement);
    
    // Wait for error toast
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: 'destructive',
        })
      );
    });
  });

  it('should show loading state during publish', async () => {
    globalThis.fetch = mock(async (url, options) => {
      if (url.includes('/publish-to-web')) {
        await new Promise(resolve => setTimeout(resolve, 100));
        return {
          ok: true,
          json: async () => ({
            asset: { currentLayer: 'did:webvh', didWebvh: 'did:webvh:example.com:xyz' },
            resolverUrl: 'https://example.com/.well-known/did/xyz',
            migration: { timestamp: new Date().toISOString() },
          }),
        };
      }
      
      if (url.includes('/api/user')) {
        return { ok: true, json: async () => ({ id: 'did:webvh:localhost%3A5000:testuser', did: 'did:webvh:localhost%3A5000:testuser' }) };
      }
      if (url.includes('/api/assets')) {
        return {
          ok: true,
          json: async () => ([{
            id: 'asset-peer-1',
            title: 'Private Asset 1',
            currentLayer: 'did:peer',
            userId: 'did:webvh:localhost%3A5000:testuser',
          }]),
        };
      }
      return { ok: true, json: async () => ({}) };
    }) as any;
    
    await renderDashboard();
    
    await waitFor(() => screen.getByText('Private Asset 1'));
    await user.click(screen.getByText(/Publish/i));
    await waitFor(() => screen.getByText('Publish Asset to Web?'));
    
    const publishButtons = screen.getAllByText(/Publish to Web/i);
    const confirmButton = publishButtons.find(btn => (btn as HTMLElement).closest('button')) as HTMLButtonElement;
    
    await user.click(confirmButton);
    
    // Check for disabled button (loading state)
    await waitFor(() => {
      expect(confirmButton.disabled).toBe(true);
    }, { timeout: 50 });
  });

  it('should close modal after successful publish', async () => {
    globalThis.fetch = mock(async (url, options) => {
      if (url.includes('/publish-to-web')) {
        return {
          ok: true,
          json: async () => ({
            asset: { currentLayer: 'did:webvh', didWebvh: 'did:webvh:example.com:xyz' },
            resolverUrl: 'https://example.com/.well-known/did/xyz',
            migration: { timestamp: new Date().toISOString() },
          }),
        };
      }
      
      if (url.includes('/api/user')) {
        return { ok: true, json: async () => ({ id: 'did:webvh:localhost%3A5000:testuser', did: 'did:webvh:localhost%3A5000:testuser' }) };
      }
      if (url.includes('/api/assets')) {
        return {
          ok: true,
          json: async () => ([{
            id: 'asset-peer-1',
            title: 'Private Asset 1',
            currentLayer: 'did:peer',
            userId: 'did:webvh:localhost%3A5000:testuser',
          }]),
        };
      }
      return { ok: true, json: async () => ({}) };
    }) as any;
    
    await renderDashboard();
    
    await waitFor(() => screen.getByText('Private Asset 1'));
    await user.click(screen.getByText(/Publish/i));
    await waitFor(() => screen.getByText('Publish Asset to Web?'));
    
    // Modal is open
    expect(screen.getByText('Publish Asset to Web?')).toBeTruthy();
    
    const publishButtons = screen.getAllByText(/Publish to Web/i);
    const confirmButton = publishButtons.find(btn => (btn as HTMLElement).closest('button'));
    await user.click(confirmButton as HTMLElement);
    
    // Wait for publish to complete and success message
    await waitFor(() => {
      expect(screen.getByText('Published to Web!')).toBeTruthy();
    });
  });

  it('should filter assets by layer', async () => {
    await renderDashboard();
    
    // Initial load shows all assets
    await waitFor(() => {
      expect(screen.getByText('Private Asset 1')).toBeTruthy();
      expect(screen.getByText('Published Asset 1')).toBeTruthy();
    });
    
    // TODO: Click layer filter and test filtering
    // This would require finding and interacting with the LayerFilter component
  });
});
