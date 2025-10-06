import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Component will be dynamically imported after mocks are set

// Mock wouter
const mockSetLocation = mock(() => {});
mock.module('wouter', () => ({
  useLocation: () => ['/', mockSetLocation],
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

// Mock localStorage for asset types
const mockLocalStorage = (() => {
  let store: Record<string, string> = {};
  
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    clear: () => {
      store = {};
    },
  };
})();

Object.defineProperty(globalThis, 'localStorage', {
  value: mockLocalStorage,
});

describe('CreateAssetSimple', () => {
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
    
    // Setup localStorage with a test asset type
    mockLocalStorage.setItem(
      'originals-asset-types',
      JSON.stringify([
        {
          id: 'test-type-1',
          name: 'Test Asset Type',
          description: 'A test asset type',
          properties: [
            {
              id: 'prop-1',
              key: 'customField',
              label: 'Custom Field',
              type: 'text',
              required: false,
            },
          ],
        },
      ])
    );
    
    // Reset mocks
    mockSetLocation.mockClear();
    mockToast.mockClear();
  });

  afterEach(() => {
    // Restore fetch between tests
    globalThis.fetch = originalFetch;
  });

  const renderComponent = async () => {
    const { default: CreateAssetSimple } = await import('../create-asset-simple');
    return render(
      <QueryClientProvider client={queryClient}>
        <CreateAssetSimple />
      </QueryClientProvider>
    );
  };

  it('should render form fields', () => {
    renderComponent();

    // Check for form fields
    expect(screen.getByText(/Asset Type/i)).toBeTruthy();
    expect(screen.getByText(/Title/i)).toBeTruthy();
    expect(screen.getByText(/Description/i)).toBeTruthy();
    expect(screen.getByText(/Category/i)).toBeTruthy();
    expect(screen.getByText(/Tags/i)).toBeTruthy();
    expect(screen.getByText(/Media File/i)).toBeTruthy();
  });

  it('should render asset type selector', () => {
    renderComponent();

    const assetTypeSelect = screen.getByTestId('asset-type-select');
    expect(assetTypeSelect).toBeTruthy();
  });

  it('should show file upload area', () => {
    renderComponent();

    const uploadInput = screen.getByTestId('media-upload-input');
    expect(uploadInput).toBeTruthy();
    expect(uploadInput.getAttribute('type')).toBe('file');
  });

  it('should display custom properties when asset type is selected', async () => {
    await renderComponent();

    const assetTypeSelect = screen.getByTestId('asset-type-select');
    
    // Click to open select
    await user.click(assetTypeSelect);
    
    // Select the test asset type
    const option = screen.getByText('Test Asset Type');
    await user.click(option);

    // Wait for custom property to appear
    await waitFor(() => {
      expect(screen.getByText(/Custom Field/i)).toBeTruthy();
    });
  });

  it('should validate required fields on submit', async () => {
    await renderComponent();

    const submitButton = screen.getByTestId('create-asset-button');
    await user.click(submitButton);

    // Should show validation errors
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalled();
    });
  });

  it('should handle file selection', async () => {
    renderComponent();

    const file = new File(['test content'], 'test.png', { type: 'image/png' });
    const input = screen.getByTestId('media-upload-input') as HTMLInputElement;

    await user.upload(input, file);

    await waitFor(() => {
      expect(input.files?.[0]).toBe(file);
      expect(input.files?.[0].name).toBe('test.png');
    });
  });

  it('should submit form with valid data', async () => {
    // Mock successful API response
    global.fetch = mock(async () => ({
      ok: true,
      status: 201,
      json: async () => ({
        asset: {
          id: 'orig_test_123',
          title: 'Test Asset',
          didPeer: 'did:peer:abc123',
          currentLayer: 'did:peer',
          didDocument: {},
          credentials: [],
          provenance: {
            creator: 'did:peer:abc123',
            createdAt: new Date().toISOString(),
            migrations: [],
          },
        },
        originalsAsset: {
          did: 'did:peer:abc123',
          resources: [],
        },
      }),
    })) as any;

    renderComponent();

    // Select asset type
    const assetTypeSelect = screen.getByTestId('asset-type-select');
    await user.click(assetTypeSelect);
    const typeOption = screen.getByText('Test Asset Type');
    await user.click(typeOption);

    // Fill in title
    const titleInput = screen.getByTestId('asset-title-input');
    await user.type(titleInput, 'Test Asset');

    // Fill in description
    const descriptionInput = screen.getByTestId('asset-description-input');
    await user.type(descriptionInput, 'Test description');

    // Select category
    const categorySelect = screen.getByTestId('category-select');
    await user.click(categorySelect);
    const categoryOption = screen.getByText('Art');
    await user.click(categoryOption);

    // Add file
    const file = new File(['test'], 'test.png', { type: 'image/png' });
    const fileInput = screen.getByTestId('media-upload-input');
    await user.upload(fileInput, file);

    // Submit form
    const submitButton = screen.getByTestId('create-asset-button');
    await user.click(submitButton);

    // Wait for success
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Success',
          description: 'Asset created successfully',
        })
      );
    });

    // Should redirect to dashboard
    expect(mockSetLocation).toHaveBeenCalledWith('/dashboard');
  });

  it('should display error when API fails', async () => {
    // Mock API error
    global.fetch = mock(async () => ({
      ok: false,
      status: 500,
      json: async () => ({
        error: 'Creation failed',
      }),
    })) as any;

    renderComponent();

    // Fill form and submit
    const assetTypeSelect = screen.getByTestId('asset-type-select');
    await user.click(assetTypeSelect);
    const typeOption = screen.getByText('Test Asset Type');
    await user.click(typeOption);

    const titleInput = screen.getByTestId('asset-title-input');
    await user.type(titleInput, 'Test Asset');

    const categorySelect = screen.getByTestId('category-select');
    await user.click(categorySelect);
    const categoryOption = screen.getByText('Art');
    await user.click(categoryOption);

    const file = new File(['test'], 'test.png', { type: 'image/png' });
    const fileInput = screen.getByTestId('media-upload-input');
    await user.upload(fileInput, file);

    const submitButton = screen.getByTestId('create-asset-button');
    await user.click(submitButton);

    // Wait for error toast
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Error',
          variant: 'destructive',
        })
      );
    });
  });

  it('should disable submit button while uploading', async () => {
    renderComponent();

    const submitButton = screen.getByTestId('create-asset-button') as HTMLButtonElement;
    
    // Initially enabled
    expect(submitButton.disabled).toBe(false);

    // Mock slow API call
    global.fetch = mock(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                ok: true,
                status: 201,
                json: async () => ({
                  asset: {
                    id: 'test',
                    didPeer: 'did:peer:test',
                    currentLayer: 'did:peer',
                    didDocument: {},
                    credentials: [],
                    provenance: {},
                  },
                }),
              } as any),
            100
          );
        })
    ) as any;

    // Fill and submit form
    const assetTypeSelect = screen.getByTestId('asset-type-select');
    await user.click(assetTypeSelect);
    await user.click(screen.getByText('Test Asset Type'));

    await user.type(screen.getByTestId('asset-title-input'), 'Test');
    
    const categorySelect = screen.getByTestId('category-select');
    await user.click(categorySelect);
    await user.click(screen.getByText('Art'));

    const file = new File(['test'], 'test.png', { type: 'image/png' });
    await user.upload(screen.getByTestId('media-upload-input'), file);

    await user.click(submitButton);

    // Button should be disabled while submitting
    await waitFor(() => {
      expect(submitButton.disabled).toBe(true);
    });
  });

  it('should parse tags from comma-separated string', async () => {
    global.fetch = mock(async () => ({
      ok: true,
      status: 201,
      json: async () => ({
        asset: {
          id: 'test',
          didPeer: 'did:peer:test',
          currentLayer: 'did:peer',
          tags: ['tag1', 'tag2', 'tag3'],
          didDocument: {},
          credentials: [],
          provenance: {},
        },
      }),
    })) as any;

    renderComponent();

    // Fill form
    const assetTypeSelect = screen.getByTestId('asset-type-select');
    await user.click(assetTypeSelect);
    await user.click(screen.getByText('Test Asset Type'));

    await user.type(screen.getByTestId('asset-title-input'), 'Tagged Asset');
    
    const categorySelect = screen.getByTestId('category-select');
    await user.click(categorySelect);
    await user.click(screen.getByText('Art'));

    // Add tags
    const tagsInput = screen.getByTestId('tags-input');
    await user.type(tagsInput, 'tag1, tag2, tag3');

    const file = new File(['test'], 'test.png', { type: 'image/png' });
    await user.upload(screen.getByTestId('media-upload-input'), file);

    await user.click(screen.getByTestId('create-asset-button'));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Success',
        })
      );
    });
  });

  it('should show authentication required message when not authenticated', () => {
    // Mock unauthenticated user
    mockUseAuth.mockReturnValueOnce({
      user: null,
      isAuthenticated: false,
    });

    renderComponent();

    expect(screen.getByText(/Authentication Required/i)).toBeTruthy();
    expect(screen.getByText(/Please sign in to create assets/i)).toBeTruthy();
  });

  it('should navigate back to dashboard on back button click', async () => {
    renderComponent();

    const backButton = screen.getByTestId('back-to-dashboard');
    await user.click(backButton);

    expect(mockSetLocation).toHaveBeenCalledWith('/');
  });

  it('should accept multiple file types', () => {
    renderComponent();

    const fileInput = screen.getByTestId('media-upload-input');
    const acceptAttr = fileInput.getAttribute('accept');
    
    expect(acceptAttr).toContain('image/*');
    expect(acceptAttr).toContain('video/*');
    expect(acceptAttr).toContain('audio/*');
  });

  it('should include custom properties in asset data', async () => {
    let capturedRequestBody: any;
    
    global.fetch = mock(async (url, options) => {
      if (options?.body) {
        capturedRequestBody = JSON.parse(options.body as string);
      }
      return {
        ok: true,
        status: 201,
        json: async () => ({
          asset: {
            id: 'test',
            didPeer: 'did:peer:test',
            currentLayer: 'did:peer',
            didDocument: {},
            credentials: [],
            provenance: {},
          },
        }),
      };
    }) as any;

    renderComponent();

    // Select asset type
    const assetTypeSelect = screen.getByTestId('asset-type-select');
    await user.click(assetTypeSelect);
    await user.click(screen.getByText('Test Asset Type'));

    // Wait for custom field to appear
    await waitFor(() => {
      expect(screen.getByText(/Custom Field/i)).toBeTruthy();
    });

    // Fill custom field
    const customFieldInput = screen.getByPlaceholderText('Custom Field');
    await user.type(customFieldInput, 'Custom Value');

    // Fill other required fields
    await user.type(screen.getByTestId('asset-title-input'), 'Test');
    
    const categorySelect = screen.getByTestId('category-select');
    await user.click(categorySelect);
    await user.click(screen.getByText('Art'));

    const file = new File(['test'], 'test.png', { type: 'image/png' });
    await user.upload(screen.getByTestId('media-upload-input'), file);

    await user.click(screen.getByTestId('create-asset-button'));

    await waitFor(() => {
      expect(capturedRequestBody?.metadata?.customProperties).toBeDefined();
      expect(capturedRequestBody?.metadata?.customProperties?.customField).toBe('Custom Value');
    });
  });
});
