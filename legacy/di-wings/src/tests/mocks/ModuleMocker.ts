import { mock } from 'bun:test'
/**
 * Due to an issue with Bun (https://github.com/oven-sh/bun/issues/7823), we need to manually restore mocked modules
 * after we're done. We do this by setting the mocked value to the original module.
 *
 * When setting up a test that will mock a module, the block should add this:
 * const moduleMocker = new ModuleMocker()
 *
 * afterEach(() => {
 *   moduleMocker.clear()
 * })
 *
 * When a test mocks a module, it should do it this way:
 *
 * await moduleMocker.mock('@/services/token.ts', () => ({
 *   getBucketToken: mock(() => {
 *     throw new Error('Unexpected error')
 *   })
 * }))
 *
 */
export class ModuleMocker {
  private mocks: any[] = []

  async mock(modulePath: string, renderMocks: () => Record<string, any>) {
    let original = {
      ...(await import(modulePath))
    }
    let mocks = renderMocks()
    let result = {
      ...original,
      ...mocks
    }
    mock.module(modulePath, () => result)

    this.mocks.push({
      clear: () => {
        mock.module(modulePath, () => original)
      }
    })
  }

  clear() {
    this.mocks.forEach(mockResult => mockResult.clear())
    this.mocks = []
  }
}