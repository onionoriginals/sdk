export interface WalletInfo {
  walletAddress: string;
  walletType: string;
}

// Mock wallet connection for MVP
export const connectWallet = async (): Promise<WalletInfo | null> => {
  // Simulate wallet connection delay
  await new Promise(resolve => setTimeout(resolve, 1500));
  
  // Check if we're in a real Bitcoin wallet environment
  if (typeof window !== 'undefined') {
    // Try UniSat
    if ((window as any).unisat) {
      try {
        const accounts = await (window as any).unisat.requestAccounts();
        if (accounts.length > 0) {
          return {
            walletAddress: accounts[0],
            walletType: "unisat",
          };
        }
      } catch (error) {
        console.warn("UniSat wallet connection failed:", error);
      }
    }

    // Try Xverse
    if ((window as any).XverseProviders) {
      try {
        const getAddressOptions = {
          payload: {
            purposes: ['ordinals', 'payment'],
            message: 'Address for creating and migrating Originals',
            network: {
              type: 'Mainnet'
            }
          },
          onFinish: (response: any) => {
            return {
              walletAddress: response.addresses[0].address,
              walletType: "xverse",
            };
          },
          onCancel: () => {
            throw new Error("User cancelled wallet connection");
          }
        };
        
        await (window as any).XverseProviders.getAddress(getAddressOptions);
      } catch (error) {
        console.warn("Xverse wallet connection failed:", error);
      }
    }
  }

  // Mock successful connection for development
  const mockAddress = `bc1q${Math.random().toString(36).substring(2, 15)}${Math.random().toString(36).substring(2, 15)}`;
  return {
    walletAddress: mockAddress,
    walletType: "mock",
  };
};

export const getWalletInfo = async (): Promise<WalletInfo | null> => {
  if (typeof window === 'undefined') return null;

  // Check for existing connections
  if ((window as any).unisat) {
    try {
      const accounts = await (window as any).unisat.getAccounts();
      if (accounts.length > 0) {
        return {
          walletAddress: accounts[0],
          walletType: "unisat",
        };
      }
    } catch (error) {
      console.warn("Failed to get UniSat account info:", error);
    }
  }

  return null;
};
