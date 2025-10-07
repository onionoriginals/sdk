import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Component will be dynamically imported after mocks are set

// Mock wouter
const mockSetLocation = mock(() => {});
mock.module('wouter', () => ({
  useLocation: () => ['/', mockSetLocation],
  useRoute: () => [true, { id: 'test-asset-id' }],
}));

// Mock auth hook
const mockUseAuth = mock(() => ({
  user: {
    id: 'did:webvh:localhost%3A5000:testuser',
    did: 'did:webvh:localhost%3A5000:testuser',
    privyId: 'privy-test-user',
  },
  isAuthenticated: true,
}));

mock.module('@/hooks/useAuth', () => ({
  useAuth: mockUseAuth,
}));

// Mock toast hook
const mockToast = mock(() => {});
mock.module('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

describe('Publish to Web UI', () => {
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
    
    // Default mock: asset in did:peer layer
    globalThis.fetch = mock(async (url) => {
      if (url.includes('/api/assets/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'test-asset-id',
            title: 'Test Asset',
            description: 'Test description',
            currentLayer: 'did:peer',
            didPeer: 'did:peer:abc123',
            userId: 'did:webvh:localhost%3A5000:testuser',
            mediaUrl: 'https://example.com/test.png',
            provenance: {
              creator: 'did:peer:abc123',
              createdAt: new Date().toISOString(),
              migrations: [],
            },
          }),
        };
      }
      return { ok: false, status: 404 };
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const renderAssetDetailPage = async () => {
    // Import the asset detail component
    // Note: This assumes the component exists at this path
    // If it doesn't exist yet, tests will fail (as expected for TDD)
    const { default: AssetDetailPage } = await import('../asset-detail');
    return render(
      <QueryClientProvider client={queryClient}>
        <AssetDetailPage />
      </QueryClientProvider>
    );
  };

  it('should show publish button for did:peer assets', async () => {
    await renderAssetDetailPage();
    
    await waitFor(() => {
      const publishButton = screen.queryByText(/publish to web/i);
      expect(publishButton).toBeTruthy();
    });
  });

  it('should not show publish button for did:webvh assets', async () => {
    globalThis.fetch = mock(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'test-asset-id',
        title: 'Published Asset',
        currentLayer: 'did:webvh',
        didWebvh: 'did:webvh:example.com:xyz',
        didPeer: 'did:peer:abc123',
        userId: 'did:webvh:localhost%3A5000:testuser',
      }),
    })) as any;
    
    await renderAssetDetailPage();
    
    await waitFor(() => {
      const publishButton = screen.queryByText(/publish to web/i);
      expect(publishButton).toBeNull();
    });
  });

  it('should not show publish button for did:btco assets', async () => {
    globalThis.fetch = mock(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'test-asset-id',
        title: 'Bitcoin Asset',
        currentLayer: 'did:btco',
        didBtco: 'did:btco:xyz',
        didWebvh: 'did:webvh:example.com:xyz',
        didPeer: 'did:peer:abc123',
        userId: 'did:webvh:localhost%3A5000:testuser',
      }),
    })) as any;
    
    await renderAssetDetailPage();
    
    await waitFor(() => {
      const publishButton = screen.queryByText(/publish to web/i);
      expect(publishButton).toBeNull();
    });
  });

  it('should show confirmation modal on publish click', async () => {
    await renderAssetDetailPage();
    
    const publishButton = await screen.findByText(/publish to web/i);
    await user.click(publishButton);
    
    await waitFor(() => {
      expect(screen.getByText(/publish asset to web\?/i)).toBeTruthy();
      expect(screen.getByText(/publicly accessible/i)).toBeTruthy();
    });
  });

  it('should allow canceling publish in modal', async () => {
    await renderAssetDetailPage();
    
    const publishButton = await screen.findByText(/publish to web/i);
    await user.click(publishButton);
    
    await waitFor(() => {
      expect(screen.getByText(/publish asset to web\?/i)).toBeTruthy();
    });
    
    const cancelButton = screen.getByRole('button', { name: /cancel/i });
    await user.click(cancelButton);
    
    await waitFor(() => {
      expect(screen.queryByText(/publish asset to web\?/i)).toBeNull();
    });
  });

  it('should call API when publish confirmed', async () => {
    let publishCalled = false;
    globalThis.fetch = mock(async (url, options) => {
      if (url.includes('/publish-to-web') && options?.method === 'POST') {
        publishCalled = true;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            asset: {
              id: 'test-asset-id',
              currentLayer: 'did:webvh',
              didWebvh: 'did:webvh:example.com:xyz',
              didPeer: 'did:peer:abc123',
            },
            resolverUrl: 'https://example.com/.well-known/did/xyz',
          }),
        };
      }
      // Default response for asset fetch
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'test-asset-id',
          title: 'Test Asset',
          currentLayer: 'did:peer',
          didPeer: 'did:peer:abc123',
          userId: 'did:webvh:localhost%3A5000:testuser',
        }),
      };
    }) as any;
    
    await renderAssetDetailPage();
    
    const publishButton = await screen.findByText(/publish to web/i);
    await user.click(publishButton);
    
    // Confirm in modal
    const confirmButton = await screen.findByRole('button', { name: /^publish/i });
    await user.click(confirmButton);
    
    await waitFor(() => {
      expect(publishCalled).toBe(true);
    });
  });

  it('should display success state after publish', async () => {
    globalThis.fetch = mock(async (url, options) => {
      if (url.includes('/publish-to-web')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            asset: {
              id: 'test-asset-id',
              currentLayer: 'did:webvh',
              didWebvh: 'did:webvh:example.com:xyz',
              title: 'Test Asset',
            },
            resolverUrl: 'https://example.com/.well-known/did/xyz',
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'test-asset-id',
          title: 'Test Asset',
          currentLayer: 'did:peer',
          didPeer: 'did:peer:abc123',
        }),
      };
    }) as any;
    
    await renderAssetDetailPage();
    
    const publishButton = await screen.findByText(/publish to web/i);
    await user.click(publishButton);
    
    const confirmButton = await screen.findByRole('button', { name: /^publish/i });
    await user.click(confirmButton);
    
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringMatching(/success|published/i),
        })
      );
    });
  });

  it('should display resolver URL link after publish', async () => {
    globalThis.fetch = mock(async (url, options) => {
      if (url.includes('/publish-to-web')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            asset: {
              id: 'test-asset-id',
              currentLayer: 'did:webvh',
              didWebvh: 'did:webvh:example.com:xyz',
            },
            resolverUrl: 'https://example.com/.well-known/did/xyz',
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'test-asset-id',
          currentLayer: 'did:peer',
          didPeer: 'did:peer:abc123',
        }),
      };
    }) as any;
    
    await renderAssetDetailPage();
    
    const publishButton = await screen.findByText(/publish to web/i);
    await user.click(publishButton);
    
    const confirmButton = await screen.findByRole('button', { name: /^publish/i });
    await user.click(confirmButton);
    
    await waitFor(() => {
      const resolverLink = screen.queryByText(/\.well-known/);
      expect(resolverLink).toBeTruthy();
    });
  });

  it('should handle API errors', async () => {
    globalThis.fetch = mock(async (url, options) => {
      if (url.includes('/publish-to-web')) {
        return {
          ok: false,
          status: 500,
          json: async () => ({
            error: 'Publish failed',
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'test-asset-id',
          currentLayer: 'did:peer',
          didPeer: 'did:peer:abc123',
        }),
      };
    }) as any;
    
    await renderAssetDetailPage();
    
    const publishButton = await screen.findByText(/publish to web/i);
    await user.click(publishButton);
    
    const confirmButton = await screen.findByRole('button', { name: /^publish/i });
    await user.click(confirmButton);
    
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
        // Delay response
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            asset: {
              currentLayer: 'did:webvh',
              didWebvh: 'did:webvh:example.com:xyz',
            },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'test-asset-id',
          currentLayer: 'did:peer',
          didPeer: 'did:peer:abc123',
        }),
      };
    }) as any;
    
    await renderAssetDetailPage();
    
    const publishButton = await screen.findByText(/publish to web/i);
    await user.click(publishButton);
    
    const confirmButton = await screen.findByRole('button', { name: /^publish/i });
    await user.click(confirmButton);
    
    // Check for loading indicator
    await waitFor(() => {
      const loadingIndicator = screen.queryByText(/publishing/i);
      expect(loadingIndicator).toBeTruthy();
    }, { timeout: 50 });
  });

  it('should display did:webvh after successful publish', async () => {
    globalThis.fetch = mock(async (url, options) => {
      if (url.includes('/publish-to-web')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            asset: {
              id: 'test-asset-id',
              currentLayer: 'did:webvh',
              didWebvh: 'did:webvh:example.com:xyz',
              title: 'Test Asset',
            },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'test-asset-id',
          currentLayer: 'did:peer',
          didPeer: 'did:peer:abc123',
        }),
      };
    }) as any;
    
    await renderAssetDetailPage();
    
    const publishButton = await screen.findByText(/publish to web/i);
    await user.click(publishButton);
    
    const confirmButton = await screen.findByRole('button', { name: /^publish/i });
    await user.click(confirmButton);
    
    await waitFor(() => {
      const didWebvhText = screen.queryByText(/did:webvh:example.com:xyz/i);
      expect(didWebvhText).toBeTruthy();
    });
  });

  it('should update layer badge after publish', async () => {
    globalThis.fetch = mock(async (url, options) => {
      if (url.includes('/publish-to-web')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            asset: {
              id: 'test-asset-id',
              currentLayer: 'did:webvh',
              didWebvh: 'did:webvh:example.com:xyz',
            },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'test-asset-id',
          currentLayer: 'did:peer',
          didPeer: 'did:peer:abc123',
        }),
      };
    }) as any;
    
    await renderAssetDetailPage();
    
    // Check initial badge
    await waitFor(() => {
      const badge = screen.queryByTestId('layer-badge');
      expect(badge?.textContent).toMatch(/private|did:peer/i);
    });
    
    const publishButton = await screen.findByText(/publish to web/i);
    await user.click(publishButton);
    
    const confirmButton = await screen.findByRole('button', { name: /^publish/i });
    await user.click(confirmButton);
    
    // Badge should update
    await waitFor(() => {
      const badge = screen.queryByTestId('layer-badge');
      expect(badge?.textContent).toMatch(/published|web|did:webvh/i);
    });
  });

  it('should not show publish button if user does not own asset', async () => {
    globalThis.fetch = mock(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'test-asset-id',
        title: 'Someone else\'s asset',
        currentLayer: 'did:peer',
        didPeer: 'did:peer:abc123',
        userId: 'did:webvh:localhost%3A5000:otheruser', // Different user
      }),
    })) as any;
    
    await renderAssetDetailPage();
    
    await waitFor(() => {
      const publishButton = screen.queryByText(/publish to web/i);
      expect(publishButton).toBeNull();
    });
  });

  it('should handle authorization errors', async () => {
    globalThis.fetch = mock(async (url, options) => {
      if (url.includes('/publish-to-web')) {
        return {
          ok: false,
          status: 403,
          json: async () => ({
            error: 'Not authorized',
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'test-asset-id',
          currentLayer: 'did:peer',
          didPeer: 'did:peer:abc123',
        }),
      };
    }) as any;
    
    await renderAssetDetailPage();
    
    const publishButton = await screen.findByText(/publish to web/i);
    await user.click(publishButton);
    
    const confirmButton = await screen.findByRole('button', { name: /^publish/i });
    await user.click(confirmButton);
    
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: 'destructive',
          description: expect.stringMatching(/authorized|permission/i),
        })
      );
    });
  });

  it('should disable publish button while publishing', async () => {
    globalThis.fetch = mock(async (url, options) => {
      if (url.includes('/publish-to-web')) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            asset: {
              currentLayer: 'did:webvh',
              didWebvh: 'did:webvh:example.com:xyz',
            },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'test-asset-id',
          currentLayer: 'did:peer',
          didPeer: 'did:peer:abc123',
        }),
      };
    }) as any;
    
    await renderAssetDetailPage();
    
    const publishButton = await screen.findByText(/publish to web/i);
    await user.click(publishButton);
    
    const confirmButton = (await screen.findByRole('button', {
      name: /^publish/i,
    })) as HTMLButtonElement;
    
    expect(confirmButton.disabled).toBe(false);
    
    await user.click(confirmButton);
    
    // Button should be disabled while publishing
    await waitFor(() => {
      expect(confirmButton.disabled).toBe(true);
    }, { timeout: 50 });
  });

  it('should show explanation of what publishing means', async () => {
    await renderAssetDetailPage();
    
    const publishButton = await screen.findByText(/publish to web/i);
    await user.click(publishButton);
    
    await waitFor(() => {
      // Should explain what publishing does
      expect(screen.queryByText(/publicly accessible/i)).toBeTruthy();
      expect(screen.queryByText(/resolver/i) || screen.queryByText(/DID/i)).toBeTruthy();
    });
  });
});
