/** A hung listener is not a stopped process: require an explicit connection refusal. */
export async function assertEndpointStopped(endpoint: string, timeoutMs = 2_000): Promise<void> {
  try {
    await fetch(endpoint, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    // Bun reports the socket code directly; Node's fetch attaches it as the cause.
    const socketError = error as { code?: string; cause?: { code?: string } };
    if (socketError?.code === 'ConnectionRefused' ||
        socketError?.code === 'ECONNREFUSED' || socketError?.cause?.code === 'ECONNREFUSED') return;
    throw error;
  }
  throw new Error(`${endpoint} still accepts connections`);
}
